import { LAYOUT, ensureLayout } from './layout.mjs';
// Audit CI mode: a baseline of accepted findings and the diff against it.
//
// An audit a team runs once decays into a report nobody reads; the version a
// team KEEPS running is the one wired into CI, and CI has exactly one lever —
// the exit code. So the contract is narrow: --baseline writes the accepted
// state to a committed file, --ci exits non-zero ONLY on findings that file
// has never seen. Accepted debt stays visible in the baseline; the build goes
// red only when someone adds to it, which is the Tuesday morning the drift
// actually landed.
//
// Everything here hangs off the finding KEY. It must be stable across runs
// (a sampled id changing between probes must not read as new drift) yet
// discriminating enough that a second schema break on an already-flagged
// operation still goes red — so the key includes the detail with every
// parenthesised aside (sampled ids, live status codes) blanked out.

import {
  accessSync, chmodSync, closeSync, constants, existsSync, lstatSync, openSync, readFileSync, renameSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { canonPath } from "./audit.mjs";
import { CLI_NAME } from "./brand.mjs";
import { secretIn } from "./verdicts.mjs";
import { safeOutputPath } from './output-path.mjs';

export const BASELINE_FILE = LAYOUT.baseline;

// Severity is about blast radius, not certainty — every finding here already
// cleared the zero-false-positive bar. High: the server is lying about its
// surface (schema, missing, erroring) or growing one nobody reviewed. Low:
// the server said "over there" and meant it. Unknown kinds rank medium, never
// low — a future check must not be born silently ignorable.
const RANK = { high: 3, medium: 2, low: 1 };
const KIND_SEVERITY = {
  "schema-mismatch": "high",            // the contract describes a shape the server does not serve
  "missing": "high",                    // documented, and not there
  "erroring": "high",                   // documented, and 5xx
  "request-field-now-required": "high", // an upstream can now reject a consumer that never got a commit
  "redirect": "low",                    // trailing slash, moved prefix: annoying, honest
};

// A shadow route is graded by WHERE it points. An undocumented /tags is drift;
// an undocumented /admin, /internal or /debug route is the finding the audit
// exists to surface, and it must never share a severity with a slash redirect.
const SENSITIVE_ROUTE = /\/(admin|internal|debug|_?private|sudo|impersonat\w*|backdoor)(\/|$)/i;

export function severityFor({ kind, op }) {
  if (kind === "shadow-route") return SENSITIVE_ROUTE.test(op ?? "") ? "high" : "medium";
  return KIND_SEVERITY[kind] ?? "medium";
}

// Parenthesised asides carry the run-volatile part of a detail — "for a listed
// id (abc-1)", "(~12 routes, express)" — while the discriminating part (which
// field, which status family, which target path) sits outside them.
const normDetail = (d) => String(d ?? "").replace(/\([^)]*\)/g, "()");

const record = (service, kind, op, detail, where = null) => ({
  key: `${service} | ${kind} | ${op ?? ""} | ${normDetail(detail)}`,
  severity: severityFor({ kind, op }), service, kind,
  ...(op ? { op } : {}), ...(detail ? { detail } : {}), ...(where ? { where } : {}),
});

const bySeverity = (a, b) => (RANK[b.severity] - RANK[a.severity])
  || a.service.localeCompare(b.service) || a.key.localeCompare(b.key);

/**
 * Flatten one audit run into the ranked finding records the baseline and the
 * diff both speak. Everything the audit would page a human for is here: probe
 * findings, non-infra shadow routes, platform inconsistencies, and services
 * with routes but no contract (a NEW spec-less service is drift too).
 */
export function ciFindings(results, platform = []) {
  const out = new Map();   // key -> record; identical findings collapse, first wins
  const add = (r) => { if (!out.has(r.key)) out.set(r.key, r); };
  for (const r of results) {
    for (const f of r.findings ?? []) add(record(r.name, f.kind, f.op, f.detail,
      f.file ? `${r.name}: ${f.file}` : r.name));
    for (const s of (r.shadowRoutes ?? []).filter((s) => !s.infra))
      add(record(r.name, "shadow-route", `${s.method} ${canonPath(s.path)}`,
        `live route (${s.file}) the contract never declares`, `${r.name}: ${s.file}`));
    if (r.kind === "undocumented")
      add(record(r.name, "undocumented-service", null,
        `routes but no contract (~${r.routes} routes, ${r.framework})`, r.name));
  }
  for (const p of platform)
    add(record("platform", "platform-inconsistency", p.dimension, p.detail, "platform"));
  return [...out.values()].sort(bySeverity);
}

// GitHub renders step summaries as GFM, so a value that is structurally safe
// still must not be allowed to open a cell, inject HTML, or start emphasis.
// Secret-shaped values are withheld whole: partial redaction risks leaving the
// valuable half of a token while pretending the row is safe.
export function summaryCell(value, fallback = "—") {
  const raw = String(value ?? fallback);
  if (secretIn(raw)) return "[withheld]";
  return raw.replaceAll("&", "&amp;")
    .replaceAll("#", "&#35;")
    .replaceAll("\\", "&#92;")
    .replaceAll("|", "&#124;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("`", "&#96;").replaceAll("*", "&#42;")
    .replaceAll("_", "&#95;").replaceAll("[", "&#91;").replaceAll("]", "&#93;")
    .replaceAll("!", "&#33;").replaceAll("~", "&#126;")
    .replace(/[\r\n]+/g, " ").trim() || fallback;
}

function findingTable(title, rows) {
  const lines = [`### ${title}`, "", "| Operation | Kind | Where |", "| --- | --- | --- |"];
  if (!rows.length) lines.push("| — | — | — |");
  else for (const row of rows)
    lines.push(`| ${summaryCell(row.op)} | ${summaryCell(row.kind)} | ` +
      `${summaryCell(row.where ?? row.service)} |`);
  return lines;
}

/** Render only promoted finding identity and mechanically graded freshness.
 * Finding detail/evidence is intentionally not accepted by any cell renderer.
 * A final whole-document secret scan is the second, independent lock. */
export function renderCiSummary({ added = [], resolved = [], unchanged = 0,
  freshness = [], reportOnly = false, baselineGeneratedAt = null,
  noExecute = false, cli = CLI_NAME, mcp = null } = {}) {
  const attention = freshness.filter((row) =>
    ["suspect", "unverified", "age-stale"].includes(row.state));
  const lines = [
    "## API audit CI summary", "",
    `**Mode:** ${reportOnly ? "report-only" : "enforcing"}`,
    `**Baseline:** ${summaryCell(baselineGeneratedAt ?? "undated")}`,
    `**Result:** ${added.length} new, ${resolved.length} resolved, ${unchanged} accepted unchanged.`, "",
    ...findingTable("New findings", added), "",
    ...findingTable("Resolved since baseline", resolved), "",
    "### Local repair loop", "",
    "Fix code/spec locally, then regenerate and review the accepted state with:", "",
    `\`${summaryCell(cli)} audit . --baseline --no-execute\``, "",
    "Then verify the enforcing gate with:", "",
    `\`${summaryCell(cli)} audit . --ci --no-execute\``, "",
    "## Freshness", "",
    `${attention.length} stale or unverified claim${attention.length === 1 ? "" : "s"} need attention.`, "",
    "| Operation | State | Why | Where |", "| --- | --- | --- | --- |",
  ];
  if (!attention.length) lines.push("| — | current | — | — |");
  else for (const row of attention)
    lines.push(`| ${summaryCell(row.op)} | ${summaryCell(row.state)} | ` +
      `${summaryCell(row.why)} | ${summaryCell(row.where)} |`);
  if (mcp?.registered) {
    lines.push("", "## MCP declaration witness", "",
      `**Baseline:** ${summaryCell(mcp.baseline)}`,
      `${mcp.checked} registered servers compared; ${mcp.drift.length} declaration changes; ${mcp.coverage_gaps.length} named coverage gaps.`, "",
      "Enumeration only; no tools were called. Hint annotations are server claims, not proof of safety.", "",
      "| Server | Tool | Change | Declaration evidence | Registration |", "| --- | --- | --- | --- | --- |");
    if (!mcp.drift.length) lines.push(`| — | — | ${mcp.coverage_gaps.length ? "no comparable declaration drift; coverage incomplete" : "no declaration drift"} | — | — |`);
    for (const row of mcp.drift) lines.push(`| ${summaryCell(row.server)} | ${summaryCell(row.op)} | ${summaryCell(row.kind)} | ${summaryCell(row.detail)} | ${summaryCell(row.file)} |`);
    lines.push("", "### MCP coverage gaps", "", "| Server | Reason | Evidence | Registration |", "| --- | --- | --- | --- |");
    if (!mcp.coverage_gaps.length) lines.push("| — | none | — | — |");
    for (const row of mcp.coverage_gaps) lines.push(`| ${summaryCell(row.server)} | ${summaryCell(row.code)} | ${summaryCell(row.reason)} | ${summaryCell(row.file)} |`);
    lines.push("", `Coverage gaps do not fail the gate. Review changed declarations locally with \`${summaryCell(cli)} mcp inspect\`, then commit the accepted record; CI never rewrites it.`);
  }
  if (noExecute) lines.push("", mcp?.registered
    ? "No HTTP API requests were executed; MCP servers were enumerated without tool execution."
    : "No API requests were executed; freshness was graded from the store, contract, and git history only.");
  lines.push("");
  const rendered = lines.join("\n");
  const secret = secretIn(rendered);
  if (secret) throw Object.assign(new Error(`CI summary refused ${secret}.`),
    { code: "SUMMARY_SECRET_REFUSED", reason: secret });
  return rendered;
}

/** Append one separated summary section transactionally. Replacing the file
 * with prefix+section from a same-directory temporary preserves the old bytes
 * on every pre-rename failure, unlike a partially successful append write. */
export function appendCiSummary(path, section) {
  safeOutputPath(path);
  const parent = dirname(path);
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory()) throw new Error(`${parent} is not a directory`);
  let before = Buffer.alloc(0), mode = 0o666;
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error(`${path} is not a regular file`);
    // A same-directory rename can replace a read-only file whenever its parent
    // is writable. Preserve ordinary append semantics before using the atomic
    // replacement strategy, including under privileged test runners whose
    // access(2) result alone could ignore the file's mode bits.
    if ((stat.mode & 0o222) === 0)
      throw new Error(`${path} is not writable`);
    accessSync(path, constants.W_OK);
    before = readFileSync(path);
    mode = stat.mode & 0o777;
  }
  const separator = before.length === 0 ? ""
    : before.toString("utf8").endsWith("\n\n") ? ""
      : before.toString("utf8").endsWith("\n") ? "\n" : "\n\n";
  const next = Buffer.concat([before, Buffer.from(separator), Buffer.from(section)]);
  const temp = join(parent, `.${basename(path)}.tmp-${process.pid}-${Date.now()}`);
  let owned = false;
  try {
    const fd = openSync(temp, 'wx', mode);
    owned = true;
    try { writeFileSync(fd, next); } finally { closeSync(fd); }
    chmodSync(temp, mode);
    renameSync(temp, path);
  } catch (error) {
    if (owned) try { unlinkSync(temp); } catch { /* absent or already renamed */ }
    throw error;
  }
}

/**
 * Current findings against the accepted baseline. `added` is what fails the
 * build; `resolved` is reported (never fatal) so the team knows to re-cut the
 * baseline rather than carry entries for findings that no longer exist.
 */
export function diffBaseline(current, baseline) {
  const accepted = new Set((baseline.findings ?? []).map((f) => f.key));
  const live = new Set(current.map((f) => f.key));
  const added = current.filter((f) => !accepted.has(f.key));
  const resolved = (baseline.findings ?? []).filter((f) => !live.has(f.key)).sort(bySeverity);
  return { added, resolved, unchanged: current.length - added.length };
}

// The baseline is a committed file, so it is written the way a reviewer wants
// to diff it: versioned, dated, sorted by severity, one finding per line-ish.
export function writeBaselineFile(root, records) {
  ensureLayout(root);
  const path = join(root, BASELINE_FILE);
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}`);
  try {
    const current = lstatSync(path);
    if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1)
      throw new Error(`${path} is not a safe project path`);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  writeFileSync(temp, JSON.stringify({
    version: 1,
    generated_at: new Date().toISOString().slice(0, 10),
    findings: records,
  }, null, 1) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(temp, path);
  return path;
}

/**
 * null when no baseline exists — a state the CLI names, not an empty diff.
 * PRESENT-but-unusable is a different state again: absent means "nothing
 * accepted yet", corrupt means the accepted state is GONE, and a diff against
 * garbage must never pick the exit code (a `{}` baseline would grade every
 * accepted finding as new drift). So a file that will not read, will not
 * parse, or parses into something this tool never wrote throws a NAMED error
 * carrying the path and the why — the CLI turns it into next steps.
 */
export function readBaselineFile(root) {
  const path = join(root, BASELINE_FILE);
  if (!existsSync(path)) return null;
  const corrupt = (why) => Object.assign(new Error(`${path}: ${why}`),
    { code: "BASELINE_CORRUPT", path, reason: why });
  let doc;
  try { doc = JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { throw corrupt(e.message); }
  if (typeof doc !== "object" || doc === null || !Array.isArray(doc.findings))
    throw corrupt("parses, but has no findings array — not a baseline this tool wrote");
  return doc;
}
