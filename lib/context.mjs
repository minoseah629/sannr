// sannr.json — generation, freshness, and consumption.
//
// The file is what a ten-year engineer knows about an API, in a form a coding
// agent can load: which operations exist, what they actually return, which ones
// misbehave, and how much to trust each claim.
//
// Three deliberate properties:
//
//   1. Everything written here passes the promotion boundary (lib/promote.mjs).
//      Structure always; values only where the contract already declared them.
//   2. Every claim carries its own expiry — source_file, verified_at, and the
//      contract digest — so staleness is one `git log` away rather than a
//      judgement call.
//   3. The index is small and the detail is deep. An agent loads the index at
//      session start and pulls one operation's detail when it touches it.
//      Front-loading a thousand operations recreates the problem the response
//      budget exists to solve.

import {
  chmodSync, closeSync, existsSync, openSync, readFileSync, readdirSync, renameSync,
  statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { promoteObservation } from "./promote.mjs";
import { readConfigDefaults } from "./config.mjs";
import { contextFileFor, activeStackScopeFor } from "./stack-scope.mjs";
import { assertWritableStack } from "./stacks.mjs";
import { LAYOUT, ensureLayout } from "./layout.mjs";
import { safeOutputPath } from "./output-path.mjs";
import { terminalText } from "./terminal.mjs";
import { secretIn, redactMetadataSecrets } from "./verdicts.mjs";
import {
  inspectNoteHistory, isValidSupersessionMarker, assertWritableNoteHistory,
  baselineNoteHistory, protectContextNoteHistory, noteHistoryError, noteIdentity,
  safeNoteAuthor, validNoteDate, sealNoteMutation, validAuthoredNoteStamp,
} from "./note-history.mjs";
import { normalizeNoteKey, normalizeNoteOperations, getNoteEntry, setNoteEntry, noteKeyLabel } from "./note-key.mjs";
import { applyNoteReviews, assertReviewOverturn, retirementNote, noteRetirement, staleNoteError, reviewError, validateReviewActor } from './note-reviews.mjs';
export { inspectNoteHistory, isValidSupersessionMarker, noteIdentity, baselineNoteHistory } from "./note-history.mjs";

export const CONTEXT_VERSION = 0;
export const MAX_CONTEXT_BYTES = 16 * 1024 * 1024;
// Derived from the product name (lib/brand.mjs), never spelled out here: this
// filename is committed into a user's repo and named in every help string, so
// it is the one a rename must not miss.
export const CONTEXT_FILE = LAYOUT.context;

const sha = (s) => `sha256:${createHash("sha256").update(s).digest("hex").slice(0, 16)}`;

// --- contract reading ------------------------------------------------------
// A YAML dependency is still not worth taking, but the disagreement checks in
// lib/checks.mjs need what is INSIDE an operation — response schemas, parameter
// required-flags, declared status codes — not just the path list the original
// line-scan produced. So this parses the YAML subset OpenAPI documents actually
// use (block maps and sequences, flow {}/[] collections, quoted scalars, > and
// | blocks) and falls back to the path-only scan when a document defeats it.
// A failed parse must cost a feature, never a crash.

function parseYamlish(text) {
  // The original path/method line-scan, kept as the fallback: it cannot see
  // schemas, but it has never met a document it could not inventory.
  const paths = {};
  const lines = text.split("\n");
  let current = null;
  for (const line of lines) {
    const p = /^ {2}(\/[^\s:]*):\s*$/.exec(line);
    if (p) { current = p[1]; paths[current] = {}; continue; }
    if (!current) continue;
    const m = /^ {4}(get|post|put|patch|delete|head|options):\s*$/.exec(line);
    if (m) paths[current][m[1]] = {};
    else if (/^ {0,3}\S/.test(line) && !/^ {2}\//.test(line)) current = null;
  }
  return { paths };
}

// Convert one unquoted scalar token. No flow recursion here — the flow parser
// calls this for its leaves.
function yamlAtom(s) {
  if (s === "" || s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  return s;
}

function yamlSet(object, key, value) {
  if (key === "__proto__" || key === "constructor" || key === "prototype")
    Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
  else object[key] = value;
}

function yamlExpansionSize(value, state, depth) {
  // Aliases share references, but consumers may expand those references. Count
  // occurrences, not unique objects, and stop DURING traversal at either bound.
  // Recursive counting first and checking later can overflow before the guard.
  const stack = [{ value, depth }];
  let size = 0;
  while (stack.length) {
    const item = stack.pop();
    size += 1;
    if (size + state.materialized > state.max)
      throw Object.assign(new Error("YAML document aliases: expansion exceeds 100000 nodes"), { code: "YAML_ALIAS_EXPANSION_EXCEEDED" });
    if (!item.value || typeof item.value !== "object") continue;
    if (state.strictDepth && item.depth + 1 > state.maxDepth)
      throw Object.assign(new Error(`YAML document aliases: nesting exceeds depth ${state.maxDepth}`), { code: "YAML_DEPTH_EXCEEDED" });
    const children = Object.values(item.value);
    // The pending occurrences alone already exceed the remaining allowance.
    if (size + stack.length + children.length + state.materialized > state.max)
      throw Object.assign(new Error("YAML document aliases: expansion exceeds 100000 nodes"), { code: "YAML_ALIAS_EXPANSION_EXCEEDED" });
    for (const child of children) stack.push({ value: child, depth: item.depth + 1 });
  }
  return size;
}

// A quoted string starting at pos (s[pos] is the quote). Double quotes take
// backslash escapes; single quotes double themselves. indexOf is NOT enough:
// the field failure included \" inside descriptions, which truncated the
// string at the escape and broke everything after it.
function quotedString(s, pos) {
  const q = s[pos];
  let end = pos + 1;
  while (end < s.length) {
    if (q === '"' && s[end] === "\\") { end += 2; continue; }
    if (s[end] === q) {
      if (q === "'" && s[end + 1] === "'") { end += 2; continue; }   // '' escape
      break;
    }
    end += 1;
  }
  const raw = s.slice(pos + 1, Math.min(end, s.length));
  const value = q === '"'
    ? raw.replace(/\\(.)/g, (_, c) => ({ n: "\n", t: "\t", r: "\r" }[c] ?? c))
    : raw.replace(/''/g, "'");
  return { value, pos: Math.min(end, s.length) + 1 };
}

// Flow collections: { type: integer, default: 10 } and [a, "b"], possibly
// spanning lines — the block parser joins continuation lines with \n before
// calling here, so whitespace-skipping treats newlines as spaces and a #
// starts a comment that runs to the end of its line. Recursive descent;
// returns { value, pos }.
function yamlFlow(s, pos = 0, anchors = new Map(), depth = 0, state = null) {
  const ws = () => {
    for (;;) {
      while (pos < s.length && /\s/.test(s[pos])) pos += 1;
      if (s[pos] === "#") { while (pos < s.length && s[pos] !== "\n") pos += 1; continue; }
      return;
    }
  };
  ws();
  const isContainer = s[pos] === "{" || s[pos] === "[";
  // Anchor/tag prefixes recurse even when their eventual value is scalar.
  // Bound that descent too, before a malformed prefix chain reaches the stack.
  if (state?.maxDepth !== undefined && (depth > state.maxDepth || (isContainer && depth + 1 > state.maxDepth))) {
    if (state.strictDepth)
      throw Object.assign(new Error(`YAML nesting exceeds depth ${state.maxDepth}`), { code: "YAML_DEPTH_EXCEEDED" });
    return { value: null, pos: s.length };
  }
  let c = s[pos];
  if (c === "!") {
    const end = s.slice(pos).search(/\s/);
    const tokenEnd = end < 0 ? s.length : pos + end;
    const tag = s.slice(pos, tokenEnd);
    if (!/^!!(?:str|int|bool|null)$|^!<tag:yaml.org,2002:(?:str|int|bool|null)>$/i.test(tag))
      throw Object.assign(new Error("YAML document flow value: tag is not supported"), { code: "YAML_UNKNOWN_TAG" });
    const r = yamlFlow(s, tokenEnd, anchors, depth + 1, state);
    return { value: yamlScalar(`${tag} ${JSON.stringify(r.value)}`, anchors, state, depth), pos: r.pos };
  }
  // &anchor / *alias are legal on any flow node; aliases resolve to whatever
  // the anchor captured (a shared reference is fine — everything downstream
  // treats documents as read-only).
  if (c === "&" || c === "*") {
    let end = pos + 1;
    while (end < s.length && !/[\s,{}[\]]/.test(s[end])) end += 1;
    const name = s.slice(pos + 1, end);
    if (c === "*") {
      const value = anchors.get(name) ?? null;
      if (state) {
        state.materialized += yamlExpansionSize(value, state, depth);
        if (state.materialized > state.max)
          throw Object.assign(new Error("YAML alias expansion exceeds 100000 nodes"), { code: "YAML_ALIAS_EXPANSION_EXCEEDED" });
      }
      return { value, pos: end };
    }
    pos = end; ws();
    const r = yamlFlow(s, pos, anchors, depth + 1, state);
    anchors.set(name, r.value);
    return r;
  }
  c = s[pos];
  if (c === "{" || c === "[") {
    const isMap = c === "{";
    const close = isMap ? "}" : "]";
    const out = isMap ? {} : [];
    pos += 1; ws();
    if (s[pos] === close) return { value: out, pos: pos + 1 };
    while (pos < s.length) {
      ws();
      if (isMap) {
        let key;
        if (s[pos] === '"' || s[pos] === "'") {
          const r = quotedString(s, pos);
          key = r.value; pos = r.pos; ws();
        } else {
          const end = s.indexOf(":", pos);
          if (end === -1) break;
          key = s.slice(pos, end).trim(); pos = end;
        }
        if (s[pos] === ":") pos += 1;
        const r = yamlFlow(s, pos, anchors, depth + 1, state);
        if (key === "<<" && r.value && typeof r.value === "object")
          for (const [mk, mv] of Object.entries(r.value)) { if (!(mk in out)) yamlSet(out, mk, mv); }
        else yamlSet(out, key, r.value);
        pos = r.pos;
      } else {
        const r = yamlFlow(s, pos, anchors, depth + 1, state); out.push(r.value); pos = r.pos;
      }
      ws();
      if (s[pos] === ",") { pos += 1; continue; }
      if (s[pos] === close) return { value: out, pos: pos + 1 };
      break;
    }
    return { value: out, pos };
  }
  if (c === '"' || c === "'") return quotedString(s, pos);
  let end = pos;
  while (end < s.length && !",}]\n".includes(s[end])) end += 1;
  return { value: yamlAtom(s.slice(pos, end).trim()), pos: end };
}

// Net flow-bracket depth of ONE line, quote- and comment-aware, carrying
// state across lines: a quoted string may span the joining newline, so the
// caller threads the previous line's { depth, quote } back in. This is what
// makes the continuation join linear — each absorbed line is scanned exactly
// once. The earlier version rescanned the whole joined text per line,
// quadratic at pathological sizes (F2 adversarial pass: 40k continuation
// lines took ~16s — a slow-parse DoS in a document we merely opened).
function flowScan(s, st = { depth: 0, quote: null }) {
  let { depth, quote } = st;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (quote === '"' && ch === "\\") i += 1;
      else if (ch === quote) { if (quote === "'" && s[i + 1] === "'") i += 1; else quote = null; }
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") break;                        // comment runs to end of THIS line
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
  }
  return { depth, quote };
}

function yamlScalar(s, anchors = new Map(), state = null, depth = 0) {
  s = s.trim();
  const tag = /^(!!(?:str|int|bool|null)|!<tag:yaml.org,2002:(?:str|int|bool|null)>)\s+(.+)$/i.exec(s);
  if (s.startsWith("!") && !tag) throw Object.assign(new Error("YAML document scalar value: tag is not supported"), { code: "YAML_UNKNOWN_TAG" });
  if (tag) {
    const kind = tag[1].toLowerCase().replace(/^!!/, "").replace(/^!<tag:yaml.org,2002:/, "").replace(/>$/, "");
    const raw = tag[2].trim().replace(/\s+#.*$/, "").replace(/^['"]|['"]$/g, "");
    if (kind === "str") return raw;
    if (kind === "int" && /^[-+]?\d+$/.test(raw)) return Number(raw);
    if (kind === "bool" && /^(true|false)$/i.test(raw)) return raw.toLowerCase() === "true";
    if (kind === "null" && /^(null|~)$/i.test(raw)) return null;
    throw Object.assign(new Error(`invalid YAML !!${kind} value`), { code: "YAML_TAG_INVALID" });
  }
  if (s.startsWith("{") || s.startsWith("[")) return yamlFlow(s, 0, anchors, depth, state).value;
  if (s.startsWith('"') || s.startsWith("'")) return quotedString(s, 0).value;
  const al = /^\*(\S+)$/.exec(s);
  if (al) {
    const value = anchors.get(al[1]);
    if (state) {
      state.materialized += yamlExpansionSize(value, state, depth);
      if (state.materialized > state.max)
        throw Object.assign(new Error("YAML alias expansion exceeds 100000 nodes"), { code: "YAML_ALIAS_EXPANSION_EXCEEDED" });
    }
    return value ?? null;
  }
  // Inline comments only exist outside quotes; "the # of seats" mid-string is a
  // loss this subset accepts.
  const hash = s.search(/\s#/);
  if (hash !== -1) s = s.slice(0, hash).trim();
  return yamlAtom(s);
}

// A map key: quoted ("200":), or plain up to the first colon followed by a
// space or end of line — the trailing distinction matters because values like
// `url: http://x:9102` carry colons of their own.
function yamlKey(t) {
  let m = /^"((?:[^"\\]|\\.)*)"\s*:\s*(.*)$/.exec(t);
  if (m) return { key: m[1], rest: m[2].trim() };
  m = /^'([^']*)'\s*:\s*(.*)$/.exec(t);
  if (m) return { key: m[1], rest: m[2].trim() };
  m = /^([^\s:'"{[][^:]*?):(?:\s+(.*))?$/.exec(t);
  if (m) return { key: m[1].trim(), rest: (m[2] ?? "").trim() };
  return null;
}

// What parseYamlDocument had to skip, per returned document (see below).
const YAML_PROBLEMS = new WeakMap();

export function parseYamlDocument(text, { maxDepth = 128, strictDepth = false } = {}) {
  const src = [];
  let openQuote = null;
  const scanQuote = (line) => {
    for (let n = 0; n < line.length; n += 1) {
      const ch = line[n];
      if (openQuote) {
        if (openQuote === '"' && ch === "\\") { n += 1; continue; }
        if (ch === openQuote) {
          if (openQuote === "'" && line[n + 1] === "'") { n += 1; continue; }
          openQuote = null;
        }
      } else if (ch === '"' || ch === "'") openQuote = ch;
    }
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\t/g, "  ").replace(/\r$/, "");
    const t = line.trim();
    if (!openQuote && /^(---|\.\.\.)(?:\s|$)/.test(line)) {
      // A spec is one document. The first --- is a preamble; a SECOND one
      // starts a document we must not merge into the first (merging turned
      // "two documents" into "one document with the union of their paths").
      if (src.length) break;
      continue;
    }
    if (!t || t.startsWith("#")) continue;
    src.push(line);
    scanQuote(line);
  }
  if (!src.length) return null;

  // The subset parser is lenient on purpose (a failed parse must cost a
  // feature, never a crash), so it records what it had to skip instead of
  // failing: a character YAML does not allow, a line at a mapping's
  // indentation that is not a key, a quoted scalar or flow collection still
  // open at the end, a top level that is not a mapping. The list is kept
  // beside the result, never on it, so no document key is shadowed;
  // readContract reports it, and a caller decides what an unparsed document
  // means (the API map calls a contract with problems and no operations
  // unreadable).
  const problems = [];
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u0084\u0086-\u009f\ufffe\uffff]/u.test(text)) problems.push("not-printable");
  const withProblems = (value) => {
    if (value && typeof value === "object") YAML_PROBLEMS.set(value, problems);
    return value;
  };

  // JSON is valid YAML flow, and people rename files. A document whose first
  // significant character opens a flow collection is ONE flow value; the
  // line-oriented block machinery below would see "{" as a failed key and
  // silently return an empty map.
  if (/^[{[]/.test(src[0].trim())) {
    let st = { depth: 0, quote: null };
    for (const line of src) st = flowScan(line, st);
    if (st.depth !== 0 || st.quote) problems.push("flow-unclosed");
    const value = yamlFlow(src.join("\n"), 0, new Map(), 0, { materialized: 0, max: 100_000, maxDepth, strictDepth }).value;
    if (Array.isArray(value)) problems.push("not-a-mapping");
    return withProblems(value);
  }

  let i = 0;
  const indentOf = (l) => l.length - l.trimStart().length;
  const anchors = new Map();          // &name — document-scoped, aliases and << resolve here
  const warnings = [];
  const state = { materialized: 0, max: 100_000, maxDepth, strictDepth };

  // WHY a depth cap: block()/map()/seq() recurse once per nesting level, and a
  // hostile document is one loop away from 20k levels — a RangeError deep in
  // the parse that only readContract's catch contained (and the catch voided
  // the WHOLE parse, costing schemas the line-scan fallback cannot see). Same
  // posture as deref's guard and shapeOf's cap: past the limit the subtree is
  // summarised ("…", shapeOf's spelling), its lines consumed so the parse
  // position stays sane, and the shallow document still answers. 128 is an
  // order of magnitude past the deepest nesting a real spec exhibits.
  const BLOCK_MAX_DEPTH = maxDepth;

  function block(minIndent, depth = 0) {
    if (i >= src.length) return null;
    const ind = indentOf(src[i]);
    if (ind < minIndent) return null;
    if (depth >= BLOCK_MAX_DEPTH) {
      if (strictDepth)
        throw Object.assign(new Error(`YAML nesting exceeds depth ${BLOCK_MAX_DEPTH}`), { code: "YAML_DEPTH_EXCEEDED" });
      while (i < src.length && indentOf(src[i]) >= minIndent) i += 1;
      return "…";
    }
    return src[i].trim().startsWith("-") && /^-(\s|$)/.test(src[i].trim()) ? seq(ind, depth + 1) : map(ind, depth + 1);
  }

  function blockScalar(marker, ind) {
    const parts = [];
    const style = marker[0];
    const chomp = marker.includes("-") ? "-" : marker.includes("+") ? "+" : "";
    const explicit = /\d/.exec(marker)?.[0];
    const required = explicit ? ind + Number(explicit) : null;
    while (i < src.length && indentOf(src[i]) > ind) {
      const lineIndent = indentOf(src[i]);
      if (required !== null && lineIndent < required) break;
      parts.push(src[i].slice(required ?? Math.min(lineIndent, ind + 2)));
      i += 1;
    }
    let value = parts.join(style === "|" ? "\n" : " ");
    if (chomp !== "-") value += "\n";
    if (chomp === "+") value += "\n";
    return value;
  }

  // A value that OPENS a flow collection may span lines (the field failure:
  // "paths: {" then one line per route). Absorb continuation lines until the
  // brackets balance; yamlFlow treats the joining newlines as whitespace.
  // The bracket scan is incremental (see flowScan) so the join is linear, and
  // the join itself is capped: a bracket that never closes would otherwise
  // absorb the whole file, and past the cap we parse what we have — the
  // truncated value loses paths, which readContract's earn-its-answer check
  // turns into the line-scan fallback. Bounded work, never a hang.
  const FLOW_JOIN_MAX_CHARS = 4_000_000;
  function flowValue(rest, anchorName, depth = 0) {
    const parts = [rest];
    let st = flowScan(rest);
    let size = rest.length;
    while (st.depth > 0 && i < src.length && size < FLOW_JOIN_MAX_CHARS) {
      st = flowScan(src[i], st);
      size += src[i].length + 1;                       // +1 for the joining \n
      parts.push(src[i]); i += 1;
    }
    if (st.depth !== 0 || st.quote) problems.push("flow-unclosed");
    const v = yamlFlow(parts.join("\n"), 0, anchors, depth, state).value;
    if (anchorName) anchors.set(anchorName, v);
    return v;
  }

  // "key: &name …" anchors whatever value follows, inline or nested block.
  const takeAnchor = (rest) => {
    const a = /^&(\S+)\s*(.*)$/.exec(rest);
    return a ? { name: a[1], rest: a[2].trim() } : { name: null, rest };
  };

  // A quoted scalar may span lines. The continuation join below feeds each
  // absorbed line to this scanner exactly once, carrying the escape state
  // across the joining newline — re-scanning the whole accumulation per line
  // was quadratic: an unterminated quote over 60k lines took minutes.
  const quoteScanner = (value) => {
    const q = value[0];
    if (q !== '"' && q !== "'") return null;
    const st = { complete: false, escaped: false };
    const feed = (chunk, from) => {
      for (let n = from; n < chunk.length && !st.complete; n += 1) {
        if (st.escaped) { st.escaped = false; continue; }
        if (q === '"' && chunk[n] === "\\") { st.escaped = true; continue; }
        if (chunk[n] === q) {
          if (q === "'" && chunk[n + 1] === "'") { n += 1; continue; }
          st.complete = true;
        }
      }
    };
    feed(value, 1);
    return { get complete() { return st.complete; }, feed: (chunk) => feed(chunk, 0) };
  };

  function assign(out, key, value) {
    if (key !== null && typeof key === "object")
      throw Object.assign(new Error("YAML document mapping key: expected a scalar key"), { code: "YAML_KEY_INVALID" });
    // The YAML merge key: explicit keys win over merged ones regardless of
    // where << sits in the map, so merge fills gaps and never overwrites.
    if (key === "<<" && value && typeof value === "object")
      for (const [mk, mv] of Object.entries(Array.isArray(value) ? Object.assign({}, ...value.slice().reverse()) : value)) {
        if (!(mk in out)) yamlSet(out, mk, mv);
      }
    else yamlSet(out, key, value);
  }

  function map(ind, depth = 0) {
    const out = {};
    while (i < src.length) {
      const li = indentOf(src[i]);
      if (li < ind) break;
      if (li > ind) { i += 1; continue; }              // stray deeper line; be lenient
      const t = src[i].trim();
      if (/^-(\s|$)/.test(t)) break;                   // a sequence took over at this level
      // The explicit form ("? key" then ": value") — emitters switch to it for
      // keys past 128 chars, and Twilio's longest route arrives this way.
      // Rewriting the ": value" line at the child indent lets the ordinary
      // machinery own the value block.
      if (/^\?\s/.test(t)) {
        const key = yamlScalar(t.slice(1).trim(), anchors, state);
        i += 1;
        let v = null;
        if (i < src.length && indentOf(src[i]) === ind && /^:(\s|$)/.test(src[i].trim())) {
          const rest = src[i].trim().slice(1).trim();
          if (rest === "") { i += 1; v = (i < src.length && indentOf(src[i]) > ind) ? block(ind + 1, depth) : null; }
          else if (yamlKey(rest)) { src[i] = " ".repeat(ind + 2) + rest; v = block(ind + 1, depth); }
          else { i += 1; v = yamlScalar(rest, anchors, state, depth); }
        }
        assign(out, key, v);
        continue;
      }
      const m = yamlKey(t);
      if (!m) { problems.push("line-not-a-key"); i += 1; continue; }
      i += 1;
      const { name, rest } = takeAnchor(m.rest);
      let v;
      if (rest === "") {
        // A block sequence may sit at the SAME indent as its key ("servers:"
        // then "- url:" in the same column) — legal YAML that real specs emit
        // (Twilio v2010). Treating the dash as a foreign sequence broke out of
        // the map and silently dropped every key after it.
        if (i < src.length && indentOf(src[i]) > ind) v = block(ind + 1, depth);
        else if (i < src.length && indentOf(src[i]) === ind && /^-(\s|$)/.test(src[i].trim())) v = seq(ind, depth + 1);
        else v = null;
        if (name) anchors.set(name, v);
      } else if (/^[|>](?:[+-]?\d|\d[+-]|[+-])?$/.test(rest)) {
        v = blockScalar(rest, ind);
        if (name) anchors.set(name, v);
      } else if (rest.startsWith("{") || rest.startsWith("[")) {
        v = flowValue(rest, name, depth);
      } else {
        let scalar = rest;
        const scan = quoteScanner(rest);
        while (scan && !scan.complete && i < src.length) { const chunk = `\n${src[i++]}`; scalar += chunk; scan.feed(chunk); }
        if (scan && !scan.complete) problems.push("quote-unterminated");
        // A plain scalar cannot hold ": " (`a: b: c` is not a mapping value).
        else if (!scan && !/^[!&*]/.test(scalar) && /:\s/.test(scalar.replace(/\s#.*$/, ""))) problems.push("plain-scalar-colon");
        v = yamlScalar(scalar, anchors, state, depth);
        if (name) anchors.set(name, v);
      }
      if (Object.prototype.hasOwnProperty.call(out, m.key)) warnings.push(`duplicate key: ${m.key}`);
      assign(out, m.key, v);
    }
    return out;
  }

  function seq(ind, depth = 0) {
    const out = [];
    while (i < src.length) {
      const li = indentOf(src[i]);
      if (li < ind) break;
      if (li > ind) { i += 1; continue; }
      const t = src[i].trim();
      if (!/^-(\s|$)/.test(t)) break;
      i += 1;
      const { name, rest } = takeAnchor(t.slice(1).trim());
      let v;
      if (rest === "") {
        v = i < src.length && indentOf(src[i]) > ind ? block(ind + 1, depth) : null;
      } else if (rest.startsWith("{") || rest.startsWith("[")) {
        v = flowValue(rest, name, depth);
        out.push(v); continue;                          // flowValue already anchored
      } else if (yamlKey(rest)) {
        // "- name: q" opens an inline map whose siblings sit two columns in.
        // Rewriting the line at that indent lets map() own the whole item.
        i -= 1;
        src[i] = " ".repeat(ind + 2) + rest;
        v = map(ind + 2, depth + 1);
      } else {
        v = yamlScalar(rest, anchors, state, depth);
      }
      if (name) anchors.set(name, v);
      out.push(v);
    }
    return out;
  }

  const result = block(0);
  if (Array.isArray(result)) problems.push("not-a-mapping");
  if (result && typeof result === "object") Object.defineProperty(result, "yamlWarnings", { value: warnings, enumerable: false });
  return withProblems(result);
}

export function parseYaml(text) { return parseYamlDocument(text); }

export function readContract(path) {
  const raw = readFileSync(path, "utf8");
  let doc, problems = [];
  // Sniff, don't trust the extension: a JSON body in a .yaml file is valid
  // YAML flow and the flow parser handles it, but real JSON.parse is both
  // faster and stricter, so any document that LOOKS like JSON gets it first.
  const looksJson = /^\s*[{[]/.test(raw);
  if (path.endsWith(".json")) doc = JSON.parse(raw);   // named SyntaxError for the caller
  else {
    if (looksJson) { try { doc = JSON.parse(raw); } catch { doc = null; } }
    if (!doc) {
      try { doc = parseYaml(raw); problems = (doc && typeof doc === "object" ? YAML_PROBLEMS.get(doc) : null) ?? []; }
      catch { doc = null; problems = ["parse-failed"]; }
    }
    // The subset parser must earn its answer: if it found fewer paths than the
    // line-scan (or none), the document defeated it and the scan wins.
    const fallback = parseYamlish(raw);
    if (Object.keys(doc?.paths ?? {}).length < Object.keys(fallback.paths).length) doc = fallback;
  }
  // `problems` names what the lenient YAML reader had to skip (see
  // parseYamlDocument); it is absent for JSON and for a clean YAML parse.
  return { doc, digest: sha(raw), raw, ...(problems.length ? { problems: [...new Set(problems)] } : {}) };
}

// --- spec-version awareness -------------------------------------------------
// Three dialects, one reader. 3.0 and 3.1 differ only inside schemas (type
// arrays for nullability — schema consumers already tolerate them); Swagger
// 2.0 differs structurally: basePath prefixes every route, schemas hang
// directly off responses, and models live under #/definitions (which deref
// already resolves, since it walks the pointer generically).

export function specVersionOf(doc) {
  if (!doc || typeof doc !== "object") return null;
  if (typeof doc.swagger === "string" && doc.swagger.startsWith("2")) return "2.0";
  if (typeof doc.openapi === "string" || typeof doc.openapi === "number")
    return String(doc.openapi).startsWith("3.1") ? "3.1" : "3.0";
  return null;
}

// Swagger 2.0's basePath is part of every operation's real URL; 3.x moved it
// into servers[].url, which stays out of scope (it is usually a full origin,
// not a path prefix). "/" means nothing to prefix.
export const basePathOf = (doc) =>
  specVersionOf(doc) === "2.0" && typeof doc.basePath === "string" && doc.basePath !== "/"
    ? `/${doc.basePath.replace(/^\/+|\/+$/g, "")}`
    : "";

// Inventory and runtime must agree on which paths can name HTTP operations.
// A query-bearing key is not a pathname. Skip only that key rather than
// rejecting every other operation or merging it with a query-free sibling.
// Diagnostics identify the key's path, but never carry query/fragment values.
export function httpRoutePathProblem(path) {
  if (!path.startsWith('/')) return 'path-not-absolute';
  if (path.includes('?')) return 'literal-query-suffix';
  if (path.includes('#')) return 'literal-fragment-suffix';
  if (/\s/u.test(path)) return 'path-whitespace';
  if (path.includes('\\')) return 'path-backslash';
  if (/(?:^|\/)\.{1,2}(?:\/|$)/u.test(path)) return 'path-dot-segment';
  return null;
}

export function operationsFrom(doc, { onSkipped } = {}) {
  const ops = [];
  const base = basePathOf(doc);
  for (const [p, methods] of Object.entries(doc?.paths ?? {})) {
    const declared = Object.keys(methods ?? {}).filter(method => /^(get|post|put|patch|delete|head|options)$/i.test(method));
    if (!declared.length) continue;
    const path = `${base}${p}`, reason = httpRoutePathProblem(p) ?? httpRoutePathProblem(path);
    if (reason) {
      const boundary = path.search(/[?#]/u);
      const label = boundary < 0 ? path : `${path.slice(0, boundary)}${path[boundary]}…`;
      onSkipped?.({ code: 'HTTP_CONTRACT_ROUTE_SKIPPED', path: terminalText(redactMetadataSecrets(label)), reason,
        methods: declared.map(method => method.toUpperCase()) });
      continue;
    }
    for (const method of declared)
      ops.push({ op: `${method.toUpperCase()} ${path}`, method: method.toUpperCase(), path });
  }
  return ops;
}

/**
 * The contract node for an operation, addressed by its REAL path — the one
 * operationsFrom reports and probes hit. For Swagger 2.0 that carries the
 * basePath, which the paths table does not, so the prefix is stripped BEFORE
 * the raw path is tried: under basePath /v1 the real URL of "/users" is
 * /v1/users, a string an adversarial spec can also list literally, and trying
 * the raw path first handed that literal entry (real URL /v1/v1/users) back
 * for both routes. Stripping only happens on a whole segment — /apidocs under
 * basePath /api merely shares a prefix. The raw lookup remains as the
 * fallback for 3.x documents and spec-relative callers; a caller indexing
 * doc.paths directly would still silently miss 2.0 operations.
 */
export function opNode(doc, method, path) {
  const base = basePathOf(doc);
  if (base && path.startsWith(base) && (path.length === base.length || path[base.length] === "/")) {
    const stripped = doc?.paths?.[path.slice(base.length) || "/"]?.[method.toLowerCase()];
    if (stripped) return stripped;
  }
  return doc?.paths?.[path]?.[method.toLowerCase()];
}

// The response schema for an operation, if the document carries one. Used only
// to authorise value promotion, so a miss is safe: it means no values.
export function responseSchema(doc, method, path) {
  const node = opNode(doc, method, path);
  const responses = node?.responses ?? {};
  const ok = responses["200"] ?? responses["201"] ?? responses.default;
  // 3.x nests the schema under a media type — accept any JSON-ish spelling
  // ("application/json; charset=utf-8", "application/vnd.api+json"), never a
  // non-JSON one (that schema describes bytes we will not promote values
  // from). Swagger 2.0 hangs the schema directly off the response.
  let schema;
  if (ok?.content && typeof ok.content === "object") {
    const key = Object.keys(ok.content).find((k) => /\bjson\b|\+json\b/i.test(k));
    schema = key ? ok.content[key]?.schema : undefined;
  } else {
    schema = ok?.schema;                               // Swagger 2.0
  }
  if (!schema) return undefined;
  // Dereference before handing the fragment on: the promotion boundary is
  // deliberately ignorant of the wider document, and every real spec points at
  // its models by $ref. Leaving them unresolved silently authorises nothing.
  return deref(doc, schema);
}

/**
 * WHY a document yielded no operations — the named reason the ticket demands.
 * A stranger's spec must load or fail with a reason; "0 operations" with no
 * explanation cost a week of confusion when a normal inline-flow document hit
 * the old parser.
 */
export function noOperationsReason(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    return "the document did not parse as a mapping";
  const version = specVersionOf(doc);
  if (!("paths" in doc))
    return version
      ? `the document declares ${version === "2.0" ? "swagger" : "openapi"} ${version} but has no "paths" key`
      : 'the document has no "paths" key and no openapi/swagger version marker — is this an OpenAPI document?';
  const paths = doc.paths;
  if (!paths || typeof paths !== "object" || !Object.keys(paths).length)
    return '"paths" is present but empty';
  const skipped = [];
  operationsFrom(doc, { onSkipped: item => skipped.push(item) });
  if (skipped.length) return `all declared HTTP operations have unmatchable path keys (${[...new Set(skipped.map(item => item.reason))].join(', ')})`;
  return `"paths" lists ${Object.keys(paths).length} route(s) but none carries an HTTP method`;
}

function resolveRef(doc, ref) {
  // JSON-pointer tokens escape "/" as ~1 and "~" as ~0 (a path named
  // "a/b" is a legal schema name and appears in real specs).
  const parts = ref.replace(/^#\//, "").split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let node = doc;
  for (const p of parts) node = node?.[p];
  return node;
}

export function deref(doc, schema, seen = new Set(), depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 12) return schema;
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return {};          // cyclic model; stop
    const next = new Set(seen); next.add(schema.$ref);
    // A $ref to a schema that does not exist (a typo, a spec that references a
    // model it never defines) resolves to undefined. Returning that undefined
    // hands downstream code a value it does not expect; degrade to an empty
    // schema, which authorises nothing — the same conservative posture as a cycle.
    const target = resolveRef(doc, schema.$ref);
    return target == null ? {} : deref(doc, target, next, depth + 1);
  }
  if (Array.isArray(schema)) return schema.map((s) => deref(doc, s, seen, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(schema))
    out[k] = v && typeof v === "object" ? deref(doc, v, seen, depth + 1) : v;
  return out;
}

// --- source mapping --------------------------------------------------------
// A source hint for an operation, used by the git staleness signal. Tests and
// contract generators mention paths too; their changes do not identify a
// handler change. Exclude those artifacts before scoring runtime source.
const SOURCE_ARTIFACT = /(?:^|\/)(?:tests?|__tests__|spec|e2e|fixtures?|__fixtures__|testdata|test-data|coverage|docs?|evidence|generated|__generated__)(?:\/|$)|(?:^|\/)[^/]*[.](?:test|spec)[.]|(?:^|\/)(?:openapi|swagger)(?:[.-]|$)/i;
// Explicit generator basenames only (for example gen_openapi.py). A scripts/
// directory can contain real handlers; neither it nor arbitrary path tables
// establish that a file is a generator. Other naming conventions remain hints.
const CONTRACT_GENERATOR = /(?:^|\/)(?:(?:gen|generate|build|export)[_-](?:openapi|swagger)|(?:openapi|swagger)[_-](?:gen|generate|generator|build|export))\.[^/]+$/i;
const sourceArtifact = (file) => {
  const normalized = String(file).replace(/\\/g, "/");
  return SOURCE_ARTIFACT.test(normalized) || CONTRACT_GENERATOR.test(normalized);
};

export function mapSourceFiles(repoRoot) {
  const index = new Map();
  const walk = (dir, depth = 0) => {
    if (depth > 6) return;
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || ["node_modules", "venv", "dist", "build", "__pycache__"].includes(e.name)) continue;
      const p = join(dir, e.name);
      if (sourceArtifact(relative(repoRoot, p))) continue;
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (![".py", ".ts", ".js", ".mjs", ".go", ".rb"].includes(extname(e.name))) continue;
      try {
        if (statSync(p).size > 500_000) continue;
        index.set(relative(repoRoot, p), readFileSync(p, "utf8"));
      } catch { /* unreadable */ }
    }
  };
  walk(repoRoot);
  return index;
}

// A complete literal path is stronger evidence than repeated mentions of its
// collection. Equal hints stay unmapped rather than depending on walk order.
export function sourceFileFor(pathname, index) {
  const segment = pathname.split("/").filter((s) => s && !s.startsWith("{"))[0];
  if (!segment) return null;
  let best = null, bestScore = 0, tied = false;
  for (const [file, src] of index) {
    if (sourceArtifact(file)) continue;
    let score = 0;
    if (file.includes(`/${segment}.`) || file.endsWith(`${segment}.py`)) score += 10;
    const escaped = segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const quoted = new RegExp(`["'\`]/?${escaped}(/|["'\`])`, "g");
    score += Math.min(5, (src.match(quoted) ?? []).length);
    const canonical = (p) => p.replace(/:[A-Za-z0-9_]+|\{[^}]+\}/g, "{}").replace(/\/+$/, "") || "/";
    for (const match of src.matchAll(/["'`](\/[^"'`\n]*)["'`]/g)) {
      if (canonical(match[1]) === canonical(pathname)) { score += 20; break; }
    }
    if (score > bestScore) { bestScore = score; best = file; tied = false; }
    else if (score > 0 && score === bestScore) tied = true;
  }
  return bestScore > 0 && !tied ? best : null;
}

// --- provenance ------------------------------------------------------------
// Every written claim — a note, a verdict, a promoted observation — records WHO
// wrote it and WHEN, so a reader three years on can weigh it. The author is a
// MARKER, never an identity: attribution is the goal, not a person's contact
// details. API_AUTHOR wins if set, else git's configured user.name, else a
// generic "agent". The file is committed and cloned everywhere, so a value that
// could carry PII (an email — or a whitespace-free token long enough to be a
// credential) degrades to "agent" rather than leaking. This is the same posture
// as the note/verdict secret guard, applied to the one field the guard does not
// see: attribution the tool synthesises rather than the user typing.
const EMAILISH = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const UNSAFE_MARKER_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function safeMarkerBy(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 80
    && value === value.trim() && !EMAILISH.test(value) && !/\S{40,}/.test(value)
    && !UNSAFE_MARKER_TEXT.test(value);
}

export function authorMarker(repoRoot) {
  let who = process.env.API_AUTHOR?.trim();
  if (!who) {
    try {
      who = execFileSync("git", ["config", "user.name"],
        { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch { who = ""; }
  }
  // An email is PII; a long unbroken token is a credential shape. Either one
  // must never be committed as an author, so a marker that trips them is not
  // trusted — attribution falls back to the anonymous default.
  if (!who || EMAILISH.test(who) || /\S{40,}/.test(who) || UNSAFE_MARKER_TEXT.test(who)) return "agent";
  return who.slice(0, 80);
}

/** A provenance stamp: who wrote a claim, and on what day. Date-only on
 *  purpose — the day is what a reader weighs; the wall-clock time is noise. */
export function provenanceStamp(repoRoot, today = new Date().toISOString().slice(0, 10)) {
  return { by: authorMarker(repoRoot), at: today };
}

// --- freshness -------------------------------------------------------------
// Staleness is computable from the repo, with no execution and no judgement.

export function lastCommitFor(repoRoot, file) {
  if (!file) return null;
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%ad", "--date=short", "--", file],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out || null;
  } catch { return null; }
}

// git answers are memoised per process and HEAD: status grades every operation,
// and a hundred operations over one repo is the same handful of questions
// asked a hundred times. The HEAD component is essential because provider
// confidence is query-time truth; a commit during a long-lived server process
// must invalidate the old answers without requiring a restart.
const gitCache = new Map();
// One snapshot render (view, map) is one point in time: HEAD is asked once per
// repository for its duration instead of once per graded operation. Outside a
// snapshot every question re-reads HEAD, as a long-lived server must.
let snapshotHeads = null;
const gitHead = (repoRoot) => {
  if (snapshotHeads?.has(repoRoot)) return snapshotHeads.get(repoRoot);
  let head;
  try {
    head = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch { head = null; }
  snapshotHeads?.set(repoRoot, head);
  return head;
};
export function withGitSnapshot(fn) {
  if (snapshotHeads) return fn();
  snapshotHeads = new Map();
  try { return fn(); } finally { snapshotHeads = null; }
}

const gitLines = (repoRoot, args) => {
  const key = `${repoRoot}\x00${gitHead(repoRoot) ?? "NO_HEAD"}\x00${args.join("\x00")}`;
  if (gitCache.has(key)) return gitCache.get(key);
  let out;
  try {
    out = execFileSync("git", args, { cwd: repoRoot, encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").filter(Boolean);
  } catch { out = null; }
  gitCache.set(key, out);
  return out;
};

// Commit times that touched a file, newest first, in strict ISO with offset.
// Full precision on purpose: comparing YYYY-MM-DD strings could never see a
// commit made later the SAME DAY as the verification (verify at 10:00, commit
// at 23:00, grade "source unchanged" forever).
const commitTimesFor = (repoRoot, file) =>
  file ? gitLines(repoRoot, ["log", "--format=%aI", "--", file]) : null;

// How far the repo has moved since a date — "3 commits ago" reads better than
// a date when judging whether "verified" still means anything.
const commitsSince = (repoRoot, date) => {
  const n = gitLines(repoRoot, ["rev-list", "--count", `--since=${date}`, "HEAD"]);
  return n === null ? null : Number(n[0] ?? 0);
};

const shortDigest = (d) => (d ?? "").replace(/^sha256:/, "").slice(0, 8);

/**
 * The digest of the contract AS IT SITS ON DISK, for grading freshness. The
 * stored ctx.api.contract_digest is only what init/learn last saw; grading
 * against it made an edited openapi.yaml invisible until the next write
 * command refreshed the stored value. Falls back to the stored digest when the
 * file is missing or unreadable — a deleted contract is its own problem, and
 * should not silently flip every operation suspect.
 */
export function liveContractDigest(repoRoot, ctx) {
  if (ctx?.api?.contract) {
    try { return sha(readFileSync(resolve(repoRoot, ctx.api.contract), "utf8")); }
    catch { /* fall through to the stored value */ }
  }
  return ctx?.api?.contract_digest ?? null;
}

// AGE is a SECOND staleness axis, orthogonal to source drift. confidenceFor
// grades whether the SOURCE moved (git); but an API can change under a client
// whose own source never moved — a documented field quietly dropped, a limit
// tightened server-side — so a claim confirmed long ago is stale even when git
// shows nothing. The two must never be conflated: "the code moved" and "nobody
// has looked in seven months" are different reasons a reader acts on
// differently, so age travels as its own axis, never folded into the source
// reasons. The horizon is configurable; the default is half a year, long
// enough that a normally-maintained knowledge file stays green and short enough
// that a genuinely abandoned claim surfaces.
export const STALE_DAYS_DEFAULT = 180;
// The horizon obeys the same three-level precedence as every other client
// default: an explicit API_STALE_DAYS beats the config file's `defaults` block
// beats the built-in. readConfigDefaults applies all three (and abstains
// cleanly on a malformed or absent file), so a project can commit its own
// staleness policy instead of every reader exporting an env var.
export function staleHorizon() {
  return readConfigDefaults().staleDays;
}

// Days since a claim was last confirmed, and whether that is past the horizon.
// null when the date will not parse — an unplaceable date cannot prove
// freshness, but it is the caller's existing source/contract grade that speaks
// to trust; age simply abstains rather than inventing a day count.
function ageOf(verifiedAt, today) {
  const ms = Date.parse(verifiedAt);
  if (Number.isNaN(ms)) return null;
  const days = Math.floor((today - ms) / 86_400_000);
  const horizon = staleHorizon();
  return { days, horizon, stale: days > horizon };
}

/** The age axis as a human clause, or null when it says nothing worth a line.
 *  Deliberately worded so it can never be mistaken for the source reason: it
 *  talks about CONFIRMATION age, not about anything in the repo moving. */
export function ageReason(age) {
  if (!age) return null;
  return age.stale
    ? `last confirmed ${age.days} days ago, past the ${age.horizon}-day staleness horizon (source-independent: the API may have moved under an unchanged client)`
    : `last confirmed ${age.days} days ago`;
}

/**
 * Grade a claim — and say WHY. Deliberately three states, not a score: an
 * agent should be able to act on this without interpreting a number.
 *   verified  - checked, and nothing it depends on has moved since
 *   suspect   - the source, the contract, or the response shape moved after
 *               the last verification
 *   unverified- no verification recorded in this context
 * The reasons are the graded part: "verified 2026-08-01 (3 commits ago),
 * source unchanged" and "verified April, source changed twice since, shape
 * hash diverged" carry the same label lattice but very different urgency, and
 * only the reasons let a reader tell them apart.
 *
 * `age` rides alongside as a distinct axis (see ageOf): the SOURCE grade above
 * says whether the repo moved; age says how long since anyone confirmed the
 * claim against a live API. A reader needs both, never one masquerading as the
 * other, so age is returned separately and never mutates `confidence` — an
 * old-but-source-unchanged claim keeps its verified LABEL and carries an
 * age-stale reason, which is the honest reading: nothing we can see moved, but
 * nobody has looked in a long time.
 */
export function freshnessFor(entry, repoRoot, contractDigest, today = Date.now(), { commits = true } = {}) {
  // Older learn versions incorrectly stamped authentication failures. Grade
  // this unambiguous legacy shape conservatively without rewriting the file.
  // Mixed success/error status sets do not establish the latest outcome.
  if (Array.isArray(entry.status_codes) && entry.status_codes.length
    && entry.status_codes.every(status => status === 401 || status === 403)) {
    return { confidence: "unverified", age: null,
      reasons: ["authentication failed; recorded 401/403 responses do not verify this operation"] };
  }
  if (!entry.verified_at) {
    return { confidence: "unverified", age: null, reasons: [entry.source_file
      ? `no execution verification recorded in this context; mapped to ${entry.source_file}`
      : "no execution verification recorded in this context"] };
  }
  const age = ageOf(entry.verified_at, today);
  const reasons = [];
  let suspect = false;
  // verified_at may be date-only (older files) or full ISO (current learns).
  // Date.parse reads date-only as UTC midnight, so an ambiguous same-day
  // commit grades suspect — the honest direction for a grade whose job is
  // trust. New learns carry the time, which removes the ambiguity entirely.
  const verifiedMs = Date.parse(entry.verified_at);
  // The commit count only describes; the grade below never depends on it. A
  // caller that shows labels alone (the map) skips one git call per date.
  const ago = commits ? commitsSince(repoRoot, entry.verified_at) : null;
  reasons.push(`verified ${entry.verified_at.slice(0, 10)}` +
    (ago !== null && !Number.isNaN(ago) ? ` (${ago} commit${ago === 1 ? "" : "s"} ago)` : ""));
  if (entry.contract_digest && contractDigest && entry.contract_digest !== contractDigest) {
    suspect = true;
    reasons.push(`contract digest diverged (${shortDigest(entry.contract_digest)}… → ${shortDigest(contractDigest)}…)`);
  } else if (entry.contract_digest && contractDigest) {
    reasons.push("contract unchanged");
  }
  if (entry.source_file) {
    const times = commitTimesFor(repoRoot, entry.source_file);
    const after = (times ?? []).filter((t) => Date.parse(t) > verifiedMs);
    if (after.length) {
      suspect = true;
      reasons.push(`${entry.source_file} changed ${after.length} time${after.length === 1 ? "" : "s"} since, last ${after[0].slice(0, 10)}`);
    } else if (times?.length) {
      reasons.push("source unchanged");
    }
  }
  if (entry.shape_diverged_at) {
    // Written by the audit's baseline pass when a live response stopped
    // matching the recorded shape hash; cleared by re-learning, which is the
    // only thing that makes the claim fresh again.
    suspect = true;
    reasons.push(`response shape hash diverged from the recorded baseline (observed ${entry.shape_diverged_at})`);
  }
  return { confidence: suspect ? "suspect" : "verified", reasons, age };
}

/** The label alone, for callers that only branch on it. */
export function confidenceFor(entry, repoRoot, contractDigest) {
  return freshnessFor(entry, repoRoot, contractDigest).confidence;
}

// --- the file --------------------------------------------------------------

export function emptyContext({ name, contractPath, contractDigest }) {
  return {
    v: CONTEXT_VERSION,
    api: { name, contract: contractPath, contract_digest: contractDigest },
    generated_at: new Date().toISOString().slice(0, 10),
    operations: {},
  };
}

export function loadContext(dir) {
  return loadContextSnapshot(dir)?.ctx ?? null;
}

// A snapshot couples the parsed document to the exact bytes it came from.
// Notes use the digest as a compare-and-swap token; ordinary readers retain
// loadContext's historical ctx-or-null contract above.
export function loadContextSnapshot(dir) {
  const path = join(dir, contextFileFor(dir, CONTEXT_FILE));
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    return { ctx: JSON.parse(raw), digest: sha(raw) };
  } catch {
    return null;
  }
}

// A file's identity, not its contents: enough to know that re-reading would
// return something different, cheap enough to ask before every request. Both
// timestamps ride along because a same-size overwrite in place changes neither
// device nor inode. null when the path cannot be stat'd at all.
//
// Anything that is not a REGULAR file is null too, and that is a safety
// property, not tidiness: readFileSync on a FIFO blocks until someone opens the
// other end, synchronously, so a named pipe left at either of these paths would
// wedge a long-lived server forever rather than fail. Both readers below treat
// null the way they treat a missing file — no delivery, or the stored digest —
// which is the answer a directory already produced by way of EISDIR. A symlink
// to a regular file still resolves: statSync follows it, and its target's
// identity is the one that matters.
const fileIdentity = (path) => {
  try {
    const s = statSync(path);
    return s.isFile() ? `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}` : null;
  } catch {
    return null;
  }
};

/**
 * The knowledge file, kept CURRENT for a process that outlives it.
 *
 * loadContext is a snapshot, which is right for a CLI — every invocation is a
 * new process — and wrong for the MCP server, which is long-lived. Parsed once
 * at startup, it delivered whatever was on disk when it started for the rest of
 * its life: a note written mid-session reached every later session and never
 * the one that wrote it.
 *
 * Re-parsing unconditionally would bill every request for a file that almost
 * never changes, so the read is gated on the file's stat identity. Product
 * writes go through withContextLock's temp-file-plus-rename below, which
 * allocates a new inode, so every one of them changes the identity even when
 * the bytes and the clock would not.
 *
 * current() returns loadContextSnapshot's {ctx, digest}, or null when the file
 * is missing or malformed — the same null-on-any-problem contract loadContext
 * has always had. A file that appears, vanishes, or is repaired later is picked
 * up on the next call. loads counts parses, so a test can prove the cache is a
 * cache and not a second copy of the defect.
 */
export function contextReader(dir) {
  const path = join(dir, contextFileFor(dir, CONTEXT_FILE));
  let identity;            // undefined: nothing observed yet. null: absent.
  let snapshot = null;
  let loads = 0;
  return {
    get loads() { return loads; },
    current() {
      const now = fileIdentity(path);
      if (identity !== undefined && now === identity) return snapshot;
      identity = now;
      if (now === null) return (snapshot = null);
      loads += 1;
      return (snapshot = loadContextSnapshot(dir));
    },
  };
}

/**
 * liveContractDigest for the same process: the same answer, hashed only when
 * the contract file on disk has actually changed.
 *
 * The contract path lives in the context, so it arrives per call rather than
 * per reader — a re-read context may point at a different file. Every
 * fall-through gives the same answer liveContractDigest gives: no declared
 * contract, or one that cannot be stat'd or read, yields the STORED digest,
 * because a deleted contract is its own problem and must not silently flip
 * every operation suspect. It differs from liveContractDigest in one direction
 * only — a non-regular file is refused unopened (see fileIdentity) rather than
 * blocking the process — and it reaches the same stored-digest answer that
 * liveContractDigest reaches for every case liveContractDigest returns from.
 */
export function contractDigestReader(repoRoot) {
  let key;                 // `${path}\u0000${identity}` of the last hash
  let digest = null;
  let hashes = 0;
  return {
    get hashes() { return hashes; },
    current(ctx) {
      const stored = ctx?.api?.contract_digest ?? null;
      if (!ctx?.api?.contract) return stored;
      try {
        // A hand-edited context can carry a non-string path. Resolution is
        // enrichment too: fall back just as liveContractDigest does instead
        // of turning invalid metadata into a request/transport failure.
        const path = resolve(repoRoot, ctx.api.contract);
        const identity = fileIdentity(path);
        if (identity === null) { key = undefined; digest = null; return stored; }
        const now = `${path}\u0000${identity}`;
        if (now === key) return digest;
        digest = sha(readFileSync(path, "utf8"));
        hashes += 1;
        key = now;
        return digest;
      } catch {
        key = undefined; digest = null; return stored;
      }
    },
  };
}

// A context file can be present and valid JSON without being something the
// client can use. Keep this inspection separate from loadContext's historical
// null-on-any-problem contract so health/reporting callers can distinguish
// missing, malformed, and structurally unusable state without making every
// consumer learn a new return shape.
export function inspectContext(dir) {
  const { state, path } = readContextState(dir);
  return { state, path };
}

// inspectContext's answer and the parsed snapshot from ONE read, for a
// renderer that must grade the file and then project it without reading it
// twice (two reads can also disagree if a writer lands between them).
export function readContextState(dir) {
  const path = join(dir, contextFileFor(dir, CONTEXT_FILE));
  if (!existsSync(path)) return { state: "missing", path, snapshot: null };
  let raw, value;
  try { raw = readFileSync(path, "utf8"); value = JSON.parse(raw); }
  catch { return { state: "malformed", path, snapshot: null }; }
  const usable = value !== null && typeof value === "object" && !Array.isArray(value)
    && value.operations !== null && typeof value.operations === "object"
    && !Array.isArray(value.operations);
  return { state: usable ? "healthy" : "unusable", path, snapshot: { ctx: value, digest: sha(raw) } };
}

const LOCK_PAUSE = new Int32Array(new SharedArrayBuffer(4));

export function withContextLock(dir, fn, { lockTimeoutMs = 5_000 } = {}) {
  assertWritableStack(activeStackScopeFor(dir));
  ensureLayout(dir);
  safeOutputPath(join(dir, contextFileFor(dir, CONTEXT_FILE)), { code: "CONTEXT_UNSAFE_PATH" });
  const lockPath = join(dir, `${contextFileFor(dir, CONTEXT_FILE)}.lock`);
  const deadline = Date.now() + lockTimeoutMs;
  let fd;
  for (;;) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        const timeout = new Error(`Timed out waiting for the ${CONTEXT_FILE} write lock.`);
        timeout.code = "CONTEXT_WRITE_LOCKED";
        throw timeout;
      }
      Atomics.wait(LOCK_PAUSE, 0, 0, 5);
    }
  }

  try {
    return fn();
  } finally {
    try { closeSync(fd); } catch { /* the unlink below is still required */ }
    try { unlinkSync(lockPath); } catch { /* never mask the original write result */ }
  }
}

function atomicContextWrite(dir, ctx, { beforeRename } = {}) {
  const serialized = `${JSON.stringify(ctx, null, 2)}\n`;
  // Every shape uses the same storage boundary, including legacy-only
  // inventories and snapshots produced by init/learn.
  if (Buffer.byteLength(serialized, "utf8") > MAX_CONTEXT_BYTES)
    throw Object.assign(new Error("The context exceeds the 16 MiB storage limit; the existing file was preserved."), { code: "CONTEXT_CAPACITY_REACHED" });
  const path = join(dir, contextFileFor(dir, CONTEXT_FILE));
  const tempName = `${basename(path)}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
  const tempPath = join(dirname(path), tempName);
  const existingMode = existsSync(path) ? statSync(path).mode & 0o777 : null;
  let renamed = false;
  try {
    writeFileSync(tempPath, serialized, {
      encoding: "utf8",
      mode: existingMode ?? 0o666,
    });
    // An explicit create mode is still filtered through the current umask.
    // Restore an existing file's exact permissions before it becomes visible;
    // a brand-new file keeps the normal umask-derived behavior.
    if (existingMode !== null) chmodSync(tempPath, existingMode);
    beforeRename?.({ tempName });
    renameSync(tempPath, path);
    renamed = true;
  } finally {
    if (!renamed) try { unlinkSync(tempPath); } catch { /* temp may never have been created */ }
  }
}

function writeConflict(expectedVersion, actualVersion) {
  const error = new Error(
    `${CONTEXT_FILE} changed before this write: expected ${expectedVersion}, found ${actualVersion}.`,
  );
  error.code = "CONTEXT_WRITE_CONFLICT";
  error.expectedVersion = expectedVersion;
  error.actualVersion = actualVersion;
  return error;
}

export function saveContext(dir, ctx, options = {}) {
  return withContextLock(dir, () => {
    const current = loadContextSnapshot(dir);
    if (typeof options.expectedDigest === "string") {
      const actual = current?.digest ?? versionOf(null);
      if (actual !== options.expectedDigest) throw writeConflict(options.expectedDigest, actual);
    }
    protectContextNoteHistory(current?.ctx, ctx);
    return atomicContextWrite(dir, ctx, options);
  }, options);
}

// Additive writers must read inside the same lock as the write. This preserves
// notes and other protocol histories recorded by concurrent clients.
export function updateContext(dir, change) {
  return withContextLock(dir, () => {
    const state = inspectContext(dir);
    if (!["missing", "healthy"].includes(state.state))
      throw Object.assign(new Error("The context file is damaged; it was preserved."), { code: "CONTEXT_INVALID" });
    const ctx = loadContext(dir) ?? emptyContext({});
    if (ctx.v !== CONTEXT_VERSION)
      throw Object.assign(new Error("The context version is unsupported; it was preserved."), { code: "CONTEXT_VERSION_UNSUPPORTED" });
    const previous = structuredClone(ctx);
    const result = change(ctx);
    protectContextNoteHistory(previous, ctx);
    // Match the actual on-disk representation, including indentation, UTF-8
    // expansion and its final newline. Refuse before creating a temporary file.
    if (Buffer.byteLength(`${JSON.stringify(ctx, null, 2)}\n`, "utf8") > MAX_CONTEXT_BYTES)
      throw Object.assign(new Error("The context exceeds the 16 MiB storage limit; the existing file was preserved."), { code: "CONTEXT_CAPACITY_REACHED" });
    atomicContextWrite(dir, ctx);
    return result;
  });
}

function alignedNoteFields(entry) {
  assertWritableNoteHistory(entry);
  const notes = Array.isArray(entry.notes) ? [...entry.notes] : [];
  const notes_provenance = Array.isArray(entry.notes_provenance)
    ? entry.notes_provenance.slice(0, notes.length) : [];
  const notes_superseded = Array.isArray(entry.notes_superseded)
    ? entry.notes_superseded.slice(0, notes.length)
        .map((marker) => isValidSupersessionMarker(marker) ? marker : null)
    : [];
  while (notes_provenance.length < notes.length) notes_provenance.push(null);
  while (notes_superseded.length < notes.length) notes_superseded.push(null);
  return { notes, notes_provenance, notes_superseded };
}

function generatedReachabilityNote(note, provenance) {
  return provenance?.kind === "learn_reachability_failure";
}

// Superseded text remains in the committed file for auditability, but is not
// an active gotcha delivered to an agent or pushed into a pointer block.
export function activeNotes(entry) {
  return inspectNoteHistory(entry).active.map(record => record.text);
}

// A repeated generated observation on the same day can have identical text
// and attribution after an earlier occurrence was superseded. Preserve the
// original stamp and add a bounded occurrence discriminator only if needed.
function uniqueNoteStamp(fields, note, stamp) {
  let result = { ...stamp }, instance = 1;
  const identities = new Set(fields.notes.map((text, i) => noteIdentity(text, fields.notes_provenance[i] ?? null)));
  while (identities.has(noteIdentity(note, result))) result = { ...stamp, note_instance: ++instance };
  return result;
}

export function recordReachabilityFailure(entry, { base, detail, stamp }) {
  const next = { ...entry, verified_at: null };
  const fields = alignedNoteFields(entry);
  const note = `Unreachable at ${base}: ${detail}`;
  const alreadyActive = fields.notes.findIndex((text, index) =>
    text === note && !isValidSupersessionMarker(fields.notes_superseded[index])
      && generatedReachabilityNote(text, fields.notes_provenance[index]));
  if (alreadyActive === -1) {
    const provenance = uniqueNoteStamp(fields, note, {
      ...stamp, kind: "learn_reachability_failure",
      code: /^[A-Z][A-Z0-9_]+$/.test(detail) ? detail : "TRANSPORT_ERROR",
    });
    fields.notes.push(note);
    fields.notes_provenance.push(provenance);
    fields.notes_superseded.push(null);
  }
  return sealNoteMutation(entry, { ...next, ...fields });
}

// Failed reads are observations, not new successful response shapes. Keep
// previous fields and authored notes, invalidate the verification label, and
// retain only bounded status/assertion/evidence metadata from this attempt.
export function recordLearnFailure(entry, { status, outcome, evidence, assertions, stamp, drift = [] }) {
  const authFailed = status === 401 || status === 403;
  const kind = outcome ?? (authFailed ? "authentication_failed" : "http_failed");
  const note = authFailed ? `Authentication failed (HTTP ${status}); unverified.`
    : kind === "redirected" ? "Request redirected; the final response does not verify this operation."
    : kind === "client_failed" ? "Client could not complete verification; unverified."
    : Number.isInteger(status) ? `HTTP ${status}; unverified.` : "Request refused; unverified.";
  const next = { ...entry, verified_at: null, last_learn: {
    observed_at: new Date().toISOString(), outcome: kind,
    status: Number.isInteger(status) ? status : null,
    ...(typeof evidence === "string" && /^run-[a-zA-Z0-9-]+$/.test(evidence) ? { evidence } : {}),
    ...(assertions ? { assertions: { passed: assertions.passed, failed: assertions.failed } } : {}),
  } };
  delete next.verified_by;
  const fields = alignedNoteFields(entry);
  // Drift text has already passed the client's secret scrubber. Preserve the
  // same generated-note path and alignment used by successful learn.
  const notes = [note, ...drift.filter(d => d.kind === "redirect").map(d =>
    `Documented as ${d.requested}; server responds ${d.status} redirecting to ${d.served}.`)];
  for (const text of notes) {
    if (fields.notes.some((n, i) => n === text && !isValidSupersessionMarker(fields.notes_superseded[i]))) continue;
    const provenance = uniqueNoteStamp(fields, text, { ...stamp, kind: "learn_verification_failure" });
    fields.notes.push(text);
    fields.notes_provenance.push(provenance);
    fields.notes_superseded.push(null);
  }
  return sealNoteMutation(entry, { ...next, ...fields });
}

export function mergeVerifiedEntry(entry, learned, stamp) {
  const merged = { ...entry, ...learned };
  const fields = alignedNoteFields(entry);

  // learnFromResponse's notes describe fresh protocol drift. Accumulate them
  // without replacing user notes or historical failures, and keep repeat
  // learns idempotent at the note layer.
  for (const note of Array.isArray(learned.notes) ? learned.notes : []) {
    if (fields.notes.some((text, index) =>
      text === note && !isValidSupersessionMarker(fields.notes_superseded[index]))) continue;
    const provenance = uniqueNoteStamp(fields, note, { ...stamp, kind: "learn_observation" });
    fields.notes.push(note);
    fields.notes_provenance.push(provenance);
    fields.notes_superseded.push(null);
  }

  for (let index = 0; index < fields.notes.length; index += 1) {
    if (isValidSupersessionMarker(fields.notes_superseded[index])) continue;
    if (!generatedReachabilityNote(fields.notes[index], fields.notes_provenance[index])
      && fields.notes_provenance[index]?.kind !== "learn_verification_failure") continue;
    const marker = {
      at: learned.verified_at,
      ...(safeMarkerBy(learned.verified_by) ? { by: learned.verified_by } : {}),
      reason: "successful_verification",
    };
    if (isValidSupersessionMarker(marker)) fields.notes_superseded[index] = marker;
  }
  if (fields.notes.length) Object.assign(merged, fields);
  else {
    delete merged.notes;
    delete merged.notes_provenance;
    delete merged.notes_superseded;
  }
  return sealNoteMutation(entry, merged);
}

function noteTarget(ctx, input) {
  const key = normalizeNoteKey(input);
  if (key.kind !== "operation") return key;
  const operation = key.op;
  const operations = ctx.operations ?? {};
  return { kind: "operation", op: Object.keys(operations).find((key) => key === operation)
    ?? Object.keys(operations).find((key) =>
      key.replace(/\/+$/, "") === operation.replace(/\/+$/, ""))
    ?? operation };
}

function versionOf(value) {
  return sha(JSON.stringify(value) ?? "<missing>");
}

function noteConflict(code, operation, expectedVersion, actualVersion, attempts) {
  const error = new Error(
    `${CONTEXT_FILE} changed while recording ${operation}: expected ${expectedVersion}, found ${actualVersion}.`,
  );
  error.code = code;
  error.operation = operation;
  error.expectedVersion = expectedVersion;
  error.actualVersion = actualVersion;
  error.attempts = attempts;
  return error;
}

function applyNote(ctx, { key: input, operation, operations, note, stamp, relation, retirement }) {
  const key = noteTarget(ctx, input ?? operation);
  const target = noteKeyLabel(key);
  if (!stamp || typeof stamp !== "object" || Object.getPrototypeOf(stamp) !== Object.prototype
    || Object.values(Object.getOwnPropertyDescriptors(stamp)).some(descriptor => !Object.hasOwn(descriptor, "value")))
    throw noteHistoryError("NOTE_INPUT_INVALID", target);
  if (operations !== undefined && stamp?.operations !== undefined
    && JSON.stringify(normalizeNoteOperations(operations)) !== JSON.stringify(normalizeNoteOperations(stamp.operations)))
    throw noteHistoryError("NOTE_OPERATIONS_INVALID", target);
  const applicable = normalizeNoteOperations(operations ?? stamp?.operations);
  if (key.kind !== "stack" && applicable !== undefined) throw noteHistoryError("NOTE_OPERATIONS_INVALID", target);
  stamp = { ...stamp };
  delete stamp.operations;
  if (applicable !== undefined) stamp.operations = applicable;
  const sameClaim = record => record.text === note
    && JSON.stringify(record.provenance?.operations ?? []) === JSON.stringify(applicable ?? []);
  const existing = getNoteEntry(ctx, key);
  const entry = existing === undefined ? (key.kind !== "operation" ? { notes: [] } : { source_file: null, verified_at: null, contract_digest: null,
    shape_hash: null, status_codes: [], effect: null, fields: {}, notes: [] }) : existing;
  const history = inspectNoteHistory(entry, target);
  if (["invalid", "changed"].includes(history.state)) assertWritableNoteHistory(entry, target);
  if (retirement !== undefined) {
    if (key.kind !== 'operation' || relation !== undefined || !retirement || typeof retirement !== 'object'
      || Object.keys(retirement).some(key => !['note_id', 'reason'].includes(key))) throw reviewError('NOTE_RETIRE_INVALID');
    validateReviewActor(stamp.by, stamp.actor);
    note = retirementNote(retirement.note_id, retirement.reason, note);
    relation = { supersedes: retirement.note_id };
  }
  if (typeof note !== "string" || !note.trim() || !validAuthoredNoteStamp(stamp))
    throw noteHistoryError("NOTE_INPUT_INVALID", target, history);
  if (secretIn(note, { allowAuthReferences: true })) throw noteHistoryError("SECRET_IN_NOTE", target, history);
  if (relation !== undefined && (!relation || typeof relation !== "object" || Array.isArray(relation)
    || Object.keys(relation).some(key => !["alongside", "supersedes"].includes(key))
    || (relation.alongside === true) === (typeof relation.supersedes === "string")
    || (relation.supersedes !== undefined && !/^sha256:[a-f0-9]{64}$/.test(relation.supersedes))))
    throw noteHistoryError("NOTE_RELATION_INVALID", target, history);

  // Relation idempotence comes before active-target validation: the first
  // successful correction has deliberately made its target historical.
  if (relation?.supersedes) {
    const previous = (entry.note_replacements ?? []).find(link => link.supersedes === relation.supersedes);
    if (previous) {
      const replacement = history.records.find(record => record.id === previous.replacement);
      if (replacement && sameClaim(replacement) && noteRetirement(entry, previous.replacement)?.reason === retirement?.reason) return { target, key, unchanged: true, note_id: replacement.id, history };
      throw Object.assign(noteHistoryError("NOTE_ALREADY_SUPERSEDED", target, history), {
        replacement: previous.replacement, current_notes: history.active.map(record => record.id),
      });
    }
  }
  const duplicate = history.active.find(sameClaim);
  if (duplicate && !relation?.supersedes) return { target, key, unchanged: true, note_id: duplicate.id, history };
  assertWritableNoteHistory(entry, target);
  let old;
  if (relation?.supersedes) {
    old = history.records.find(record => record.id === relation.supersedes);
    if (!old) throw retirement ? staleNoteError(history) : noteHistoryError("NOTE_NOT_FOUND", target, history);
    if (old.superseded) throw noteHistoryError("NOTE_ALREADY_SUPERSEDED", target, history);
    if (sameClaim(old)) throw noteHistoryError("NOTE_SELF_SUPERSESSION", target, history);
    assertReviewOverturn(entry, old.id, (stamp.evidence ?? []).map(ref => ref.run_id));
  } else if (!relation?.alongside && history.active.some(record => record.kind !== "machine")) {
    throw noteHistoryError("NOTE_RELATION_REQUIRED", target, history);
  }
  setNoteEntry(ctx, key, entry);
  const fields = alignedNoteFields(entry);
  const provenance = uniqueNoteStamp(fields, note, stamp);
  const id = noteIdentity(note, provenance);
  fields.notes.push(note);
  fields.notes_provenance.push(provenance);
  fields.notes_superseded.push(null);
  Object.assign(entry, fields);
  if (old) (entry.note_replacements ??= []).push({ supersedes: old.id, replacement: id, by: stamp.by, at: stamp.at });
  if (retirement) (entry.note_retirements ??= []).push({ replacement: id, reason: retirement.reason, actor: stamp.actor });
  entry.noted_at = stamp.at;
  entry.noted_by = stamp.by;
  // An operation first created by this explicit note command is new history,
  // unlike a bulk import of pre-existing legacy bytes.
  if (!existing) baselineNoteHistory(entry);
  return { target, key, unchanged: false, note_id: id };
}

// One target operation may be changed atomically. An unrelated-operation race
// rebases once; any target change or second file race requires a new decision.
function changeNoteHistory(dir, snapshot, input, change, options = {}, acceptingBaseline = false) {
  if (!snapshot?.ctx || typeof snapshot.digest !== "string")
    throw Object.assign(new Error(`Cannot record a note without a valid ${CONTEXT_FILE} snapshot.`), { code: "CONTEXT_SNAPSHOT_REQUIRED" });
  const key = noteTarget(snapshot.ctx, input);
  const target = noteKeyLabel(key);
  return withContextLock(dir, () => {
    const current = loadContextSnapshot(dir);
    if (!current) throw noteConflict("CONTEXT_WRITE_CONFLICT", target, snapshot.digest, versionOf(null), 1);
    const rebased = current.digest !== snapshot.digest;
    if (rebased) {
      const expectedVersion = versionOf(getNoteEntry(snapshot.ctx, key));
      const actualVersion = versionOf(getNoteEntry(current.ctx, key));
      if (expectedVersion !== actualVersion)
        throw Object.assign(noteConflict("CONTEXT_NOTE_CONFLICT", target, expectedVersion, actualVersion, 1), {
          current_notes: inspectNoteHistory(getNoteEntry(current.ctx, key), target).records.map(record => record.id),
        });
    }
    const next = structuredClone(current.ctx);
    const result = change(next, key);
    if (result.unchanged) return { ctx: next, ...result, target, key };
    if (rebased) options.afterReapply?.({ attempt: 1 });
    const checked = loadContextSnapshot(dir);
    if (!checked || checked.digest !== current.digest)
      throw noteConflict("CONTEXT_WRITE_CONFLICT", target, current.digest, checked?.digest ?? versionOf(null), rebased ? 2 : 1);
    if (!acceptingBaseline) protectContextNoteHistory(current.ctx, next);
    atomicContextWrite(dir, next, options);
    return { ctx: next, ...result, target, key, history: inspectNoteHistory(getNoteEntry(next, key), target) };
  }, options);
}

export function saveContextNote(dir, snapshot, change, options = {}) {
  return changeNoteHistory(dir, snapshot, change.key ?? change.operation, (ctx, key) =>
    applyNote(ctx, { ...change, key }), options);
}

export function saveNoteReviews(dir, snapshot, change, resolveEvidence, options = {}) {
  return changeNoteHistory(dir, snapshot, change.operation, (ctx, key) => {
    if (key.kind !== 'operation') throw reviewError('NOTE_REVIEW_INVALID');
    const entry = getNoteEntry(ctx, key);
    if (!entry) throw staleNoteError(inspectNoteHistory({}, key.op));
    return applyNoteReviews(entry, key.op, change, ids => resolveEvidence(ids, key.op));
  }, options);
}

export function acceptNoteHistory(dir, snapshot, { key: input, operation, expectedDigest, stamp }, options = {}) {
  return changeNoteHistory(dir, snapshot, input ?? operation, (ctx, key) => {
    const target = noteKeyLabel(key);
    const entry = getNoteEntry(ctx, key);
    if (entry === undefined) throw noteHistoryError("NOTE_NOT_FOUND", target);
    const history = inspectNoteHistory(entry, target);
    if (history.state === "invalid") throw noteHistoryError("NOTE_HISTORY_INVALID", target, history);
    if (history.review_changed) throw noteHistoryError("NOTE_REVIEW_HISTORY_CHANGED", target, history);
    if (!/^sha256:[a-f0-9]{64}$/.test(expectedDigest ?? "") || history.digest !== expectedDigest)
      throw noteHistoryError("NOTE_DIGEST_CONFLICT", target, history);
    if (!safeNoteAuthor(stamp?.by) || !validNoteDate(stamp?.at)) throw noteHistoryError("NOTE_INPUT_INVALID", target, history);
    if (history.state === "healthy" || (history.state === "empty" && entry.note_integrity))
      return { unchanged: true, history };
    const receipt = { by: stamp.by, at: stamp.at,
      reason: entry.note_integrity ? "baseline_mismatch" : "first_baseline",
      previous_digest: history.baseline_digest, accepted_digest: history.digest };
    baselineNoteHistory(entry, { prior: "unknown", acknowledgements: [...(entry.note_integrity?.acknowledgements ?? []), receipt] });
    return { unchanged: false, acknowledgement: receipt };
  }, options, true);
}

// The session-start index: one line per operation, cheap enough to load in full
// for a large API. Detail is pulled per operation when it is touched.
export function indexOf(ctx, repoRoot) {
  return Object.entries(ctx.operations).map(([op, e]) => ({
    op,
    confidence: confidenceFor(e, repoRoot, ctx.api.contract_digest),
    ...(activeNotes(e)?.length ? { gotchas: activeNotes(e).length } : {}),
    ...(e.effect && e.effect !== "read" ? { effect: e.effect } : {}),
  }));
}

// --- learning --------------------------------------------------------------

// Bounded, like the client's shapeOf. Adversarial pass 2026-08-15: this was
// unbounded and blew the stack on a deeply-nested response — a real API can
// return one, and shapeHash runs on every response the drift detector sees, so
// an uncapped recursion is a crash a hostile or merely verbose server can
// trigger. Depth is capped; beyond it the shape is summarised, not descended.
const SHAPE_MAX_DEPTH = 8;
export const shapeOf = (v, depth = 0) => {
  if (depth >= SHAPE_MAX_DEPTH) return "…";
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : [];
  if (v === null) return "null";
  if (typeof v !== "object") return typeof v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x, depth + 1)]));
};

export const shapeHash = (body) => sha(JSON.stringify(shapeOf(body)));

const COLLECTION_KEYS = ["results", "data", "items", "records", "entries", "content"];
export function rowsOf(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object")
    for (const k of COLLECTION_KEYS) if (Array.isArray(body[k])) return body[k];
  return null;
}

// One executed response, reduced to the observation the promotion boundary
// reads: a representative sample row and the per-field values gathered across
// every row of a collection. Factored so learnFromResponse and promotionPreview
// share ONE extraction — the dry-run preview must show exactly what a real learn
// would write, and two copies of this logic is exactly how they would diverge.
function observationOf(body) {
  const rows = rowsOf(body);
  const sample = rows?.[0] ?? body;
  const fieldValues = {};
  if (rows && sample && typeof sample === "object")
    for (const k of Object.keys(sample)) fieldValues[k] = rows.map((r) => r?.[k]).filter((v) => v != null);
  else if (sample && typeof sample === "object")
    for (const [k, v] of Object.entries(sample)) if (v != null) fieldValues[k] = [v];
  return { sample, fieldValues };
}

/**
 * What a response WOULD contribute to the committed file: the promoted entry and
 * the refused fields with their reasons. This is the whole of `learn --dry-run`
 * — the same call learnFromResponse makes, but returning the refusal detail the
 * entry format only keeps a count of. Writing nothing is the caller's job; this
 * is pure.
 */
export function promotionPreview({ op, body, status, contract, environment }) {
  const { sample, fieldValues } = observationOf(body);
  return promoteObservation({
    operation: op,
    observed: { shape: sample && typeof sample === "object" ? shapeOf(sample) : {}, fieldValues, statusCodes: [status] },
    contract, environment,
  });
}

/**
 * Turn one executed response into an operation entry, through the promotion
 * boundary. Nothing reaches the file that the boundary did not authorise.
 */
export function learnFromResponse({ op, method, path, body, status, contract, environment,
                                    sourceFile, contractDigest, drift = [], author }) {
  // Defense in depth: a caller cannot turn an HTTP error into verification
  // even if it forgets the client's success/assertion gate.
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    return recordLearnFailure({ source_file: sourceFile ?? null, verified_at: null,
      contract_digest: contractDigest ?? null, shape_hash: null, status_codes: [],
      effect: method === "GET" || method === "HEAD" ? "read" : "write", fields: {} },
      { status, stamp: { ...(author ? { by: author } : {}), at: new Date().toISOString() }, drift });
  }
  const { promoted, refused } = promotionPreview({ op, body, status, contract, environment });

  const notes = drift.map((d) =>
    d.kind === "redirect"
      ? `Documented as ${d.requested}; server responds ${d.status} redirecting to ${d.served}.`
      : `${d.kind}: ${d.requested}`);

  return {
    source_file: sourceFile ?? null,
    // Full ISO, not just the date: freshness compares this against commit
    // times, and a date-only value cannot distinguish a commit made later the
    // same day from one made before the verification.
    verified_at: new Date().toISOString(),
    // WHO confirmed this observation, so a promoted claim carries provenance
    // like a note or verdict does. Only stamped when an author is supplied
    // (the CLI always supplies one); omitted otherwise so pre-provenance
    // entries and callers that don't pass it keep their exact shape.
    ...(author ? { verified_by: author } : {}),
    contract_digest: contractDigest ?? null,
    shape_hash: body === undefined ? null : shapeHash(body),
    status_codes: promoted.status_codes,
    effect: method === "GET" || method === "HEAD" ? "read" : "write",
    fields: promoted.fields,
    ...(notes.length ? { notes } : {}),
    ...(refused.length ? { withheld: refused.length } : {}),
  };
}
