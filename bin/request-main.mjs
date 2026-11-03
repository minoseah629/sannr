#!/usr/bin/env node
// Terminal adapter. Humans read this one, so it pretty-prints — which is
// exactly the divergence that used to be a bug when the MCP path did the same
// thing silently. Here the choice is explicit and local to the human surface;
// the budget is measured on the compact form the agent actually receives.

import { basename } from "node:path";
import { apiRequest, apiReadProbe, runEnvelope, tokens, transportError } from "../lib/client.mjs";
import { stackCatalog } from "../lib/stacks.mjs";
import { resolveConfig } from "../lib/config.mjs";
import { PRODUCT } from "../lib/brand.mjs";
import { usageLogPath } from "../lib/machine-state.mjs";
import { readUsageSources } from "../lib/feedback.mjs";

// --report: aggregate the usage log into the produce-vs-consume answer.
if (process.argv[2] === "--report" && !process.argv.slice(3).some(value => value === "--body" || value.startsWith("--body="))) {
  const { rows, logs } = readUsageSources();
  if (!logs.length) {
    console.log(`no readable usage log yet at ${usageLogPath()}`);
    process.exit(0);
  }
  console.log(`logs (machine-wide rows):\n${logs.map(log => `  ${log.source}: ${log.path} (${log.rows} rows)`).join("\n")}\n`);
  if (!rows.length) { console.log("usage logs are empty"); process.exit(0); }

  const pct = (n, d) => d ? `${Math.round(n / d * 100)}%` : "n/a";
  const tally = (key) => rows.reduce((a, r) => (a[r[key]] = (a[r[key]] ?? 0) + 1, a), {});
  const sorted = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);

  console.log(`${rows.length} calls  ${rows[0].ts.slice(0, 10)} .. ${rows.at(-1).ts.slice(0, 10)}`);

  console.log("=== origin: where API work actually goes ===");
  for (const [k, n] of sorted(tally("origin")))
    console.log(`  ${k.padEnd(7)} ${String(n).padStart(5)}  ${pct(n, rows.length).padStart(4)}`);
  const own = rows.filter((r) => r.origin === "own").length;
  console.log(`\n  own-vs-external split: ${pct(own, rows.length)} / ${pct(rows.length - own, rows.length)}`);

  console.log("\n=== by project ===");
  for (const [k, n] of sorted(tally("project")).slice(0, 12)) {
    const sub = rows.filter((r) => r.project === k);
    const o = sub.filter((r) => r.origin === "own").length;
    console.log(`  ${k.slice(0, 26).padEnd(28)} ${String(n).padStart(5)} calls   own ${pct(o, sub.length).padStart(4)}`);
  }

  console.log("\n=== top hosts ===");
  for (const [k, n] of sorted(tally("host")).slice(0, 10)) console.log(`  ${String(n).padStart(5)}  ${k}`);

  console.log("\n=== outcomes ===");
  const failed = rows.filter((r) => !r.ok);
  console.log(`  ok ${rows.length - failed.length}   failed ${failed.length}  (${pct(failed.length, rows.length)})`);
  const drifted = rows.filter((r) => r.drift?.length);
  console.log(`  contract drift detected on ${drifted.length} calls (${pct(drifted.length, rows.length)})`);
  for (const [k, n] of sorted(drifted.flatMap((r) => r.drift).reduce((a, d) => (a[d] = (a[d] ?? 0) + 1, a), {})))
    console.log(`    ${k}: ${n}`);

  const saved = rows.reduce((s, r) => s + (r.tokensSaved ?? 0), 0);
  const raw = rows.reduce((s, r) => s + Math.ceil((r.rawBytes ?? 0) / 4), 0);
  console.log("\n=== realized token savings vs returning the raw body ===");
  console.log(`  raw would have been ~${raw.toLocaleString()} tok, envelopes cost ~${(raw - saved).toLocaleString()} tok`);
  console.log(`  saved ~${saved.toLocaleString()} tok  (${pct(saved, raw)})`);
  const losses = rows.filter((r) => (r.tokensSaved ?? 0) < 0);
  console.log(`  calls where the envelope COST more than raw: ${losses.length} (${pct(losses.length, rows.length)})`);
  process.exit(0);
}

// Argument discipline for the low-level binary (2026-09-15, a field report):
// `--help` used to be sent as the HTTP method, so asking for usage produced a
// request. Usage, unknown options, unknown methods and a missing path now end
// here, before anything reaches the wire. Values are never echoed: a path can
// carry a query string, and a query string can carry a credential.
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const BIN = basename(process.argv[1] ?? PRODUCT);
const USAGE = [
  `Usage: ${BIN} <METHOD> <path> [body-json|-] [fields|-] [idempotency-key] [--expect-status <100-599>]`,
  `       ${BIN} <METHOD> <path> --body <json> [--expect-status <100-599>]`,
  `       ${BIN} envelope '<json>'`,
  `       ${BIN} --report`,
  "",
  "METHOD is one of GET, HEAD, POST, PUT, PATCH, DELETE or OPTIONS. The path",
  "starts with / (resolved against the base URL) or is an absolute http(s) URL of",
  "a configured host. Nothing is sent for --help, a missing path, an unknown",
  `option or an unknown method. \`${PRODUCT} request\` wraps this binary.`,
  "",
  "On a fresh unconfigured project, GET https://api.github.com/zen is the built-in",
  "onboarding example: unauthenticated, announced first, with no redirects/retries.",
  "--expect-status adds one explicit assertion; no assertion is assumed by default.",
  "--body <json> (also --body=<json>) supplies the same JSON body as body-json.",
  "Choose the option or a positional body, never both; envelopes declare body inside JSON.",
].join("\n");
const usageError = (code, message) => {
  console.error(JSON.stringify({ error: { code, message, next: `Run: ${BIN} --help` } }, null, 1));
  process.exit(1);
};
let expect, optionBody, stack, environment;
let hasOptionBody = false;
{
  const args = [];
  for (let i = 2; i < process.argv.length; i += 1) {
    const value = process.argv[i];
    const selector = value === '--stack' || value.startsWith('--stack=') ? 'stack'
      : value === '--env' || value.startsWith('--env=') ? 'environment' : null;
    if (selector) {
      const selected = value.includes('=') ? value.slice(value.indexOf('=') + 1) : process.argv[++i];
      if (!selected || selected.startsWith('--') || (selector === 'stack' ? stack !== undefined : environment !== undefined))
        usageError('REQUEST_SELECTOR_INVALID', 'Supply each stack/environment selector once with a name.');
      if (selector === 'stack') stack = selected; else environment = selected;
      continue;
    }
    if (value === "--body" || value.startsWith("--body=")) {
      if (hasOptionBody) usageError("REQUEST_BODY_DUPLICATE", "--body may be specified only once.");
      const raw = value === "--body" ? process.argv[++i] : value.slice("--body=".length);
      if (raw === undefined || raw === "" || raw.startsWith("--"))
        usageError("REQUEST_BODY_REQUIRED", "--body requires one JSON value.");
      try { optionBody = JSON.parse(raw); }
      catch { usageError("REQUEST_BODY_INVALID", "--body must be valid JSON; its value is not displayed."); }
      hasOptionBody = true;
      continue;
    }
    if (value !== "--expect-status" && !value.startsWith("--expect-status=")) { args.push(value); continue; }
    if (expect) usageError("REQUEST_ASSERTION_DUPLICATE", "--expect-status may be specified only once.");
    const status = value === "--expect-status" ? process.argv[++i] : value.slice("--expect-status=".length);
    if (!/^[1-5][0-9]{2}$/.test(status ?? ""))
      usageError("REQUEST_ASSERTION_INVALID", "--expect-status requires one HTTP status from 100 through 599.");
    expect = [{ status: Number(status) }];
  }
  process.argv = [...process.argv.slice(0, 2), ...args];
  if (expect && (!args.length || args[0] === "envelope"))
    usageError("REQUEST_ASSERTION_MODE", "--expect-status belongs to a single METHOD/path request; envelope requests declare their own expect clauses.");
  if (hasOptionBody && (!args.length || args[0] === "envelope" || args[0] === "--report"))
    usageError("REQUEST_BODY_MODE", "--body belongs to a single METHOD/path request; envelope requests declare their own body.");
  if (args.some((value, index) => value.startsWith("--") && !(index === 0 && (value === "--help" || value === "--report"))))
    usageError("REQUEST_OPTION_UNKNOWN", "Unrecognized request option; its value is not displayed.");
  if (hasOptionBody && args[2] !== undefined)
    usageError("REQUEST_BODY_CONFLICT", "Choose --body or a positional body, not both.");
}

// Validate options before this branch: an envelope must never execute while
// silently discarding a body/assertion option from the single-request mode.
if (process.argv[2] === "envelope") {
  let env;
  try { env = JSON.parse(process.argv[3] ?? ""); }
  catch { console.error("envelope must be valid JSON"); process.exit(2); }
  const result = await runEnvelope({ ...env, ...(stack ? { stack } : {}), ...(environment ? { environment } : {}) }, { initiator: 'cli.request' }).catch(error => ({ ok: false, error: transportError(error) }));
  const out = JSON.stringify(result, null, 1);
  console.log(out);
  console.error(`\n--- ${out.length} bytes (~${tokens(out)} tokens)`);
  process.exitCode = result.ok === false || result.error ? 1 : 0;
}
else {
  const first = process.argv[2], pathArg = process.argv[3];
  if (first === "-h" || first === "--help" || first === "help") {
    console.log(USAGE);
    process.exit(0);
  }
  if (first !== undefined) {
    if (first.startsWith("-")) usageError("REQUEST_OPTION_UNKNOWN", "Use --help, --report, --body or --expect-status with a single request.");
    if (!METHODS.has(first.toUpperCase())) usageError("REQUEST_METHOD_INVALID", "The first argument must be an HTTP method: GET, HEAD, POST, PUT, PATCH, DELETE or OPTIONS.");
    if (pathArg === undefined || pathArg === "") usageError("REQUEST_PATH_REQUIRED", "Provide a request path after the method.");
    if (!(pathArg.startsWith("/") || /^https?:\/\//i.test(pathArg))) usageError("REQUEST_PATH_INVALID", "The path must start with / or be an absolute http(s) URL.");
  }
}

if (process.argv[2] && process.argv[2] !== 'envelope') {
  const [, , method, path, rawBody] = process.argv;
  let body = optionBody;
  if (rawBody !== undefined && rawBody !== "-") {
    try { body = JSON.parse(rawBody); }
    catch { console.error(`body is not valid JSON (${Buffer.byteLength(rawBody, "utf8")} bytes)`); process.exit(2); }
  }
  // node server.mjs GET /pieces - title,status
  const fields = process.argv[5] && process.argv[5] !== "-"
    ? process.argv[5].split(",").filter(Boolean) : undefined;
  const idempotency_key = process.argv[6];
  const cfg = stackCatalog(process.env.API_CONTEXT_DIR ?? process.cwd()).stacks.length ? null : resolveConfig();
  // The exact public onboarding example is the only unconfigured-origin
  // exception. Never turn a saved environment, auth reference or contract into
  // a different target, and never generalize this into an arbitrary URL bypass.
  const freshZen = method.toUpperCase() === "GET" && path === "https://api.github.com/zen"
    && !stack && !environment && !hasOptionBody && process.argv.length === 4 && cfg?.baseUrlSource === "fallback" && !cfg.file
    && !cfg.problems.length && !cfg.auth && !cfg.contract
    && process.env.API_BASE_URL === undefined && process.env.API_AUTH === undefined
    && process.env.API_CONTRACT === undefined && process.env.API_CONFIG === undefined
    && process.env.API_ENV === undefined;
  const execute = async () => {
    if (!freshZen) return apiRequest({ method, path, body, fields, idempotency_key, expect, ...(stack ? { stack } : {}), ...(environment ? { environment } : {}) }, { initiator: 'cli.request' });
    const probe = await apiReadProbe({ path, method: "GET", expect, targetSource: "default",
      onRequest: ({ method, url }) => new Promise((resolve, reject) => process.stderr.write(
        `About to request: ${method} ${url} (built-in onboarding example; no credentials, redirects, or retries)\n`,
        error => error ? reject(error) : resolve())),
    }, { initiator: 'cli.request' });
    if (!probe.result) return { ok: false, error: probe.error };
    return { ...probe.result,
      ...(probe.response ? { duration_ms: probe.response.duration_ms, rate_limit_headers: probe.response.rate_limit_headers } : {}),
      onboarding: { purpose: "onboarding", authentication: "not_sent", repo_contract: null,
        observation: probe.result.evidence ? "private-execution-evidence" : "not-recorded",
        shared_context: "not-recorded" },
    };
  };
  execute()
    .catch((error) => ({ error: transportError(error) }))
    .then((r) => {
      const out = JSON.stringify(r, null, 1);
      console.log(out);
      console.error(`\n--- ${out.length} bytes (~${tokens(out)} tokens)`);
      process.exitCode = r.ok === false || r.error ? 1 : 0;
    });
}
