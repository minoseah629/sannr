import { LAYOUT } from './layout.mjs';
// `feedback` — the alpha report an agent assembles and a HUMAN sends.
//
// It never touches the network, and that is a design constraint, not an
// oversight. ALPHA.md tells every tester in its fourth line that this tool
// "phones home" nowhere. Auto-submitting telemetry would break a written
// promise to people who installed a private build into their own repositories
// on trust. The feedback is worth less than the trust.
//
// So the split is: the tool collects the tedious factual half automatically
// (versions, what got wired, what the audit claimed, whether anything actually
// accumulated), leaves the judgement half clearly blank for the agent and the
// human to fill in, writes one file, and tells them where to send it. A human
// who can read the file before sending it is a human who will actually send it.
//
// What it must never collect, because the report leaves their machine:
//   request/response bodies or headers   (that is what evidence/ holds)
//   credentials, or anything from an env file
//   query VALUES (a value can be a token) — key names only
//   file contents, prose from their notes, absolute paths outside the repo
// `--anonymize` goes further and drops service and host names, for a tester
// whose internal architecture is itself sensitive.

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { platform, release } from "node:os";
import { PRODUCT, CONTEXT_BASENAME } from "./brand.mjs";
import { machineStatePaths, usageLogPaths } from "./machine-state.mjs";
import { safeOutputPath } from "./output-path.mjs";
import { redactMetadataSecrets as safeMetadata } from './verdicts.mjs';
import { stackCatalog, stackScope } from './stacks.mjs';
import { withStackScope } from './stack-scope.mjs';
import { loadContext, readContextState } from './context.mjs';
import { evidenceClass, evidenceClassCounts, stackEvidenceClasses } from './evidence-confidence.mjs';

// Feedback inventories all repository stores, independently of request routing
// or environment selection. The packaged stack is not knowledge accumulated by
// this repo. Never fold stores together by operation key: their scopes differ.
export function readFeedbackContexts(root) {
  const catalog = stackCatalog(root);
  if (catalog.problems.length) {
    const problem = catalog.problems[0];
    throw Object.assign(new Error(problem.message), { code: problem.code });
  }
  if (!catalog.stacks.length) {
    const ctx = loadContext(root);
    return { ctx, contexts: null, evidence_classes: stackEvidenceClasses(root, ctx ?? {}).counts };
  }
  const contexts = catalog.stacks.map(row => {
    const store = `${row.relativeFolder}/${CONTEXT_BASENAME}`;
    let result;
    try {
      safeOutputPath(join(root, store));
      result = withStackScope({ root, stack: row.name, contextFile: store }, () => readContextState(root));
    } catch { /* unsafe or unreadable stores must not become a partial total */ }
    if (!result || !['healthy', 'missing'].includes(result.state))
      throw Object.assign(new Error(`Stack '${row.name}' has an unreadable context store; no feedback totals were produced.`),
        { code: 'FEEDBACK_CONTEXT_UNREADABLE' });
    const ctx = result.snapshot?.ctx ?? null;
    const evidence_classes = withStackScope(stackScope(root, { stack: row.name, environment: row.document.default_environment }),
      () => stackEvidenceClasses(root, ctx ?? {}).counts);
    return { stack: row.name, store, state: result.state, ctx, evidence_classes };
  });
  // Receipt counters come from usage. Passing no single context avoids attaching
  // one stack's note prose to another stack's operation in receipt details.
  return { ctx: null, contexts, evidence_classes: Object.fromEntries(Object.keys(evidenceClassCounts([])).map(key =>
    [key, contexts.reduce((n, source) => n + source.evidence_classes[key], 0)])) };
}

/** A stable, non-identifying label for a name we still want to correlate. */
const anon = (s, i) => `svc-${i + 1}`;

// Human-facing dates use this computer's zone. Keep the full UTC instant too:
// truncating a UTC date at midnight can look a day newer than local notes.
function localReportTime(date) {
  const two = value => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ` +
    `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())} ` +
    `${offset < 0 ? '-' : '+'}${two(Math.floor(Math.abs(offset) / 60))}:${two(Math.abs(offset) % 60)}` +
    (zone ? ` (${zone})` : '');
}

/**
 * Assemble the report model. Pure: takes what the caller already gathered so
 * this is testable without a filesystem or a live audit.
 */
export function buildFeedback({ map = null, ctx = null, contexts = null, evidence_classes, receipt = null, usage = [],
                                wired = {}, env = {}, anonymize = false, executed = false,
                                attempted = 0, executionRequested = false,
                                machineWideCalls = null, usageSources = null, now = new Date() } = {}) {
  const services = map?.services ?? [];
  const nameOf = anonymize ? anon : (s) => s.name;

  // Findings by kind and severity: the shape of what we CLAIMED about their
  // repo. This is the half that tells us whether the tool cried wolf, once the
  // tester says which ones were wrong.
  const byKind = {};
  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const s of services) {
    for (const f of s.findings ?? []) {
      byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
      if (f.severity in bySeverity) bySeverity[f.severity] += 1;
    }
    for (const r of s.shadow ?? []) {
      byKind["shadow-route"] = (byKind["shadow-route"] ?? 0) + 1;
      if (r.severity in bySeverity) bySeverity[r.severity] += 1;
    }
  }

  // Did anything ACCUMULATE? The whole thesis in three numbers. An empty file
  // after a week of real use is the single most important result this alpha can
  // return, so it is reported plainly rather than buried.
  const stores = contexts ? contexts.map(source => source.ctx) : [ctx];
  const ops = stores.flatMap(store => Object.values(store?.operations ?? {}));
  const notes = ops.reduce((n, e) => n + (e.notes?.length ?? 0), 0);
  // A raw timestamp cannot prove current verification. CLI callers supply the
  // scoped projection made above; pure callers without evidence conservatively
  // classify their saved entries without inventing assertion or learn support.
  const classes = evidence_classes ?? evidenceClassCounts(ops.map(entry => evidenceClass({ entry, now: now.getTime() })));
  const verdicts = stores.reduce((n, store) => n + Object.keys(store?.verdicts ?? {}).length, 0);

  // Usage: counts and status classes only. No paths, no hosts, no query values.
  const statuses = {};
  let frictionFired = 0;
  for (const r of usage) {
    const cls = `${String(r.status ?? "?")[0]}xx`;
    statuses[cls] = (statuses[cls] ?? 0) + 1;
    if (r.friction) frictionFired += 1;
  }

  return safeMetadata({
    product: PRODUCT,
    generated_at: now.toISOString(),
    generated_local: localReportTime(now),
    environment: {
      platform: platform(), release: release(), node: process.version,
      host_agents_wired: Object.entries(wired).filter(([, v]) => v).map(([k]) => k),
      ...env,
    },
    what_it_found: {
      // Whether the server was asked. Without execution there can be no
      // spec-vs-server disagreement, so an empty findings map means "we did not
      // look", NOT "nothing is wrong" — a distinction the reader must not have
      // to infer from a zero.
      executed_against_a_running_server: executed,
      request_execution_requested: executionRequested,
      request_attempts: attempted,
      services: services.length,
      documented_operations: map?.summary?.operations ?? 0,
      undocumented_routes: map?.summary?.undocumented_routes ?? 0,
      edges: map?.summary?.edges ?? 0,
      external_dependencies: map?.summary?.external ?? 0,
      // Historical count key retained for JSON readers; it never established
      // execution or even that a source URL was used by application code.
      external_dependency_basis: 'unmatched_static_url_reference_hosts',
      findings_by_kind: byKind,
      findings_by_severity: bySeverity,
      service_names: services.map((s, i) => nameOf(s, i)),
    },
    did_anything_accumulate: {
      operations_known: Object.values(classes).reduce((total, count) => total + count, 0),
      evidence_classes: classes,
      verified_by_execution: classes.verified,
      gotchas_written: notes,
      verdicts_recorded: verdicts,
      friction_prompts_fired: frictionFired,
    },
    // Local attribution only; the fixed-shape send projection omits this field.
    ...(contexts ? { context_sources: contexts.map((source, i) => ({
      stack: anonymize ? `stack-${i + 1}` : source.stack,
      store: anonymize ? `${LAYOUT.collection}/stack-${i + 1}/${CONTEXT_BASENAME}` : source.store,
      state: source.state,
    })) } : {}),
    what_it_saved: receipt ? {
      calls: receipt.calls ?? 0,
      tokens_saved: receipt.tokens?.saved ?? 0,
      calls_where_the_envelope_cost_more: receipt.tokens?.calls_where_envelope_cost_more ?? 0,
      gotchas_reused: receipt.gotchas?.notes_delivered ?? 0,
      gotchas_delivered_through_grants: receipt.gotchas?.grant_delivered?.notes_delivered ?? 0,
      // Kind names only. A drift kind is a category we defined; a drift VALUE
      // would be their data.
      drift_calls: receipt.drift?.calls ?? 0,
      drift_kinds: receipt.drift?.kinds ?? {},
      friction_captured: receipt.friction?.captured ?? 0,
    } : null,
    // Both counts scoped to THIS repo by the caller (USAGE_LOG is machine-wide
    // — see receipt.mjs's scopeToProject). machine_wide_calls is the total
    // before scoping, kept ONLY so a reader who knows this tool touches other
    // projects on their machine isn't left wondering where the rest went.
    usage: { calls: usage.length, status_classes: statuses,
      ...(usageSources ? { log_sources: usageSources.map(({ source, rows }) => ({ source, rows })) } : {}),
      ...(machineWideCalls !== null && machineWideCalls > usage.length
        ? { machine_wide_calls: machineWideCalls } : {}) },
  });
}

/** The file a tester reads before sending. Facts on top, judgement below. */
export function renderFeedback(model, { cli = PRODUCT } = {}) {
  const j = (o) => JSON.stringify(o, null, 2);
  const f = model.what_it_found;
  const a = model.did_anything_accumulate;
  return `# ${model.product} — beta feedback

Generated ${model.generated_local ?? `${model.generated_at} (UTC)`}. **Nothing was sent anywhere.** Read this, fill in
the three questions at the bottom, and send the file back however you like.

Stored timestamps ending in Z are UTC; the generation time above names its zone explicitly.

If any line below feels like more than you want to share, delete it. A partial
report is far better than none, and re-running with \`--anonymize\` replaces
service names with svc-1, svc-2, ….

## Environment

\`\`\`json
${j(model.environment)}
\`\`\`

## What the tool claimed about this repo

${f.services} service${f.services === 1 ? "" : "s"}, ${f.documented_operations} documented operation${f.documented_operations === 1 ? "" : "s"}, ${f.undocumented_routes} undocumented route${f.undocumented_routes === 1 ? "" : "s"},
${f.edges} edge${f.edges === 1 ? "" : "s"}, ${f.external_dependencies} external hosts referenced (not confirmed dependencies).

> External counts are distinct hosts in unmatched static URL references, not proof
> that application code calls them. Specs and documentation can contribute references.

\`\`\`json
${j({ findings_by_kind: f.findings_by_kind, findings_by_severity: f.findings_by_severity, service_names: f.service_names })}
\`\`\`
${f.executed_against_a_running_server ? "" : f.request_attempts ? `
> **Requests were attempted, but no server response was received.** So the findings
> above cannot include a live spec-vs-server comparison; the attempted target is
> reported in the environment block.
` : f.request_execution_requested ? `
> **Execution was requested, but this contract has no eligible GET/HEAD operation.**
> No request was sent, so the findings above are static; there is no live
> spec-vs-server comparison to report.
` : `
> **This was a static scan — your server was never contacted.** So the findings
> above cannot include any spec-vs-server disagreement, and an empty list here
> means "not looked for", not "nothing wrong". If your API runs locally and you
> want that half included, re-run as \`${cli} feedback --execute\`; it issues
> GET/HEAD only. GET/HEAD can still incur charges or have side effects.
> Review the provider's behavior before opting in; this command never executes automatically.
`}
## Did anything accumulate

\`\`\`json
${j(a)}
\`\`\`

${model.context_sources ? `> Operation, verification and written-note counts above sum this repo's stack stores.

Stores read (a missing store contributes zero):

${model.context_sources.map(source => `- \`${source.stack}\` — \`${source.store}\` (${source.state})`).join('\n')}
` : "> Operation, verification and written-note counts above describe this repo's context file."}
> Consumer requests do not automatically verify a provider's stored knowledge.
> Evidence classes are exclusive per operation: written, observed, asserted and verified by learn.
> A response without passing assertions is observed, including a failed response; observed is not a success claim.
> Stale or missing evidence cannot support asserted or verified. Written includes records without currently countable execution evidence.

${a.gotchas_written === 0
  ? `> **Zero gotchas written in this repo.** This count excludes notes stored in provider repos.${model.what_it_saved?.gotchas_delivered_through_grants
    ? `\n> The request log records ${model.what_it_saved.gotchas_delivered_through_grants} note delivery event(s) through grants; those notes were available without a local write.`
    : "\n> This alone does not establish whether notes were written or used elsewhere."}\n`
  : `> ${a.gotchas_written} gotcha(s) written. Please paste one or two below if you can; seeing\n> what your agent thought was worth recording is the most useful thing in this file.\n`}
## Response accounting

\`\`\`json
${j(model.what_it_saved ?? "no receipt data yet")}
\`\`\`

> Token figures estimate raw-response versus returned-envelope size using characters / 4.
> They do not measure end-to-end agent token use or time saved. Note delivery counts
> include repeat deliveries; they do not establish that an agent used the notes.

## Usage

${model.usage.log_sources?.length ? "> Log sources below count machine-wide rows before project scoping; current and legacy logs are counted together when both are present. No files are moved.\n\n" : ""}\`\`\`json
${j(model.usage)}
\`\`\`
${model.usage.machine_wide_calls ? `
> Scoped to this repo. This machine has ${model.usage.machine_wide_calls} calls
> total across every project tested here — the rest are not this repo's story.
` : ""}
---

# The three questions (please answer these — the numbers above are the easy half)

**1. Did it cry wolf?** It made specific claims about your repo above. Was any of
them wrong — a route it called undocumented that is documented, a disagreement
that is not real, a dependency you do not have? Name the ones that were wrong.
This is the single most valuable thing you can tell us; a wrong finding matters
far more to us than a right one.

>

**2. Did it tell you anything you did not already know about your own system?**

>

**3. Where did the first ten minutes annoy, confuse, or fail you?**

>

## Optional: what did you want to do and could not?

Not a wishlist. The useful version of this is a moment, not an idea: you went to
do something, the tool could not do it, and you worked around it or gave up.
Say what you were trying to do and what you did instead. The workaround is the
important half — it tells us what the feature is actually competing with.

"I wanted X" without a moment attached is the kind of request that reads well
and builds the wrong thing, so leave this blank rather than filling it. Blank is
a fine answer and a common one.

>

---

_Regenerate any time with \`${cli} feedback\`. Collection stays local. Optional \`feedback --send\` asks first by default; read docs/feedback.md before sending._
`;
}

/** Read all selected logs defensively, without moving state or following links.
 * Sources retain current-first order; rows are chronological across both logs.
 * An explicit path (including an empty disabling override) remains exclusive.
 */
export function readUsageSources(logPath, options = {}) {
  const env = options.env ?? process.env;
  const stateOptions = { ...options, env: logPath == null ? env : { ...env, API_USAGE_LOG: logPath } };
  const paths = machineStatePaths(stateOptions);
  const overridden = stateOptions.env.API_USAGE_LOG !== undefined;
  const logs = [], rows = [];
  for (const path of usageLogPaths(stateOptions)) {
    try {
      safeOutputPath(path);
      const entries = [];
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const row = JSON.parse(line);
          if (row && typeof row === 'object' && !Array.isArray(row)) entries.push(row);
        } catch { /* torn final line */ }
      }
      logs.push({ source: overridden ? 'override'
        : resolve(path) === resolve(paths.usageLog) ? 'current' : 'legacy', path, rows: entries.length });
      rows.push(...entries);
    } catch { /* missing, unsafe or unreadable logs contribute no rows */ }
  }
  const time = row => { const value = Date.parse(row.ts); return Number.isFinite(value) ? value : 0; };
  rows.sort((a, b) => time(a) - time(b));
  return { rows, logs };
}

/** Compatibility reader for callers that only need the recorded rows. */
export function readUsage(logPath, options) {
  return readUsageSources(logPath, options).rows;
}

/** Which host agents this repo is wired into. Presence only, never contents. */
export function wiredHosts(root) {
  return {
    "claude-code": existsSync(join(root, ".mcp.json")),
    codex: existsSync(join(root, ".codex", "config.toml")),
    skills: existsSync(join(root, ".claude", "skills")) || existsSync(join(root, ".agents", "skills")),
  };
}

export const feedbackFilename = (_root) => LAYOUT.feedback;
