// The map (Track A1): the audit's derived graph, rendered for a human.
//
// Everything here is presentation. The audit already derives who calls whom
// (deriveEdges), which live routes no spec declares (shadow routes), who owns
// each service (CODEOWNERS/git), and where contract and server disagree
// (findings). This module never re-derives any of it — a renderer with
// opinions about the data is a second source of truth, and second sources
// drift. It takes the audited results verbatim, grades severity with the SAME
// function the audit and the CI baseline use, and emits three views: a model
// (--json), a terse terminal footprint (--text), and a single self-contained
// HTML file — inline CSS, zero script, zero external requests — that a human
// can open standalone or paste into a channel. The artifact is the GUI seed
// (PRD A1): the "you have a live /admin route in nobody's spec" moment as a
// file, before any app exists.

import { severityFor } from "./ci.mjs";
import { findSurfaces, auditSurface, deriveEdges, baseUrlFor, extractRoutes, upstreamUrls } from "./audit.mjs";
import { platformConsistency } from "./consistency.mjs";
import { CLI_NAME, PRODUCT } from "./brand.mjs";
import { terminalText } from "./terminal.mjs";
import { renderApiMapHtml, renderCodeIndexHtml, API_MAP_CSS } from "./api-map.mjs";
import { reportThemeCss, renderReportTheme } from "./report-theme.mjs";
import { emptyApiDiscoveryNext } from './discovery-guidance.mjs';
import { codeLocations, withCodeLocations } from './code-locations.mjs';

// Mirrors the audit's conventional-endpoint filter: a /health route is
// undocumented by custom, not by mistake, and listing it as a finding buries
// the routes that matter.
const INFRA_ROUTE_RE = /^\/(health|healthz|livez|readyz|ready|live|ping|status|metrics|favicon\.ico|openapi\.(json|ya?ml)|docs|swagger)\/?$/i;

// --- the model -------------------------------------------------------------

const hostOf = (url) => { try { const u = new URL(url); return u.port ? `${u.hostname}:${u.port}` : u.hostname; } catch { return url; } };

// Map timestamps describe when the artifact was generated on the machine
// that produced it. Use the host's local clock rather than UTC so the header
// matches the computer the reader is looking at.
const localTimestamp = (date = new Date()) => {
  const two = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ` +
    `${two(date.getHours())}:${two(date.getMinutes())}`;
};

/**
 * The renderable model, built from audited surfaces + derived edges. Severity
 * is stamped here with the audit's own grader so the three views and the CI
 * baseline can never rank the same finding differently. Shadow routes keep
 * only the non-infra ones (a /health endpoint is undocumented by custom, not
 * by mistake), but the infra count is preserved — excluded and counted, never
 * silently dropped, same policy as everywhere else in the audit.
 */
export function footprintModel({ root, surfaces, edges, external, platform, omissions = [] }) {
  // Node identity is the identity deriveEdges already matches on: the
  // advertised host:port. A real tree holds the same service checked out more
  // than once (a standalone repo AND a monorepo copy), and two directories
  // claiming one live port are one service — drawn once, with every checkout
  // named. A surface advertising no base URL keeps its directory as identity;
  // nothing is merged on a name alone (two unrelated "app" dirs stay two).
  const groups = new Map();
  for (const s of surfaces) {
    const base = s.dir ? baseUrlFor(s.dir) : null;
    const key = base ? `hp:${hostOf(base)}` : `dir:${s.dir ?? s.name}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(s);
  }
  const services = [...groups.values()].map((group) => {
    const s = group[0];
    // The copies were probed against the SAME live server, so identical
    // findings and identical routes are one fact, not one per checkout.
    const routes = new Map();
    for (const g of group)
      for (const r of g.shadowRoutes ?? [])
        routes.set(`${r.method} ${r.path} ${r.file}`, r);
    const shadow = [...routes.values()].filter((r) => !r.infra).map((r) => ({
      method: r.method, path: r.path, file: r.file,
      severity: severityFor({ kind: "shadow-route", op: `${r.method} ${r.path}` }),
    }));
    const findings = new Map();
    for (const g of group)
      for (const f of g.findings ?? [])
        findings.set(`${f.op}|${f.kind}|${f.detail}`,
          { op: f.op, kind: f.kind, detail: f.detail, severity: f.severity ?? severityFor(f) });
    // A service with no contract has no "shadow" routes, because there is no
    // spec for them to hide from. Its routes are simply ALL undocumented, and
    // listing them is the entire value on a repo that has never written a spec.
    const uncontracted = s.kind === "undocumented" && s.dir
      ? extractRoutes(s.dir).filter((r) => !INFRA_ROUTE_RE.test(r.path))
          .map((r) => ({ method: r.method, path: r.path, file: r.file }))
      : [];
    // How much of this service was actually put to the server. The audit
    // already measured it and this model used to drop it, which is why every
    // renderer below could only ever describe the map as finished.
    //
    // Coverage is a ratio, and a ratio whose halves come from different places
    // is not one. The checkouts in a group are one service by advertised
    // host:port, but they are separate directories and CAN carry different
    // contracts (the standalone-repo-and-monorepo-copy case this grouping
    // exists for), so `declared` genuinely differs between them. Taking the
    // widest run for the numerator and the first checkout's `declared` for the
    // denominator produced "5 of 3 documented operations probed" — a ratio
    // above one in the very sentence this is meant to make true. So ONE
    // checkout is the representative — the widest probed run, ties broken by
    // the most declared — and it supplies both halves and the declared count.
    //
    // Only a documented service can carry coverage: an undocumented one has no
    // contract for its routes to be measured against, and calling them
    // "documented operations" is the claim this model must not make.
    const measured = s.kind === "documented"
      ? group.filter((g) => Number.isInteger(g.operations_probed)) : [];
    const representative = measured.reduce((best, g) => !best
      || g.operations_probed > best.operations_probed
      || (g.operations_probed === best.operations_probed && (g.declared ?? 0) > (best.declared ?? 0))
      ? g : best, null);
    const counted = representative ?? s;
    return {
      name: s.name, kind: s.kind, ops: counted.declared ?? counted.routes ?? 0,
      ...(uncontracted.length ? { uncontracted } : {}),
      ...(s.framework ? { framework: s.framework } : {}),
      repo: s.repo ?? null,
      repos: [...new Set(group.map((g) => g.repo).filter(Boolean))],
      checkouts: group.length,
      owner: s.owner ?? null, ownerSource: s.ownerSource ?? null,
      reachable: s.reachable ?? null,
      ...(s.base && s.attempted > 0 ? { request_target: {
        environment: s.environment ?? null,
        base_url: s.base,
        base_url_source: s.base_url_source ?? "environment",
      } } : {}),
      ...(representative ? { probe: {
        attempted: representative.attempted ?? 0, checked: representative.checked ?? 0,
        operations_probed: representative.operations_probed,
      } } : {}),
      // Confidence counts, not values: what the knowledge file claims about
      // this service's operations, graded by the audit against the contract
      // on disk. A count is a fact about the store, never its content.
      ...(s.known ? { knowledge: {
        verified: s.known.verified ?? 0, suspect: s.known.suspect ?? 0,
        unverified: s.known.unverified ?? 0,
      } } : {}),
      findings: [...findings.values()],
      shadow,
      infraShadow: [...routes.values()].filter((r) => r.infra).length,
    };
  }).sort((a, b) => b.ops - a.ops || a.name.localeCompare(b.name));
  // A stable per-node id, distinct from the name: two UNRELATED services can
  // still share a basename, and the SVG must never draw them on one spot.
  const nameCount = new Map();
  for (const s of services) nameCount.set(s.name, (nameCount.get(s.name) ?? 0) + 1);
  services.forEach((s, i) => { s.id = nameCount.get(s.name) === 1 ? s.name : `${s.name}#${i}`; });

  // External upstreams grouped by host: fifteen files naming api.stripe.com
  // are one dependency, and a cluttered map is a map nobody reads.
  const byHost = new Map();
  for (const e of external ?? []) {
    const host = hostOf(e.url);
    const g = byHost.get(host) ?? { host, url: e.url, callers: [], references: [] };
    if (!g.callers.includes(e.from)) g.callers.push(e.from);
    if (e.via && !g.references.some((r) => r.from === e.from && r.file === e.via))
      g.references.push({ from: e.from, file: e.via });
    byHost.set(host, g);
  }
  const ext = [...byHost.values()].sort((a, b) => b.callers.length - a.callers.length || a.host.localeCompare(b.host));

  // The identical relationship derived from two checkouts of the consumer is
  // one edge on the map — same collapse as the nodes, for the same reason.
  const edgeSeen = new Set();
  const uniqEdges = (edges ?? []).filter((e) => {
    const k = `${e.from}|${e.to}|${e.via}|${(e.operations ?? []).join()}|${(e.unmatchedCalls ?? []).join()}`;
    return edgeSeen.has(k) ? false : edgeSeen.add(k);
  });

  // Stated only when EVERY documented service reports it. A sum across a
  // mixture of measured and unmeasured services would read as a measurement
  // while understating the denominator's coverage; absent is the honest answer.
  const documented = services.filter((x) => x.kind === "documented");
  const operationsProbed = documented.length && documented.every((x) => x.probe)
    ? documented.reduce((n, x) => n + x.probe.operations_probed, 0)
    : null;

  const allFindings = services.flatMap((s) => s.findings);
  const allShadow = services.flatMap((s) => s.shadow);
  const high = [...allFindings, ...allShadow].filter((x) => x.severity === "high").length;
  return {
    version: 1, root, generated_at: localTimestamp(),
    summary: {
      services: services.length,
      operations: services.filter((s) => s.kind === "documented").reduce((n, s) => n + s.ops, 0),
      undocumented_routes: services.filter((s) => s.kind === "undocumented").reduce((n, s) => n + s.ops, 0),
      edges: uniqEdges.length, external: ext.length,
      shadow: allShadow.length, findings: allFindings.length,
      platform: (platform ?? []).length, high,
      ...(operationsProbed === null ? {} : { operations_probed: operationsProbed }),
    },
    services,
    edges: uniqEdges.map((e) => ({ from: e.from, to: e.to, via: e.via,
      ...(e.operations ? { operations: e.operations } : {}),
      ...(e.unmatchedCalls ? { unmatchedCalls: e.unmatchedCalls } : {}) })),
    external: ext,
    omissions,
    platform: platform ?? [],
  };
}

/**
 * The one map-building pipeline shared by the CLI and the shell. The shell
 * asks for execute:false because an observation window must not turn opening
 * a local UI into an API probe. Both engine and CLI are local-only by default;
 * explicit execution runs the bounded, preannounced client plan.
 */
export function buildMapModel(root, options = {}) {
  return withCodeLocations(root, () => projectMapModel(root, options), options);
}

async function projectMapModel(root, { execute = false, includeFixtures = false, environment, announce } = {}) {
  const locations = codeLocations(root);
  const code = { label: 'declared by code', summary: locations.summary, unmatched: locations.unmatched };
  const execution = execute ? await (await import("./map-execution.mjs")).executeMapReads(root, { includeFixtures, environment, announce }) : null;
  const surfaces = findSurfaces(root, { includeFixtures });

  // A consumer-only repo has no served surfaces, but its outbound footprint is
  // still a useful map. Keep this branch identical to `sannr map`'s original
  // behavior: an actually empty tree is a named error, never a blank success.
  if (!surfaces.length) {
    const omissions = [];
    const external = upstreamUrls(root, null, { omissions }).map((u) => ({ from: u.file, url: u.url, via: u.file }));
    if (!external.length && !omissions.length) {
      const error = new Error(`No API surface found under ${root}.`);
      error.code = "NO_API_FOUND";
      error.next = emptyApiDiscoveryNext();
      throw error;
    }
    return { ...footprintModel({ root, surfaces: [], edges: [], external, platform: [], omissions }),
      code, probe_execution: execute ? "executed" : "static", ...(execution ? { map_execution: execution } : {}) };
  }

  const results = [];
  for (const surface of surfaces)
    results.push(await auditSurface(surface, { execute: false }));

  // Disambiguate same-name services before deriving edges, using the same
  // advertised-port identity as the CLI. This is part of the engine model,
  // not shell presentation logic.
  const byName = new Map();
  for (const result of results)
    (byName.get(result.name) ?? byName.set(result.name, []).get(result.name)).push(result);
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const ports = new Set(group.map((result) => {
      try { return new URL(baseUrlFor(result.dir)).port; } catch { return null; }
    }));
    if (ports.size < 2) continue;
    for (const result of group) {
      let port = null;
      try { port = new URL(baseUrlFor(result.dir)).port; } catch { /* no advertised base */ }
      result.name = port ? `${result.name} :${port}` : `${result.name} (${result.dir.split("/").at(-2)})`;
    }
  }

  const omissions = [];
  const { edges, external } = deriveEdges(results, { omissions });
  // Visualization execution is the preannounced client plan above. The audit
  // cross-repository probe has a separate network path and is not run here.
  // Zero operations probed has two very different causes — nothing answered,
  // or nothing was asked. Only the caller knows which, so it is stamped here
  // rather than guessed from the counts by each renderer in turn.
  //
  // Named for its scope, not `execution`: the same JSON document already
  // carries `request_execution` (whether a SELECTED request target was
  // executed against), and a bare `execution` beside it reads as the
  // document-wide verdict and contradicts it. Two fields that read as
  // opposites on one object is the defect class this slice exists to remove.
  return { ...footprintModel({ root, surfaces: results, edges, external, omissions,
    platform: platformConsistency(results, edges) }),
    code, probe_execution: execute ? "executed" : "static", ...(execution ? { map_execution: execution } : {}) };
}

// --- coverage ---------------------------------------------------------------

/**
 * What this map measured, in one sentence, for every view to say the same way.
 *
 * The map used to call itself "complete" the moment it finished rendering, and
 * its empty states read "every probed operation matched its contract" with zero
 * operations probed — vacuously true, and indistinguishable from a verified
 * all-clear. Coverage is the missing denominator: how much of the contract was
 * actually put to the server. A renderer that phrased this for itself would be
 * a second source of truth, so there is exactly one phrasing and three callers.
 *
 * `noExecute` lets the terminal receipt state the static case for a model built
 * before `execution` was stamped; the model's own flag is otherwise the source.
 */
export function coverageStatement(model, { noExecute = false, apiMap = null } = {}) {
  const summary = model?.summary ?? {};
  if (model?.map_execution) return `${model.map_execution.responses} responses from ${model.map_execution.attempted} announced read attempts; response evidence retained locally`;
  const declared = summary.operations ?? 0;
  // A consumer: nothing served here to probe, and the API map shown with the
  // footprint is the API this repository calls.
  if (!declared && apiMap) return "this repository serves no documented API; the API map below is the one it calls";
  if (!declared) return "no documented operations to probe";
  if (noExecute || model?.probe_execution === "static") return "source scan only — no requests executed";
  if (!Number.isInteger(summary.operations_probed)) return "probe coverage not recorded";
  if (!summary.operations_probed) return `0 of ${declared} documented operations probed — nothing verified`;
  return `${summary.operations_probed} of ${declared} documented operations probed`;
}

/**
 * Why the disagreements list is empty: agreement, or nothing asked.
 *
 * The branches below are in the SAME order as coverageStatement's, because a
 * page that states one reason in its header and a different one in its findings
 * panel has told the reader two things about one situation. Nothing declared
 * comes first everywhere: with no declared operation there is no denominator,
 * and no request could have changed that.
 */
function findingsEmptyMessage(model, { apiMap = null } = {}) {
  if (model?.map_execution) return "Declared read responses are listed above; no additional source-to-server probes ran.";
  const summary = model?.summary ?? {};
  if (!(summary.operations ?? 0) && apiMap)
    return "This repository serves no documented API, so it has nothing of its own to compare against a server; the API map above is the API it calls.";
  if (!(summary.operations ?? 0))
    return "No contract here declares an operation, so there is nothing to compare against a server.";
  if (model?.probe_execution === "static")
    return "No request was executed, so nothing here is verified. Use --execute to announce and send declared reads through the API client.";
  if (!Number.isInteger(summary.operations_probed))
    return "Probe coverage was not recorded, so nothing here is verified.";
  if (!summary.operations_probed && model.services?.some((service) => service.probe?.checked > 0))
    return "Requests answered, but no operation was compared against its contract, so nothing here is verified. Inspect response statuses and the contract's response declarations.";
  if (!summary.operations_probed)
    return "No operation was probed, so nothing here is verified. Point the map at a reachable base URL to check the contract against the server.";
  return `Every probed operation matched its contract (${summary.operations_probed} of ${summary.operations ?? 0} documented operations probed).`;
}

/** One service's own coverage, stated the same way the page header states the estate's. */
function serviceCoverageFact(service, model) {
  // Its routes are undocumented by definition; calling them documented
  // operations is the claim the card must not make, and the "not probed —
  // derived from files only" fact directly above would contradict it.
  if (model?.map_execution) return "declared reads and evidence listed above";
  if (service?.kind !== "documented") return "no contract to probe against";
  if (!service.ops) return "no documented operations to probe";
  if (model?.probe_execution === "static") return "source scan only — no requests executed";
  if (!service.probe) return "not recorded";
  return `${service.probe.operations_probed} of ${service.ops} documented operations probed; ` +
    `${service.probe.checked} of ${service.probe.attempted} requests answered`;
}

/** The same question for one service's own card, in the same branch order. */
function serviceFindingsEmptyMessage(service, model) {
  if (model?.map_execution) return "Declared read results are listed above; this snapshot ran no additional source-to-server probes.";
  if (service?.kind !== "documented")
    return "This service declares no contract, so there is nothing to compare its responses against.";
  if (!service.ops)
    return "This service's contract declares no operation, so there is nothing to compare against a server.";
  if (model?.probe_execution === "static") return "No request was executed against this service.";
  if (!service.probe) return "Probe coverage was not recorded for this service.";
  if (!service.probe.operations_probed && service.probe.checked > 0)
    return "Requests answered, but no operation was compared against its contract, so nothing is verified for this service.";
  if (!service.probe.operations_probed)
    return "No operation was probed, so nothing is verified for this service.";
  return `Contract and server agree on every probed operation (${service.probe.operations_probed} of ${service.ops} documented operations probed).`;
}

// --- text ------------------------------------------------------------------

const RANK = { high: 0, medium: 1, low: 2 };
const bySev = (a, b) => RANK[a.severity] - RANK[b.severity];
// Bound columns after escaping: a foreign name never determines the width of
// every row, and control bytes remain visible data in both terminal snapshots.
const textCell = (value, width = 240) => {
  const text = terminalText(value ?? "");
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
};

/** The terminal footprint: everything on the map, nothing twice, no prose. */
export function renderMapText(model, { complete = false, apiMap = null } = {}) {
  const { summary: s } = model;
  const lines = [`API footprint — ${textCell(model.root)}`,
    `  ${s.services} services   ${s.operations} operations   ` +
    (s.undocumented_routes ? `${s.undocumented_routes} undocumented routes   ` : "") +
    `${s.edges} edges   ` +
    `${s.shadow} shadow route${s.shadow === 1 ? "" : "s"}   ${s.findings} disagreement${s.findings === 1 ? "" : "s"}` +
    (s.high ? `   (${s.high} high)` : "") +
    `   ${coverageStatement(model, { apiMap })}`, ""];

  if (model.map_execution) {
    lines.push("  declared reads (private evidence retained):");
    for (const row of model.map_execution.requests)
      lines.push(`    ${textCell(row.stack ?? row.service)} / ${textCell(row.environment)}: ${textCell(row.method)} ${textCell(row.path)} — ${row.status ?? textCell(row.refusal ?? "no response")}`);
    for (const row of model.map_execution.omitted)
      lines.push(`    omitted ${row.count} from ${textCell(row.stack ?? row.service)}: ${textCell(row.reason)}`);
    lines.push("");
  }
  const pad = model.services.reduce((width, x) => Math.max(width, textCell(x.name, 32).length), 8);
  // The snapshot uses this same renderer without the terminal's space budget.
  // Isolated services and ownership are knowledge too, even with no findings.
  if (complete) {
    lines.push("  services & ownership:");
    if (!model.services.length) lines.push("    No served API services recorded.");
    for (const service of model.services)
      lines.push(`    ${textCell(service.name, 32)}: ${service.ops} operations; ${textCell(service.kind, 32)}; ` +
        `repo ${textCell((service.repos?.length ? service.repos.join(", ") : service.repo) ?? "not recorded")}; ` +
        `owner ${textCell(service.owner ?? "not recorded")}${service.ownerSource ? ` (${textCell(service.ownerSource)})` : ""}`);
    lines.push("");
  }
  // Edges grouped by consumer: one line per caller reads as an adjacency list.
  const byFrom = new Map();
  for (const e of model.edges) (byFrom.get(e.from) ?? byFrom.set(e.from, []).get(e.from)).push(e);
  for (const [from, es] of byFrom)
    lines.push(`  ${textCell(from, 32).padEnd(pad)} → ` + es.map((e) =>
      `${textCell(e.to, 32)}${e.operations ? ` (${e.operations.length} op${e.operations.length === 1 ? "" : "s"})` : ""}` +
      (e.unmatchedCalls ? ` [${e.unmatchedCalls.length} undeclared]` : "")).join(", "));
  if (byFrom.size) lines.push("");
  if (complete) for (const edge of model.edges) {
    lines.push(`    ${textCell(edge.from, 32)} → ${textCell(edge.to, 32)}; declared in ${textCell(edge.via, 160)}`);
    if (edge.operations) lines.push(`      declared calls: ${textCell(edge.operations.join(", ") || "none")}`);
    if (edge.unmatchedCalls) lines.push(`      undeclared calls: ${textCell(edge.unmatchedCalls.join(", ") || "none")}`);
  }

  // A service with no contract at all: every route it serves is undocumented.
  // This is the whole footprint on a repo that has never written a spec, and it
  // used to render as nothing at all.
  const bare = model.services.filter((x) => x.uncontracted?.length);
  if (bare.length) {
    lines.push(`  services with NO contract — every route below is undocumented:`);
    for (const svc of bare) {
      for (const r of svc.uncontracted)
        lines.push(`    ${textCell(svc.name, 32).padEnd(pad)}  ${textCell(`${r.method} ${r.path}`, 96).padEnd(30)}  ${textCell(r.file, 160)}`);
    }
    lines.push(`    → write a spec, or generate a starting point from the source routes.`, "");
  }

  const shadow = model.services.flatMap((x) => x.shadow.map((r) => ({ ...r, svc: x.name }))).sort(bySev);
  if (shadow.length) {
    lines.push(`  shadow routes (in source, absent from the contract):`);
    for (const r of shadow)
      lines.push(`    ${textCell(r.severity, 6).padEnd(6)}  ${textCell(r.svc, 32).padEnd(pad)}  ${textCell(`${r.method} ${r.path}`, 96).padEnd(30)}  ${textCell(r.file, 160)}`);
    lines.push("");
  }
  const findings = model.services.flatMap((x) => x.findings.map((f) => ({ ...f, svc: x.name }))).sort(bySev);
  if (findings.length) {
    lines.push(`  contract vs server:`);
    for (const f of findings.slice(0, complete ? undefined : 12))
      lines.push(`    ${textCell(f.severity, 6).padEnd(6)}  ${textCell(f.svc, 32).padEnd(pad)}  ${textCell(f.op, 96).padEnd(26)}  ${textCell(f.detail)}`);
    if (!complete && findings.length > 12) lines.push(`    …and ${findings.length - 12} more — ${CLI_NAME} audit for the full report`);
    lines.push("");
  }
  // External means no matching service in this scan; a sibling repository can
  // be a real dependency while remaining outside this map's service graph.
  const externalRefs = (e) => e.references?.length
    ? e.references.map((r) => r.from === r.file ? r.file : `${r.from} (${r.file})`)
    : e.callers;
  if (complete) {
    lines.push("  external dependencies (outside scanned services):");
    if (!model.external.length) lines.push("    No external dependencies recorded.");
    for (const external of model.external) lines.push(`    ${textCell(external.host, 96)} ← ${textCell(externalRefs(external).join(", "))}`);
    lines.push("  platform conventions:");
    if (!model.platform?.length) lines.push("    No platform convention disagreements recorded.");
    for (const convention of model.platform ?? []) lines.push(`    ${textCell(convention.dimension, 96)}: ${textCell(convention.detail)}`);
  } else if (model.external.length && !model.services.length) {
    const w = model.external.reduce((width, e) => Math.max(width, textCell(e.host, 96).length), 8);
    lines.push(`  external dependencies (this repo calls them; it serves no API of its own):`, "");
    for (const e of model.external)
      lines.push(`    ${textCell(e.host, 96).padEnd(w)}  ← ${textCell(e.callers.slice(0, 4).join(", "))}` +
        (e.callers.length > 4 ? ` …+${e.callers.length - 4} more` : ""));
  } else if (model.external.length) {
    lines.push("  external dependencies (outside scanned services):");
    for (const e of model.external.slice(0, 8))
      lines.push(`    ${textCell(e.host, 96)} ← ${textCell(externalRefs(e).slice(0, 4).join(", "))}` +
        (externalRefs(e).length > 4 ? ` …+${externalRefs(e).length - 4} more` : ""));
    if (model.external.length > 8) lines.push(`    …+${model.external.length - 8} dependencies`);
  }
  if (model.omissions?.length) {
    lines.push("", "  omissions:");
    for (const omission of model.omissions)
      lines.push(`    ${textCell(omission.code, 64)}: ${textCell(omission.file, 160)} — ${textCell(omission.message)}`);
  }
  // Adjacency lists can contain many bounded cells. Cap the composed row too.
  return lines.map(line => textCell(line, 1024)).join("\n");
}

// --- html ------------------------------------------------------------------

const esc = (v) => String(v ?? "").replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const anchorId = (prefix, value) => `${prefix}-${String(value ?? "item")
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item"}`;

// Node geometry. Fixed sizes keep the layout a pure function of the graph —
// no measurement pass, no JS, so the SVG can be emitted finished.
const NW = 176, NH = 62, XGAP = 130, YGAP = 26, M = 28, EXH = 34;

// Longest-path ranks over the INTERNAL edges: a leaf upstream is rank 0, a
// consumer sits one column left of the deepest thing it calls. Cycles (A calls
// B calls A — it happens) break at the revisit instead of recursing forever.
function ranks(names, edges) {
  const targets = new Map();
  for (const e of edges) {
    if (!names.has(e.from) || !names.has(e.to)) continue;
    (targets.get(e.from) ?? targets.set(e.from, []).get(e.from)).push(e.to);
  }
  const out = new Map(), visiting = new Set();
  const rank = (n) => {
    if (out.has(n)) return out.get(n);
    if (visiting.has(n)) return 0;
    visiting.add(n);
    const r = Math.max(-1, ...(targets.get(n) ?? []).map(rank)) + 1;
    visiting.delete(n);
    out.set(n, r);
    return r;
  };
  for (const n of names) rank(n);
  return out;
}

const sevColor = { high: "var(--high)", medium: "var(--med)", low: "var(--low)" };

// One service node: name, ops + owner, and pills only when there is something
// to say — a clean service is a quiet box, so the loud ones read at a glance.
function nodeSvg(s, x, y) {
  const highShadow = s.shadow.some((r) => r.severity === "high");
  const pills = [];
  if (s.shadow.length) pills.push({ text: `${s.shadow.length} shadow`, color: highShadow ? "var(--high)" : "var(--med)" });
  if (s.findings.length) pills.push({ text: `${s.findings.length} drift`, color: "var(--med)" });
  if (s.kind === "undocumented") pills.push({ text: "no contract", color: "var(--med)" });
  let px = x + 10;
  const pillSvg = pills.map((p) => {
    const w = p.text.length * 5.6 + 12;
    const out = `<rect x="${px}" y="${y + NH - 20}" width="${w}" height="14" rx="7" fill="${p.color}" opacity="0.16"/>` +
      `<text x="${px + w / 2}" y="${y + NH - 9.5}" text-anchor="middle" font-size="9" fill="${p.color}">${esc(p.text)}</text>`;
    px += w + 6;
    return out;
  }).join("");
  const owner = s.owner ? ` · ${trunc(s.owner, 14)}` : "";
  const tip = [`${s.name} — ${s.ops} ${s.kind === "documented" ? "documented ops" : `routes, no contract (${s.framework ?? "?"})`}`,
    s.repos?.length > 1 ? `checked out ${s.checkouts} times: ${s.repos.join(", ")}` : s.repo ? `repo: ${s.repo}` : "not in git",
    s.owner ? `owner: ${s.owner}${s.ownerSource ? ` (${s.ownerSource})` : ""}` : "owner: unknown",
    ...(s.shadow.length ? [`${s.shadow.length} shadow route(s): ${s.shadow.map((r) => `${r.method} ${r.path}`).join(", ")}`] : []),
  ].join("\n");
  const target = anchorId("service", s.id ?? s.name);
  return `<a href="#${target}" aria-label="Open ${esc(s.name)} details"><g><title>${esc(tip)}</title>` +
    `<rect x="${x + 6}" y="${y + 6}" width="${NW}" height="${NH}" rx="10" class="node-shadow"/>` +
    `<rect x="${x}" y="${y}" width="${NW}" height="${NH}" rx="10" class="node${highShadow ? " hot" : ""}"/>` +
    `<text x="${x + 10}" y="${y + 19}" font-size="12.5" font-weight="600" fill="var(--ink)">${esc(trunc(s.name, 22))}</text>` +
    `<text x="${x + 10}" y="${y + 34}" font-size="10" fill="var(--muted)">${esc(`${s.ops} ops${owner}`)}</text>` +
    pillSvg + `</g></a>`;
}

function edgeSvg(e, from, to) {
  const x1 = from.x + NW, y1 = from.y + NH / 2, x2 = to.x, y2 = to.y + (to.ex ? EXH : NH) / 2;
  const dx = Math.max(40, (x2 - x1) / 2);
  const cls = e.ext ? "eedge" : e.unmatchedCalls?.length ? "edge warn" : "edge";
  const tip = e.ext ? `${e.from} → ${e.toHost}` :
    [`${e.from} → ${e.to}  (${e.via})`,
      ...(e.operations ? [`calls ${e.operations.length} declared: ${e.operations.join(", ")}`] : []),
      ...(e.unmatchedCalls ? [`${e.unmatchedCalls.length} call(s) the upstream never declares: ${e.unmatchedCalls.join(", ")}`] : []),
    ].join("\n");
  const label = !e.ext && e.operations
    ? `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 5}" text-anchor="middle" font-size="9" fill="var(--muted)">${e.operations.length} ops</text>` : "";
  return `<g><title>${esc(tip)}</title>` +
    `<path class="${cls}" d="M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}"/>` + label + `</g>`;
}

// The graph: wired services in dependency columns (consumers left, upstreams
// right), external hosts in a ghost column past the deepest upstream, and
// services with no derived edges in a grid band below — a real tree is mostly
// unconnected repos, and stacking those into the wired picture is clutter.
function graphSvg(model) {
  const wiredNames = new Set(model.edges.flatMap((e) => [e.from, e.to]));
  const wired = model.services.filter((s) => wiredNames.has(s.name));
  const isolated = model.services.filter((s) => !wiredNames.has(s.name));
  const r = ranks(wiredNames, model.edges);
  const maxRank = Math.max(0, ...[...r.values()]);

  // Positions are keyed by the node's unique id; edges name services, so they
  // attach to the first node carrying that name. (After the same-host merge a
  // surviving collision means two UNRELATED services share a basename — the
  // edge's own derivation was by host:port, and the first is the deterministic
  // pick for a purely visual join.)
  const firstByName = new Map();
  for (const s of model.services) if (!firstByName.has(s.name)) firstByName.set(s.name, s.id ?? s.name);

  const cols = [];
  for (const s of wired) (cols[maxRank - r.get(s.name)] ??= []).push(s);
  const ext = model.external.slice(0, 8);
  const extMore = model.external.length - ext.length;
  const extCol = wired.length ? cols.length : 0;

  const nCols = extCol + (ext.length ? 1 : 0);
  const colH = (n, h) => n * (h + YGAP) - YGAP;
  const wiredH = Math.max(0, ...cols.map((c) => colH(c.length, NH)), ext.length ? colH(ext.length + (extMore > 0 ? 1 : 0), EXH) : 0);
  const pos = new Map();
  const parts = [];
  cols.forEach((col, c) => col.forEach((s, i) => {
    const x = M + c * (NW + XGAP);
    const y = M + 18 + (wiredH - colH(col.length, NH)) / 2 + i * (NH + YGAP);
    pos.set(s.id ?? s.name, { x, y });
  }));
  ext.forEach((e, i) => {
    const x = M + extCol * (NW + XGAP);
    const y = M + 18 + (wiredH - colH(ext.length, EXH)) / 2 + i * (EXH + YGAP);
    pos.set(`ext:${e.host}`, { x, y, ex: true });
  });

  // Edges under nodes: draw paths first so boxes sit on top of line ends.
  for (const e of model.edges) {
    const f = pos.get(firstByName.get(e.from)), t = pos.get(firstByName.get(e.to));
    if (f && t) parts.push(edgeSvg(e, f, t));
  }
  for (const e of ext)
    for (const caller of e.callers) {
      const f = pos.get(firstByName.get(caller)), t = pos.get(`ext:${e.host}`);
      if (f && t) parts.push(edgeSvg({ ext: true, from: caller, toHost: e.host }, f, t));
    }
  for (const s of wired) { const p = pos.get(s.id ?? s.name); parts.push(nodeSvg(s, p.x, p.y)); }
  for (const e of ext) {
    const p = pos.get(`ext:${e.host}`);
    const target = anchorId("external", e.host);
    parts.push(`<a href="#${target}" aria-label="Open ${esc(e.host)} details"><g><title>${esc(`${e.url} — called by ${e.callers.join(", ")}`)}</title>` +
      `<rect x="${p.x}" y="${p.y}" width="${NW}" height="${EXH}" rx="8" class="node ext"/>` +
      `<text x="${p.x + 10}" y="${p.y + 21}" font-size="11" fill="var(--muted)">${esc(trunc(e.host, 26))}</text></g></a>`);
  }
  if (extMore > 0) {
    const x = M + extCol * (NW + XGAP);
    parts.push(`<text x="${x + 10}" y="${M + 18 + wiredH + 16}" font-size="10" fill="var(--muted)">…and ${extMore} more external hosts</text>`);
  }
  if (ext.length) parts.push(`<text x="${M + extCol * (NW + XGAP)}" y="${M + 6}" font-size="10" fill="var(--muted)">external</text>`);

  // Isolated band: a compact grid, labelled, below the wired picture.
  let bandTop = M + 18 + wiredH + (extMore > 0 ? 34 : 22);
  let bandH = 0;
  const perRow = Math.max(1, nCols || 3);
  if (isolated.length) {
    if (wired.length || ext.length)
      parts.push(`<text x="${M}" y="${bandTop}" font-size="10" fill="var(--muted)">no derived edges</text>`);
    else bandTop = M + 4;
    isolated.forEach((s, i) => {
      const x = M + (i % perRow) * (NW + 24);
      const y = bandTop + 10 + Math.floor(i / perRow) * (NH + YGAP);
      parts.push(nodeSvg(s, x, y));
    });
    bandH = 10 + colH(Math.ceil(isolated.length / perRow), NH) + 8;
  }

  const width = Math.max(M * 2 + Math.max(nCols, 1) * (NW + XGAP) - (nCols ? XGAP : 0),
    isolated.length ? M * 2 + Math.min(perRow, isolated.length) * (NW + 24) - 24 : 0, 480);
  const height = bandTop + bandH + M;
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
    `xmlns="http://www.w3.org/2000/svg" role="img" aria-label="API service graph">` +
    `<defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">` +
    `<path d="M 0 0 L 8 4 L 0 8 z" fill="var(--line-strong)"/></marker></defs>${parts.join("")}</svg>`;
}

const pill = (sev) => `<span class="pill" style="color:${sevColor[sev]};background:color-mix(in srgb, ${sevColor[sev]} 14%, transparent)">${sev.toUpperCase()}</span>`;

function tableRows(rows) { return rows.join(""); }

/**
 * The artifact: one HTML file, inline CSS, zero script, zero egress.
 *
 * `apiMap` is the store's API map section (lib/api-map.mjs), rendered above
 * the footprint when the store has operations. It carries the store's notes
 * and the contract's text, so the page that holds it also carries the same
 * Content-Security-Policy as `view`. Without it the page is exactly the
 * footprint it always was.
 */
export function renderMapHtml(model, { apiMap } = {}) {
  const { summary: s } = model;
  const shadow = model.services.flatMap((x) => x.shadow.map((r) => ({ ...r, svc: x.name }))).sort(bySev);
  const findings = model.services.flatMap((x) => x.findings.map((f) => ({ ...f, svc: x.name }))).sort(bySev);
  // A service with no contract has no shadow routes to hide from a spec — every
  // route it serves is undocumented, and on a repo that never wrote a spec that
  // IS the footprint. Rendering only `shadow` left that repo with a blank page.
  const bare = model.services.flatMap((x) => (x.uncontracted ?? []).map((r) => ({ ...r, svc: x.name })));
  const CAP = 40;
  // The status light is a claim too: a lit green dot beside "nothing verified"
  // is the all-clear the words are refusing to give. It is lit only when this
  // map actually put operations to a server.
  const coverage = { text: coverageStatement(model, { apiMap }), probed: (model.summary?.operations_probed ?? 0) > 0 };
  const rootName = model.root.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() ?? model.root;
  const tilts = [-1.1, 0.7, -0.5, 1.2, -0.8, 0.6, -0.4];
  const tileDefs = [
    { id: "services", label: "services", n: s.services },
    { id: "ops", label: "documented ops", n: s.operations },
    { id: "edges", label: "edges", n: s.edges },
    { id: "shadow", label: "shadow routes", n: s.shadow, hot: s.shadow > 0 },
    ...(s.undocumented_routes ? [{ id: "undocumented", label: "undocumented routes", n: s.undocumented_routes, hot: true }] : []),
    { id: "findings", label: "disagreements", n: s.findings, hot: s.findings > 0 },
  ];
  const tiles = tileDefs.map((t, i) =>
    `<a class="tile${t.hot ? " hot" : ""}" style="--tilt:${tilts[i % tilts.length]}deg" href="#${t.id}" aria-label="Open ${esc(t.label)} view">` +
    `<span class="n">${esc(t.n)}</span><span class="l">${esc(t.label)} <b aria-hidden="true">↗</b></span></a>`).join("");

  const stateOf = (x) => x.kind === "undocumented"
    ? { text: `no contract (${x.framework ?? "?"})`, cls: "bad" }
    : x.findings.length ? { text: `${x.findings.length} disagree`, cls: "bad" }
      : x.reachable === null ? { text: "not probed", cls: "muted" } : { text: "agrees", cls: "good" };
  const serviceRows = model.services.map((x) => {
    const state = stateOf(x);
    const repoCell = x.repos?.length > 1 ? `${x.repos.join(" + ")} (${x.checkouts} checkouts)` : x.repo ?? "not in git";
    return `<tr><td><a class="row-link" href="#${anchorId("service", x.id ?? x.name)}">${esc(x.name)} <span aria-hidden="true">↗</span></a></td>` +
      `<td class="num">${esc(x.ops)}</td><td><span class="state ${state.cls}">${esc(state.text)}</span></td>` +
      `<td class="mut">${esc(repoCell)}</td><td>${esc(x.owner ?? "unknown")}${x.ownerSource ? ` <span class="mut">(${esc(x.ownerSource)})</span>` : ""}</td></tr>`;
  }).join("");
  const maxOps = Math.max(1, ...model.services.map((x) => x.ops));
  const opsRows = model.services.map((x) => {
    const documented = x.kind !== "undocumented";
    const detail = documented
      ? `${x.ops} operations declared in the OpenAPI contract · ${x.findings.length} disagree · ${x.shadow.length} routes omitted from source contract`
      : `${x.ops} routes found in ${x.framework ?? "source"}; no contract declares them`;
    return `<a class="metric-row" href="#${anchorId("service", x.id ?? x.name)}"><span class="metric-name">${esc(x.name)}</span>` +
      `<strong class="metric-number ${documented ? "good-text" : "bad-text"}">${esc(x.ops)}</strong>` +
      `<span class="bar"><i style="width:${Math.round(x.ops / maxOps * 100)}%"></i></span><span class="metric-detail">${esc(detail)}</span></a>`;
  }).join("");
  const empty = (message) => `<p class="empty">${esc(message)}</p>`;
  const bareRows = bare.map((r) => `<tr><td>${esc(r.svc)}</td><td><code>${esc(`${r.method} ${r.path}`)}</code></td><td class="mut">${esc(r.file)}</td></tr>`).join("");
  const shadowRows = shadow.map((r) => `<tr><td>${pill(r.severity)}</td><td>${esc(r.svc)}</td><td><code>${esc(`${r.method} ${r.path}`)}</code></td><td class="mut">${esc(r.file)}</td></tr>`).join("");
  const findingRows = findings.slice(0, CAP).map((f) => `<tr><td>${pill(f.severity)}</td><td>${esc(f.svc)}</td><td><code>${esc(f.op ?? "")}</code></td><td class="mut">${esc(f.detail ?? "")}</td></tr>`).join("");
  const bareSection = `<section class="panel${bare.length ? " panel-alert" : ""}" id="undocumented"><div class="panel-head"><div><span class="eyebrow">// source coverage</span><h2>Services with no contract <span class="count">${esc(bare.length)}</span></h2></div><span class="basis">framework route definitions</span></div>` +
    `<p class="note">These services have route definitions but no OpenAPI document, so every route below is undocumented. Write a spec, or generate a starting point from these definitions.</p>` +
    (bare.length ? `<div class="scroll"><table><thead><tr><th>service</th><th>route</th><th>defined in</th></tr></thead><tbody>${bareRows}</tbody></table></div>` : empty("Every service with routes has a contract.")) + `</section>`;
  const shadowSection = `<section class="panel${shadow.length ? " panel-alert" : ""}" id="shadow"><div class="panel-head"><div><span class="eyebrow">// contract coverage</span><h2>Routes missing from the contract <span class="count">${esc(shadow.length)}</span></h2></div><span class="basis">source vs OpenAPI</span></div>` +
    `<p class="note">These routes are defined in source but absent from the service's OpenAPI document. An undocumented <code>/admin</code>, <code>/internal</code> or <code>/debug</code> route is graded HIGH.</p>` +
    (shadow.length ? `<div class="scroll"><table><thead><tr><th>severity</th><th>service</th><th>route</th><th>defined in</th></tr></thead><tbody>${shadowRows}</tbody></table></div>` : empty("Every non-infra route in source is declared in its contract.")) + `</section>`;
  const findingsSection = `<section class="panel${findings.length ? " panel-alert" : ""}" id="findings"><div class="panel-head"><div><span class="eyebrow">// runtime agreement</span><h2>Contract disagreements <span class="count">${esc(findings.length)}</span></h2></div><span class="basis">contract vs recorded responses</span></div>` +
    `<p class="note">Where the contract and the server disagree: required fields the server ignores, enum values the spec never lists, or declared fields never observed.</p>` +
    (findings.length ? `<div class="scroll"><table><thead><tr><th>severity</th><th>service</th><th>operation</th><th>detail</th></tr></thead><tbody>${findingRows}</tbody></table></div>${findings.length > CAP ? `<p class="note">…and ${findings.length - CAP} more — <code>${esc(CLI_NAME)} audit</code> for the full report.</p>` : ""}` : empty(findingsEmptyMessage(model, { apiMap }))) + `</section>`;
  const platformSection = model.platform.length ? `<section class="panel" id="platform"><div class="panel-head"><div><span class="eyebrow">// shared language</span><h2>One platform, several conventions <span class="count">${esc(model.platform.length)}</span></h2></div><span class="basis">cross-service comparison</span></div><ul class="plain">${model.platform.map((p) => `<li><strong>${esc(p.dimension ?? "")}</strong><span>— ${esc(p.detail ?? "")}</span></li>`).join("")}</ul></section>` : "";
  const edgeItems = model.edges.map((e) => `<li><div class="edge-title"><a class="row-link" href="#${anchorId("service", e.from)}">${esc(e.from)}</a><span class="arrow">→</span><a class="row-link" href="#${anchorId("service", e.to)}">${esc(e.to)}</a><span class="mut">(${esc(e.via)})</span></div>` +
    (e.operations ? `<div class="edge-detail">calls ${e.operations.length} declared: <code>${esc(e.operations.join(", "))}</code></div>` : "") +
    (e.unmatchedCalls?.length ? `<div class="warning"><b>UNDECLARED</b> ${e.unmatchedCalls.length} call${e.unmatchedCalls.length === 1 ? "" : "s"} the upstream contract never declares: <code>${esc(e.unmatchedCalls.join(", "))}</code></div>` : "") + `</li>`).join("");
  const edgeSection = `<section class="panel" id="edges"><div class="panel-head"><div><span class="eyebrow">// dependency graph</span><h2>Who calls whom <span class="count">${esc(model.edges.length)}</span></h2></div><span class="basis">source + environment declarations</span></div>` +
    `<p class="note">Calls from one scanned service to another. A red block marks calls the upstream contract never declares.</p>` +
    (model.edges.length ? `<ul class="plain edge-list">${edgeItems}</ul>` : empty("No scanned service calls another scanned service.")) + `</section>`;
  const extItems = model.external.map((e) => `<li id="${anchorId("external", e.host)}"><details><summary><code>${esc(e.host)}</code><span class="mut">← ${esc(e.callers.join(", "))}</span></summary>` +
    `<div class="detail-body"><div><span class="detail-label">url</span><code>${esc(e.url)}</code></div><div><span class="detail-label">references</span><span>${esc(e.references?.map((r) => `${r.from}: ${r.file}`).join(", ") || "not recorded")}</span></div></div></details></li>`).join("");
  const extSection = `<section class="panel" id="external"><div class="panel-head"><div><span class="eyebrow">// outside this scan</span><h2>External upstreams <span class="count">${esc(model.external.length)}</span></h2></div><span class="basis">unmatched endpoint references</span></div>` +
    `<p class="note">These endpoint references do not match a service in this scan. A dependency in another repository stays external until its service is included.</p>` +
    (model.external.length ? `<ul class="plain external-list">${extItems}</ul>` : empty("No external dependencies recorded.")) + `</section>`;

  const serviceDetails = model.services.map((x) => {
    const id = anchorId("service", x.id ?? x.name);
    const state = stateOf(x);
    const outEdges = model.edges.filter((e) => e.from === x.name);
    const inEdges = model.edges.filter((e) => e.to === x.name);
    const extOut = model.external.filter((e) => e.callers.includes(x.name));
    const facts = [
      ["ops", `${x.ops} ${x.kind === "documented" ? "declared in contract" : "routes in source, none declared"}`],
      ["repo", x.repo ?? "not in git"],
      ["owner", `${x.owner ?? "unknown"}${x.ownerSource ? ` (${x.ownerSource})` : ""}`],
      ["state", state.text],
      ["probed", x.reachable === null ? "not probed — derived from files only" : x.request_target ? `${x.request_target.base_url} · ${x.request_target.environment ?? "environment unknown"}` : "yes"],
      ["coverage", serviceCoverageFact(x, model)],
      ...(x.knowledge ? [["knowledge", "Legacy audit classification retained in the report data; it is not a current evidence grade."]] : []),
      ...(x.infraShadow ? [["infra", `${x.infraShadow} conventional route(s) excluded from shadow count`]] : []),
    ];
    const group = (title, items, message) => `<div class="detail-group"><div class="group-head"><span>${esc(title)}</span><b>${esc(items.length)}</b></div>` +
      (items.length ? `<ul>${items.map((item) => `<li><span class="tag">${esc(item[0])}</span><span>${esc(item[1])}</span></li>`).join("")}</ul>` : `<p class="mut">${esc(message)}</p>`) + `</div>`;
    const disagreementItems = x.findings.slice().sort(bySev).map((f) => [f.severity, `${f.op} — ${f.detail}`]);
    const shadowItems = x.shadow.slice().sort(bySev).map((r) => [r.severity, `${r.method} ${r.path} — ${r.file}`]);
    const callItems = [...outEdges.map((e) => ["service", `${e.to} · ${e.operations?.length ?? 0} declared${e.unmatchedCalls?.length ? ` · ${e.unmatchedCalls.length} undeclared` : ""} · ${e.via}`]), ...extOut.map((e) => ["external", `${e.host} · ${e.references.filter((r) => r.from === x.name).map((r) => r.file).join(", ")}`])];
    const calledByItems = inEdges.map((e) => ["service", `${e.from} · ${e.operations?.length ?? 0} declared · ${e.via}`]);
    return `<details class="detail-card" id="${id}"><summary><span class="detail-kind">// ${esc(x.kind === "documented" ? "documented service" : `undocumented service · ${x.framework ?? "?"}`)}</span><strong>${esc(x.name)}</strong><span class="state ${state.cls}">${esc(state.text)}</span></summary>` +
      `<div class="detail-body"><dl>${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` +
      group("disagreements", disagreementItems, serviceFindingsEmptyMessage(x, model)) +
      group("shadow routes", shadowItems, "Every route in source is declared in the contract.") +
      group("calls out", callItems, "Calls no other scanned service or external host.") + group("called by", calledByItems, "No scanned service calls this one.") + `</div></details>`;
  }).join("");
  const detailSection = `<section class="panel detail-panel" id="service-notes"><div class="panel-head"><div><span class="eyebrow">// inspect a node</span><h2>Service details <span class="count">${esc(model.services.length)}</span></h2></div><span class="basis">click a graph node or row</span></div><div class="details-grid">${serviceDetails || empty("No internal services recorded.")}</div></section>`;

  const serviceSection = `<section class="panel panel-primary" id="services"><div class="panel-head"><div><span class="eyebrow">// ownership + contract state</span><h2>Services &amp; ownership <span class="count">${esc(model.services.length)}</span></h2></div><span class="basis">CODEOWNERS · git history · recorded results</span></div>` +
    `<p class="note">Every API surface found under the scan root, who owns it, and whether its contract agrees with the running server. Click a service for its full record.</p>` +
    (model.services.length ? `<div class="scroll"><table><thead><tr><th>service</th><th>ops</th><th>state</th><th>repo</th><th>owner</th></tr></thead><tbody>${serviceRows}</tbody></table></div>` : empty("No served API services recorded.")) + `</section>`;
  const opsSection = `<section class="panel" id="ops"><div class="panel-head"><div><span class="eyebrow">// contract volume</span><h2>Documented ops <span class="count">${esc(s.operations)}</span></h2></div><span class="basis">OpenAPI documents</span></div><p class="note">Operations declared in each service's contract. An undocumented service contributes zero — its routes exist in source only.</p><div class="metric-list">${opsRows || empty("No documented operations recorded.")}</div></section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>API footprint — ${esc(rootName)}</title>
<style>
${reportThemeCss("dark")}
*{box-sizing:border-box;margin:0}
html{background:var(--bg);scroll-behavior:smooth}
body{min-height:100vh;background:var(--bg);background-image:radial-gradient(var(--grain-dot) .55px,transparent .55px);background-size:5px 5px;color:var(--paper);font:13px/1.65 "Courier New",Courier,monospace;letter-spacing:.01em}
body:before{content:"";position:fixed;inset:0;pointer-events:none;background:linear-gradient(120deg,rgba(200,242,36,.04),transparent 28%,rgba(255,74,61,.025) 70%,transparent);mix-blend-mode:screen}
main{width:min(1240px,100%);margin:0 auto;padding:clamp(22px,4vw,46px) clamp(20px,5vw,64px) 34px;position:relative}
a{color:var(--paper)}a:hover{color:var(--accent-text)}a:focus-visible{outline:2px solid var(--accent-text);outline-offset:4px}
.topline{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding-bottom:18px;border-bottom:1px solid var(--line);text-transform:uppercase;letter-spacing:.16em;font-size:11px}
.brand{font-size:22px;line-height:1;letter-spacing:.02em;text-transform:none}.brand i{font-style:normal;color:var(--accent-text)}
.status{color:var(--muted)}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--lime);box-shadow:0 0 13px var(--lime);margin-right:8px;animation:pulse 2.4s ease-in-out infinite}.dot.cold{background:var(--muted);box-shadow:none;animation:none}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.hero{padding:clamp(28px,4vw,48px) 0 clamp(22px,3vw,34px)}.eyebrow{display:block;color:var(--accent-text);font-size:11px;letter-spacing:.14em;text-transform:uppercase}.eyebrow:before{content:""}
h1,h2,.n,.metric-number,.tile .n{font-family:Impact,"Arial Narrow","Helvetica Neue",sans-serif;font-weight:400;text-transform:uppercase;letter-spacing:.015em}
h1{font-size:clamp(48px,8vw,92px);line-height:.9;margin-top:14px;max-width:700px}h1 .lime{color:var(--accent-text)}
.lede{overflow-wrap:anywhere;max-width:680px;color:var(--soft);font-size:13px;line-height:1.75;margin-top:26px}.lede code{color:var(--paper)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:14px;padding-bottom:30px}.tile{display:flex;flex-direction:column;justify-content:space-between;min-height:112px;padding:17px 16px 13px;border:1px solid var(--line);background:var(--panel-bg);box-shadow:7px 7px 0 var(--lime);text-decoration:none;transform:rotate(var(--tilt));transition:transform .15s ease,box-shadow .15s ease}.tile:nth-child(even){box-shadow:7px 7px 0 var(--paper)}.tile:hover{transform:translate(2px,-2px) rotate(0deg);box-shadow:10px 10px 0 var(--lime)}.tile.hot{border-color:var(--red);background:var(--alert-bg);color:var(--on-alert);box-shadow:7px 7px 0 var(--paper)}.tile.hot:hover{box-shadow:10px 10px 0 var(--lime)}.tile .n{font-size:58px;line-height:.85}.tile .l{display:flex;justify-content:space-between;gap:8px;margin-top:14px;font-size:10px;letter-spacing:.12em;text-transform:uppercase}.tile .l b{font-size:15px;font-weight:400;line-height:1}
.panel{margin:0 0 clamp(34px,5vw,62px);padding:clamp(18px,3vw,32px);border:1px solid var(--line);background:var(--panel-bg);scroll-margin-top:20px}.panel-primary{border-color:var(--accent-text);box-shadow:10px 10px 0 rgba(200,242,36,.32)}.panel-alert{border-color:var(--red)}.panel:target{box-shadow:10px 10px 0 rgba(200,242,36,.42)}.panel-alert:target{box-shadow:10px 10px 0 rgba(255,74,61,.36)}
.panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:8px}.panel h2{font-size:clamp(30px,4vw,48px);line-height:.92}.count{color:var(--accent-text);font-size:.55em;letter-spacing:.05em}.basis{color:var(--muted);font-size:10px;letter-spacing:.12em;text-transform:uppercase}.note{max-width:720px;color:var(--soft);font-size:12px;line-height:1.7;margin:0 0 21px}.note code,code{font-family:inherit;color:var(--paper);background:var(--faint);padding:1px 5px}.empty{padding:18px;border:1px dashed var(--muted);color:var(--muted);font-size:12px}
.scroll{overflow-x:auto;border:1px solid var(--line)}table{border-collapse:collapse;width:100%;min-width:640px;font-size:12px}th{text-align:left;padding:10px 13px;background:var(--paper);color:var(--bg);font-size:10px;font-weight:400;letter-spacing:.14em;text-transform:uppercase}td{padding:13px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}.num{font-family:Impact,"Arial Narrow",sans-serif;font-size:20px}.mut{color:var(--muted)}.row-link{text-decoration:none;border-bottom:1px solid var(--accent-text);font-weight:600}.row-link span{color:var(--accent-text)}
.state{display:inline-block;padding:2px 8px;border:1px solid currentColor;font-size:10px;letter-spacing:.1em;text-transform:uppercase;white-space:nowrap}.state.good{color:var(--accent-text)}.state.bad{color:var(--red)}.state.muted{color:var(--muted)}.pill{display:inline-block;padding:2px 8px;border:1px solid currentColor;font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase}.warning{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 10px;background:var(--alert-bg);color:var(--on-alert);font-size:11px}.warning code{color:var(--on-alert);background:rgba(11,11,11,.12)}
.metric-list{display:flex;flex-direction:column;gap:10px}.metric-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px 18px;padding:14px 16px;border:1px solid var(--line);text-decoration:none}.metric-row:hover{border-color:var(--accent-text)}.metric-name{font-family:Impact,"Arial Narrow",sans-serif;font-size:20px;text-transform:uppercase;overflow-wrap:anywhere}.metric-number{font-size:34px;line-height:1}.good-text{color:var(--accent-text)}.bad-text{color:var(--red)}.bar{grid-column:1/-1;display:block;height:9px;background:var(--faint)}.bar i{display:block;height:100%;background:var(--lime)}.metric-row:has(.bad-text) .bar i{background:var(--red)}.metric-detail{grid-column:1/-1;color:var(--muted);font-size:11px}
.plain{list-style:none;padding:0;border:1px solid var(--line)}.plain li{padding:13px 15px;border-bottom:1px solid var(--line)}.plain li:last-child{border-bottom:0}.plain li>span{color:var(--soft)}.edge-list li{display:flex;flex-direction:column;gap:7px}.edge-title{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-family:Impact,"Arial Narrow",sans-serif;font-size:20px;text-transform:uppercase}.edge-title .arrow{color:var(--accent-text)}.edge-title .mut{font-family:inherit;font-size:11px;text-transform:none}.edge-detail{color:var(--soft);font-size:11px}.external-list li{padding:0}.external-list details{padding:14px 15px}.external-list summary{cursor:pointer;display:flex;align-items:center;gap:12px;flex-wrap:wrap}.external-list summary code{color:var(--accent-text);font-size:14px}.external-list summary .mut{font-size:11px}.external-list details[open]{border-left:3px solid var(--lime)}
.graph-section{border-top:1px solid var(--line);border-left:0;border-right:0;background:none;padding-left:0;padding-right:0}.graph-wrap{padding:14px;border:1px solid var(--line);background:var(--panel-bg);overflow-x:auto}.graph-wrap svg{display:block;max-width:100%;height:auto}.node{fill:var(--card);stroke:var(--paper);stroke-width:1.2}.node.hot{stroke:var(--red);stroke-width:1.6}.node.ext{stroke:var(--muted);stroke-dasharray:4 3}.node-shadow{fill:var(--lime);opacity:.55}.edge{fill:none;stroke:var(--paper);stroke-width:1.4;marker-end:url(#arr)}.edge.warn{stroke:var(--red);stroke-dasharray:5 3}.eedge{fill:none;stroke:var(--muted);stroke-width:1;stroke-dasharray:2 4}.graph a{text-decoration:none}.graph a:hover .node{stroke:var(--accent-text)}
.details-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:12px}.detail-card{border:1px solid var(--line);background:var(--panel-bg);scroll-margin-top:20px}.detail-card:target{border-color:var(--accent-text);box-shadow:7px 7px 0 rgba(200,242,36,.3)}.detail-card summary{cursor:pointer;display:flex;flex-direction:column;align-items:flex-start;gap:7px;padding:16px}.detail-card summary strong{font-family:Impact,"Arial Narrow",sans-serif;font-size:25px;line-height:.95;text-transform:uppercase;overflow-wrap:anywhere}.detail-card summary .state{font-family:inherit}.detail-kind{color:var(--muted);font-size:10px;letter-spacing:.12em;text-transform:uppercase}.detail-body{padding:0 16px 18px}.detail-body dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 13px;padding:14px 0;border-top:1px solid var(--line)}.detail-body dl div{display:contents}.detail-body dt,.detail-label{color:var(--muted);font-size:10px;letter-spacing:.1em;text-transform:uppercase}.detail-body dd{margin:0;overflow-wrap:anywhere;color:var(--paper);font-size:11px}.detail-group{padding-top:13px;margin-top:13px;border-top:1px solid var(--line)}.group-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;font-family:Impact,"Arial Narrow",sans-serif;font-size:14px;letter-spacing:.06em;text-transform:uppercase}.group-head b{font-size:20px;color:var(--accent-text);font-weight:400}.detail-group ul{list-style:none;display:flex;flex-direction:column;gap:6px;padding:0}.detail-group li{display:flex;gap:8px;align-items:flex-start;font-size:11px;line-height:1.5}.tag{flex:none;padding:0 5px;background:var(--paper);color:var(--bg);font-size:9px;letter-spacing:.08em;text-transform:uppercase}.detail-body .mut{font-size:11px}
footer{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:10px}footer b{color:var(--accent-text);font-weight:400}@media (max-width:640px){main{padding-left:18px;padding-right:18px}.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.tile{min-height:98px}.tile .n{font-size:47px}.panel h2{font-size:31px}.metric-row{grid-template-columns:minmax(0,1fr) auto}.details-grid{grid-template-columns:minmax(0,1fr)}}@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}.dot{animation:none}.tile{transition:none}}
${apiMap ? `${API_MAP_CSS}\n.api-map-panel .am h2{font-size:clamp(30px,4vw,48px);line-height:.92;margin-bottom:12px}.api-map-panel .am p,.api-map-panel .am dd{font-size:12px}.api-map-panel .am table{font-size:12px}\n` : ""}</style>
</head>
<body>
<main>
${renderReportTheme("dark")}
<header class="topline"><span class="brand">${esc(PRODUCT)}<i>.</i></span><span class="status"><i class="dot${coverage.probed ? "" : " cold"}"></i>${esc(coverage.text)}</span><span class="status">generated ${esc(model.generated_at)}</span></header>
<section class="hero"><span class="eyebrow">// ${esc(PRODUCT)} map / ${esc(rootName)}</span><h1>API<br><span class="lime">footprint.</span></h1><p class="lede">${esc(model.root)} · <code>${esc(CLI_NAME)} map</code> — derived from repository files and recorded results where available. Use the signal cards to jump through the map, or click a graph node for its record.</p></section>
${model.map_execution ? `<section class="panel"><h2>Declared reads</h2><p>${esc(coverageStatement(model))}. These reads checked HTTP success; they do not verify the complete response schema.</p><ul class="plain">${model.map_execution.requests.map(row => `<li><strong>${esc(row.stack ?? row.service)}</strong> / ${esc(row.environment)} · <code>${esc(row.method)} ${esc(row.path)}</code> — ${esc(row.status ?? row.refusal ?? "no response")}</li>`).join("")}${model.map_execution.omitted.map(row => `<li>Omitted ${row.count} from ${esc(row.stack ?? row.service)}: ${esc(row.reason)}</li>`).join("")}</ul></section>` : ""}
${apiMap ? `<div class="panel panel-primary api-map-panel">${renderApiMapHtml(apiMap)}</div>\n` : renderCodeIndexHtml(model.code)}<nav class="tiles" aria-label="Map views">${tiles}</nav>
${serviceSection}${opsSection}${edgeSection}${bareSection}${shadowSection}${findingsSection}${platformSection}
<section class="panel graph-section" id="graph"><div class="panel-head"><div><span class="eyebrow">// service topology</span><h2>Service graph</h2></div><span class="basis">click a node for detail</span></div><div class="graph-wrap">${graphSvg(model)}</div></section>
${detailSection}${extSection}
${model.omissions?.length ? `<section class="panel" id="omissions"><div class="panel-head"><h2>Omissions</h2></div><ul class="plain">${model.omissions.map(omission => `<li><strong>${esc(omission.code)}</strong> <code>${esc(omission.file)}</code><span> — ${esc(omission.message)}</span></li>`).join("")}</ul></section>` : ""}
<footer><span>Internal services are solid boxes; external hosts are dashed.</span><span><b>${esc(PRODUCT)}</b> · local snapshot · no API calls made by this artifact</span></footer>
</main>
</body>
</html>
`;
}
