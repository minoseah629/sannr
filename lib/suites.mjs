import { LAYOUT, ensureLayout } from './layout.mjs';
// Saved request suites — the "collection" (T1).
//
// Postman's durable idea was not the request builder, it was the SAVED
// collection: a named set of requests-with-checks that a team keeps, diffs,
// and re-runs. This client could already run a request or a batch with
// `expect` assertions, but nothing persisted: every re-check
// re-typed the envelope, and "what should be true of this API" lived in
// scrollback instead of git.
//
// A suite is deliberately NOT a new format. It is the standard request envelope's
// `requests` array — the exact request+expect shape runEnvelope already
// accepts, capture/wait_for/upstream included — with a name on top, stored
// one file per suite under api-suites/<name>.json. Running a suite IS
// runEnvelope; there is no second executor to drift from the first.
//
// Three properties the file format holds:
//   1. Committed and human-diffable: canonical key order, so re-saving the
//      same suite is a zero-line diff and review reads requests, not churn.
//   2. Assertions are mandatory per step. A suite with no `expect` is green
//      whatever the API does — confident output not backed by a claim, the
//      exact failure this tool exists to kill.
//   3. Shape only, never credentials. Auth is env-var-referenced (API_AUTH,
//      hosts map) and applied at run time; a literal secret in the file would
//      be permanent and in every clone, so it is refused at save time with
//      the same guard posture as note/verdict/curl.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { unsafePattern } from "./assertions.mjs";
import { join, basename, resolve, relative, sep } from "node:path";
import { ENVELOPE_VERSION } from "./assertions.mjs";
import { secretIn } from "./verdicts.mjs";
import { parseAuthReference } from './auth-reference.mjs';
import { SECRET_HEADERS, CREDENTIAL_SHAPED_HEADER, SECRET_PARAMS } from "./curl.mjs";
import { payloadCredentialProblem } from "./protocol-credentials.mjs";

export const SUITE_DIR = LAYOUT.suites;

// The name becomes a filename, so it is validated as an identifier, never as a
// path: "../escape" would write outside the suites directory, and a name with
// a slash would silently nest. A slug also keeps `suite run <name>` typeable.
const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// These import artifacts share the suite directory, but they are not executable
// suites. Reserve their exact suffixes so an authored suite cannot disappear
// from discovery or replace an import's metadata. Do not inspect file contents
// during discovery: a damaged real suite must still produce a named failure.
const METADATA_NAME = /\.(?:todo|provenance|environment-facts|import-losses)$/i;

export function suiteNameProblem(name) {
  if (!NAME_OK.test(name ?? "")) return { code: "SUITE_NAME_INVALID",
    message: `'${name}' is not a usable suite name.`,
    next: `Use letters, digits, dot, dash, underscore — it becomes ${LAYOUT.suites}/<name>.json.` };
  if (METADATA_NAME.test(name)) return { code: "SUITE_NAME_RESERVED",
    message: "This suite name ends with a suffix reserved for import metadata.",
    next: "Choose a name that does not end in .todo, .provenance, .environment-facts or .import-losses." };
  return null;
}

function assertSuiteName(name) {
  const problem = suiteNameProblem(name);
  if (problem) throw Object.assign(new Error(problem.message), { code: problem.code });
}

// --- normalisation ----------------------------------------------------------

// Accept the three things people actually paste — a single request, a bare
// array of requests, or a full envelope — and normalise all of them to the
// envelope form. The suite stores what runEnvelope runs, nothing adapted.
export function normalizeSuite(name, parsed) {
  const problems = [];
  const nameProblem = suiteNameProblem(name);
  if (nameProblem) return { problems: [nameProblem] };

  let requests, on_failure;
  if (Array.isArray(parsed)) requests = parsed;
  else if (parsed && typeof parsed === "object" && Array.isArray(parsed.requests)) {
    requests = parsed.requests;
    on_failure = parsed.on_failure;
  } else if (parsed && typeof parsed === "object" && parsed.path !== undefined)
    requests = [parsed];
  else
    return { problems: [{ code: "SUITE_SHAPE_INVALID",
      message: "Input is not a request, an array of requests, or an envelope with `requests`.",
      next: `Pass e.g. {"method":"GET","path":"/health","expect":[{"status":200}]} or {"v":${ENVELOPE_VERSION},"requests":[…]}.` }] };

  if (!requests.length)
    return { problems: [{ code: "SUITE_EMPTY", message: "A suite needs at least one request.",
      next: "Add a request with an expect block." }] };

  if (parsed?.finally !== undefined && (!Array.isArray(parsed.finally) || parsed.finally.some(req => !req || typeof req !== 'object' || Array.isArray(req))))
    return { problems: [{ code: 'SUITE_SHAPE_INVALID', message: 'finally must be an array of request objects.' }] };
  for (const input of [parsed, ...requests, ...(parsed?.finally ?? [])]) {
    if (input?.reveal_secrets !== undefined && typeof input.reveal_secrets !== 'boolean')
      problems.push({ code: 'REVEAL_SECRETS_INVALID', message: 'reveal_secrets must be a boolean.' });
  }
  [...requests, ...(parsed?.finally ?? [])].forEach((req, i) => {
    const label = req?.id ? `'${req.id}'` : `#${i + 1}`;
    if (!req || typeof req !== "object" || typeof req.path !== "string" || !req.path)
      problems.push({ code: "SUITE_STEP_INVALID",
        message: `Step ${label} has no path.`,
        next: "Every step is a request envelope: it needs at least a path." });
    // A step that asserts nothing passes whatever the API returns. Refusing it
    // here is what makes `suite run` a claim rather than a mood: re-running a
    // suite must be able to FAIL, or green means nothing.
    else if (!Array.isArray(req.expect) || !req.expect.length)
      problems.push({ code: "SUITE_STEP_WITHOUT_EXPECT",
        message: `Step ${label} (${req.method ?? "GET"} ${req.path}) carries no expect assertions.`,
        next: 'Add expect, e.g. [{"status":200},{"json":"state","equals":"done"}]. ' +
              "A suite exists to re-check claims; a step with none cannot fail and proves nothing." });
    // A `matches` pattern is compiled by the runner on every execution; the file
    // is committed, so this is where a hand-edited or imported bomb is stopped.
    else for (const clause of req.expect) {
      if (clause && typeof clause === "object" && "matches" in clause) {
        const why = unsafePattern(clause.matches);
        if (why) problems.push({ code: "SUITE_PATTERN_REFUSED",
          message: `Step ${label} carries a matches pattern that ${why}.`,
          next: "Use a bounded pattern without nested quantifiers, or a literal equals / exists check." });
      }
    }
  });
  if (problems.length) return { problems };

  return { suite: {
    v: ENVELOPE_VERSION,
    name,
    ...(parsed && !Array.isArray(parsed) && Array.isArray(parsed.requests)
      ? Object.fromEntries(['stack', 'environment', 'upstream'].filter(key => parsed[key] !== undefined).map(key => [key, parsed[key]])) : {}),
    // A collection reports every step's state. The envelope's default (stop)
    // is right for workflows, wrong for suites: stopping at the first red
    // turns one failure into N unknowns. An explicit stop is preserved —
    // capture chains where step 2 is meaningless after step 1 fails are real.
    on_failure: on_failure === "stop" ? "stop" : "continue",
    requests,
    ...(parsed?.finally !== undefined ? { finally: parsed.finally } : {}),
    ...(parsed?.reveal_captures !== undefined ? { reveal_captures: parsed.reveal_captures } : {}),
    ...(parsed?.reveal_secrets !== undefined ? { reveal_secrets: parsed.reveal_secrets } : {}),
  }, problems: [] };
}

// --- secret guard -----------------------------------------------------------
// Everything in the file is committed, so every string in it is a door. Three
// layers, most specific first, all imported from the guards that already
// exist — a second list would drift from the first:
//   - header NAMES that carry credentials (curl's list + shaped-name test),
//     refused whatever the value, because the fix is the same either way:
//     reference the credential by env var, not by value;
//   - query/param NAMES that carry credentials, same reasoning;
//   - any string VALUE anywhere that looks like a secret (verdicts' shapes).
export function suiteSecretProblems(suite) {
  const problems = [];
  const refusedPayloads = new Set();
  const hit = (where, what, fix) => problems.push({ where, what, fix });

  [...suite.requests, ...(suite.finally ?? [])].forEach((req, i) => {
    const payloadProblem = payloadCredentialProblem(req);
    if (payloadProblem) {
      // A rejected payload cannot supply any diagnostic text, including its
      // keys or step identity. Keep the bounded public-client boundary here
      // too, before either serializing the suite or walking string values.
      hit(`step #${i + 1} protocol payload`, payloadProblem === "CREDENTIAL_IN_REQUEST"
        ? "a literal credential" : "an unsupported or unbounded payload",
      "Use bounded plain JSON without credential-named fields; configure auth with an environment-variable reference.");
      refusedPayloads.add(req);
      return;
    }
    const label = req.id ? `step '${req.id}'` : `step #${i + 1}`;
    for (const h of Object.keys(req.headers ?? {}))
      if (SECRET_HEADERS.test(h) || CREDENTIAL_SHAPED_HEADER.test(h))
        hit(`${label} header '${h}'`, "a literal credential",
          "Remove it; configure auth as an environment reference (API_AUTH=bearer:ENV_VAR " +
          "or a hosts entry) and the client attaches it at run time.");
    for (const p of Object.keys(req.params ?? {}))
      if (SECRET_PARAMS.test(p))
        hit(`${label} query parameter '${p}'`, "a credential-named parameter",
          "Use API_AUTH=query:param:ENV_VAR so the value is resolved at run time, never stored.");
  });

  // The value scan walks the WHOLE suite — body, params, paths, notes, ids —
  // because a token is a token wherever it sits. Keys are scanned too: the
  // note guard's red-team found the un-scanned argument is always the door.
  const walk = (node, where) => {
    if (refusedPayloads.has(node)) return;
    if (typeof node === "string") {
      // Imported auth metadata is a named reference, not a credential value.
      // Only the top-level step field is exempt; nested payloads/prose are not.
      const typedAuth = /^(?:requests|finally)\[\d+\]\.auth$/.test(where);
      const referenceProblem = typedAuth ? secretIn(node, { allowAuthReferences: true }) : null;
      if (typedAuth && parseAuthReference(node, { prose: true }) && !referenceProblem) return;
      const what = referenceProblem || secretIn(node);
      if (what) hit(where, what,
        "Describe the request by SHAPE and reference secrets by environment variable name.");
      return;
    }
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${where}[${i}]`));
    if (node && typeof node === "object")
      for (const [k, v] of Object.entries(node)) {
        const kWhat = secretIn(k);
        if (kWhat) hit(`${where}.${k.slice(0, 40)} (key)`, kWhat,
          "Remove the secret from the key.");
        walk(v, `${where}.${k}`);
      }
  };
  walk(suite.requests, "requests");
  if (suite.finally) walk(suite.finally, "finally");
  return problems;
}

// --- canonical serialisation ------------------------------------------------
// Git-friendly means byte-stable: the same suite serialises to the same bytes
// whatever key order the input arrived in, so a no-op re-save is a no-op diff.
// Known keys come in a fixed reading order (identity, target, inputs, flow,
// checks); unknown keys survive, sorted, rather than being dropped — the
// client ignores what it does not know, and a file format that silently eats
// fields punishes forward compatibility.
const SUITE_KEYS = ["v", "name", "description", "stack", "environment", "upstream", "on_failure", "reveal_captures", "reveal_secrets", "requests", "finally"];
const STEP_KEYS = ["id", "protocol", "method", "path", "stack", "environment", "upstream", "graphql", "rpc", "grpc", "websocket", "timeout_ms", "params", "headers",
  "body", "body_type", "files", "fields", "paginate", "idempotency_key",
  "wait_for", "capture", "reveal_secrets", "expect"];
// A clause reads selector-then-operator ({"json":"state","equals":"done"}),
// and wait_for reads condition-then-knobs. Without this the clause keys keep
// whatever order the agent typed, and two saves of the same assertion diff.
const CLAUSE_KEYS = ["status", "header", "json", "equals", "not_equals",
  "exists", "in", "matches", "type", "gt", "lt", "length"];
const WAIT_KEYS = ["json", "equals", "in", "exists", "timeout_ms", "interval_ms"];

const ordered = (obj, order) => {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const rest = Object.keys(obj).filter((k) => !order.includes(k)).sort();
  return Object.fromEntries([...order, ...rest]
    .filter((k) => obj[k] !== undefined)
    .map((k) => [k, obj[k]]));
};

// Flat name->value maps where order carries no meaning sort alphabetically;
// the body is preserved as given, because it is the caller's payload, not ours.
const sorted = (obj) => obj && typeof obj === "object" && !Array.isArray(obj)
  ? Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a < b ? -1 : 1)) : obj;

export function serializeSuite(suite) {
  const out = ordered(suite, SUITE_KEYS);
  const serializeSteps = requests => requests.map((r) => {
    const step = ordered(r, STEP_KEYS);
    for (const k of ["params", "headers", "capture", "files"])
      if (step[k] !== undefined) step[k] = sorted(step[k]);
    if (step.wait_for !== undefined) step.wait_for = ordered(step.wait_for, WAIT_KEYS);
    if (Array.isArray(step.expect)) step.expect = step.expect.map((c) => ordered(c, CLAUSE_KEYS));
    return step;
  });
  out.requests = serializeSteps(suite.requests);
  if (suite.finally) out.finally = serializeSteps(suite.finally);
  // Two-space indent and a trailing newline: the same shape saveContext gives
  // sannr.json, so the two committed files diff alike.
  return `${JSON.stringify(out, null, 2)}\n`;
}

// --- storage ----------------------------------------------------------------

export const suitePath = (root, name) => join(root, SUITE_DIR, `${name}.json`);

export function saveSuite(root, suite) {
  assertSuiteName(suite.name);
  ensureLayout(root);
  const dir = join(root, SUITE_DIR);
  const check = (target) => {
    const base = resolve(root), dest = resolve(target);
    if (dest !== base && !dest.startsWith(`${base}${sep}`)) throw new Error(`${target} resolves outside the project root`);
    let current = base;
    for (const part of relative(base, dest).split(sep).filter(Boolean)) {
      current = join(current, part);
      try { const st = lstatSync(current); if (st.isSymbolicLink() || (!st.isDirectory() && st.nlink !== 1)) throw new Error(`${current} is not a safe project path`); }
      catch (e) { if (e.code !== "ENOENT") throw e; }
    }
  };
  check(dir); check(suitePath(root, suite.name));
  mkdirSync(dir, { recursive: true });
  const file = suitePath(root, suite.name);
  writeFileSync(file, serializeSuite(suite));
  return file;
}

export function listSuites(root) {
  const dir = join(root, SUITE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json") && !METADATA_NAME.test(basename(f, ".json")))
    .map((f) => basename(f, ".json")).sort();
}

/** Load one suite. Throws with a named code so the CLI can die usefully. */
export function loadSuite(root, name) {
  assertSuiteName(name);
  const file = suitePath(root, name);
  if (!existsSync(file)) {
    const err = new Error(`No suite '${name}' in ${SUITE_DIR}/.`);
    err.code = "SUITE_NOT_FOUND";
    err.available = listSuites(root);
    throw err;
  }
  let suite;
  try { suite = JSON.parse(readFileSync(file, "utf8")); }
  catch (e) {
    const err = new Error(`${file} is not parseable JSON: ${e.message}`);
    err.code = "SUITE_CORRUPT";
    throw err;
  }
  // save wrote a validated shape, but the file is hand-editable and git-merged,
  // so run re-checks it: parseable-but-wrong must die the same named death as
  // unparseable, not crash suiteReport on `.map is not a function`. An EMPTY
  // requests array loads fine — the run reports it red with the envelope's own
  // EMPTY_ENVELOPE, which tells the reader more than "corrupt" would.
  if (!suite || typeof suite !== "object" || !Array.isArray(suite.requests)
      || suite.requests.some((r) => !r || typeof r !== "object" || Array.isArray(r))
      || (suite.finally !== undefined && (!Array.isArray(suite.finally) || suite.finally.some(r => !r || typeof r !== "object" || Array.isArray(r))))) {
    const err = new Error(`${file} parses but is not a suite: \`requests\` must be an array of request objects.`);
    err.code = "SUITE_CORRUPT";
    throw err;
  }
  // A `matches` pattern is compiled by the runner; the file is hand-editable, so
  // a bomb is refused HERE, before a single request is sent — not discovered
  // when the first response arrives.
  [...suite.requests, ...(suite.finally ?? [])].forEach((r, i) => {
    for (const clause of Array.isArray(r.expect) ? r.expect : []) {
      if (!clause || typeof clause !== "object" || !("matches" in clause)) continue;
      const why = unsafePattern(clause.matches);
      if (why) {
        const err = new Error(`${file}: step ${r.id ? `'${r.id}'` : `#${i + 1}`} carries a matches pattern that ${why}; refusing to run it.`);
        err.code = "SUITE_PATTERN_REFUSED";
        throw err;
      }
    }
  });
  return { file, suite };
}

// --- run report -------------------------------------------------------------
// The envelope result already carries everything a report needs (per-step ok,
// assertion failures with expected/actual, error codes); this reshapes it for
// reading. Kept here rather than in the CLI so the JSON report and the human
// report are two renderings of ONE reduction — the adapter-drift lesson from
// client.mjs applies to reports too.
export function suiteReport(suite, envelopeResult) {
  const steps = [...suite.requests.map((req, i) => ({ req, i, r: envelopeResult.results[i] })),
    ...(suite.finally ?? []).map((req, i) => ({ req, i, r: envelopeResult.finally?.[i], phase: 'finally' }))].map(({ req, i, r, phase }) => {
    const step = {
      id: req.id ?? String(i + 1),
      ...(phase ? { phase } : {}),
      op: `${(req.method ?? "GET").toUpperCase()} ${req.path}`,
      // A step the run never reached (on_failure: stop) is not a pass and not
      // a fail; calling it either would be a claim nothing checked.
      ok: r ? r.ok : null,
      checks: Array.isArray(req.expect) ? req.expect.length : 0,
    };
    if (r && !r.ok) {
      if (r.assertions?.failures?.length) step.failures = r.assertions.failures;
      if (r.error) step.error = { code: r.error.code, message: r.error.message };
      if (!r.assertions?.failures?.length && !r.error)
        step.error = { code: `HTTP_${r.status}`, message: `request returned ${r.status}` };
    }
    return step;
  });
  const ran = steps.filter((s) => s.ok !== null);
  const report = {
    name: suite.name,
    request_attempts: Number.isInteger(envelopeResult.attempted)
      ? envelopeResult.attempted : envelopeResult.results.length,
    // Three ways to be red, checked in the order they hide: an envelope-level
    // error (dead host, unsupported version, no requests) means nothing was
    // verified even when no step individually failed; zero steps can never
    // fail, and a suite that cannot fail passing green is the vacuous-green
    // failure this module's header exists to kill; otherwise every step must
    // have run and passed.
    ok: !envelopeResult.error && steps.length > 0
      && ran.length === steps.length && ran.every((s) => s.ok),
    passed: ran.filter((s) => s.ok).length,
    total: steps.length,
    steps,
    ...(envelopeResult.left_behind ? { left_behind: envelopeResult.left_behind } : {}),
  };
  // The cause must reach the reader: dropping envelopeResult.error here is how
  // "0/3 passed, three 'not run' lines, no explanation" happened.
  if (envelopeResult.error)
    report.error = {
      code: envelopeResult.error.code,
      message: envelopeResult.error.message,
      ...(envelopeResult.error.next ? { next: envelopeResult.error.next } : {}),
    };
  return report;
}
