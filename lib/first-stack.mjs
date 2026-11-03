// Choosing a first API stack when setup has no OpenAPI contract.
//
// Without a stack, every api_request stays in private, ignored evidence and
// `note` has nowhere to land, so a first session leaves nothing committable.
// connect creates the first stack from an explicit --base-url, or from the one
// API the code visibly calls. This module only decides; it never writes.
//
// Detection reuses upstreamUrls (lib/audit.mjs), the same scan the consumer
// audit runs. A config-file URL counts only when its line declares a base URL
// or endpoint and the file is not a package manifest: otherwise every
// package.json's repository and homepage links would read as "the API this
// code calls". Only public hosts are ever chosen automatically; loopback,
// private-network, single-label and reserved example hosts are listed as
// candidates, never selected.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { validStackName } from "./stacks.mjs";
import { FEEDBACK_STACK_NAME } from "./brand.mjs";

const MANIFESTS = new Set(["package.json", "composer.json", "pyproject.toml", "Cargo.toml",
  "deno.json", "deno.jsonc", "app.json", "manifest.json", "renovate.json", "lerna.json", "nx.json",
  "vercel.json", "netlify.toml", "fly.toml", "wrangler.toml", "wrangler.json", "wrangler.jsonc"]);
const TOOLING_CONFIG = /^(?:tsconfig|jsconfig|biome|\.eslintrc|\.prettierrc|\.babelrc|turbo|angular|project|composer|\.?markdownlint|\.?vscode)[\w.-]*\.(?:json|jsonc|ya?ml)$/i;
// A declaration line: a key that names a base URL or endpoint, in YAML, JSON,
// TOML or an env file. Never `$schema`, `homepage`, `repository` and friends.
const DECLARATION = /(?:^|["'\s{,_.-])(?:base|api|endpoint|service|server|host|origin|upstream|gateway)[\w.-]*["']?\s*[:=]|_URL["']?\s*[:=]/i;
const NOT_A_DECLARATION = /["']?\$schema["']?\s*:|homepage|repository|bugs|funding|license|documentation|docs_?url/i;

// Hosts whose leftmost label names the application rather than the platform.
const PLATFORM_SUFFIXES = ["herokuapp.com", "vercel.app", "netlify.app", "onrender.com", "fly.dev",
  "workers.dev", "pages.dev", "azurewebsites.net", "cloudfunctions.net", "appspot.com", "run.app",
  "amazonaws.com", "supabase.co", "firebaseio.com", "ngrok.io", "ngrok-free.app", "railway.app"];
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "edu", "or", "ne", "go"]);

/** loopback | private | reserved | public. Only `public` is auto-selected. */
export function hostClass(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0" || /^127\./.test(host))
    return "loopback";
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127))
      return "private";
    return "public";
  }
  if (host.includes(":")) return /^(?:fc|fd|fe80)/.test(host) ? "private" : "public";
  if (!host.includes(".") || /\.(?:local|internal|lan|home\.arpa|corp|intranet)$/.test(host)) return "private";
  if (/(?:^|\.)example\.(?:com|net|org)$/.test(host) || /\.(?:example|test|invalid)$/.test(host)) return "reserved";
  return "public";
}

const CLASS_REASON = {
  loopback: "loopback host; never chosen automatically",
  private: "private-network or single-label host; never chosen automatically",
  reserved: "reserved example domain; never chosen automatically",
};

/** api.stripe.com -> stripe; myapp.herokuapp.com -> myapp; 10.0.0.5 -> api. */
export function stackNameFromHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!/[a-z]/.test(host) || host.includes(":")) return "api";
  let labels = host.split(".");
  const platform = PLATFORM_SUFFIXES.find(suffix => host === suffix || host.endsWith(`.${suffix}`));
  let label;
  if (platform && host !== platform) label = host.slice(0, -platform.length - 1).split(".")[0];
  else {
    if (labels.length > 1) labels = labels.slice(0, -1);                      // drop the TLD
    if (labels.length > 1 && SECOND_LEVEL.has(labels.at(-1))) labels = labels.slice(0, -1); // co.uk
    label = labels.at(-1);
  }
  const name = String(label ?? "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/, "");
  return validStackName(name) && name !== FEEDBACK_STACK_NAME ? name : "api";
}

function lineAt(root, file, line) {
  try { return readFileSync(join(root, file), "utf8").split(/\r?\n/)[line - 1] ?? ""; }
  catch { return ""; }
}

/** Locations that show this code calls the origin, per the rules above. */
function evidence(root, row) {
  return (row.locations ?? []).filter(location => {
    if (location.kind === "request" || location.kind === "binding") return true;
    const name = basename(location.file);
    if (MANIFESTS.has(name) || TOOLING_CONFIG.test(name)) return false;
    const text = lineAt(root, location.file, location.line);
    return DECLARATION.test(text) && !NOT_A_DECLARATION.test(text);
  });
}

/**
 * Decide the first stack from the code's upstream URLs.
 * Returns { selected, candidates }: `selected` is set only when exactly one
 * public origin has calling evidence; `candidates` lists every other origin
 * with a ready `stack add` command and the reason it was not chosen.
 * Names are unique and assigned in origin order, so the result is
 * deterministic for the same tree.
 */
export function detectFirstStack(root, rows, { cli }) {
  const origins = new Map();
  for (const row of rows) {
    let url;
    try { url = new URL(row.url); } catch { continue; }
    if (!["http:", "https:"].includes(url.protocol)) continue;
    const found = evidence(root, row);
    if (!found.length) continue;
    const origin = url.origin;
    const entry = origins.get(origin) ?? { origin, hostname: url.hostname, files: new Set() };
    for (const location of found) entry.files.add(location.file);
    origins.set(origin, entry);
  }
  const used = new Set();
  const unique = base => {
    let name = base, n = 2;
    while (used.has(name)) name = `${base}-${n++}`.slice(0, 63);
    used.add(name);
    return name;
  };
  const all = [...origins.values()].sort((a, b) => a.origin.localeCompare(b.origin)).map(entry => {
    const klass = hostClass(entry.hostname);
    const stack = unique(stackNameFromHost(entry.hostname));
    const file = [...entry.files].sort()[0];
    return { stack, base_url: entry.origin, file, host_class: klass,
      command: `${cli} stack add ${stack} --base-url ${entry.origin}`,
      ...(klass === "public" ? {} : { reason: CLASS_REASON[klass] }) };
  });
  const selectable = all.filter(row => row.host_class === "public");
  if (selectable.length === 1) {
    const [selected] = selectable;
    return { selected, candidates: all.filter(row => row !== selected) };
  }
  return { selected: null,
    candidates: all.map(row => row.host_class === "public" && selectable.length > 1
      ? { ...row, reason: "more than one API is called; choose one" } : row) };
}
