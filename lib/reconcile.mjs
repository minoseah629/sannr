// Reconcile imported collection claims with the measured operation map.
// Identity only crosses this boundary: values, bodies, and secrets are refused.

import { secretIn } from "./verdicts.mjs";
import { summaryCell } from "./ci.mjs";

const METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/;

const cleanPath = (path) => {
  let out = String(path ?? "").trim();
  try { out = new URL(out).pathname; } catch { /* relative identity */ }
  out = out.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!out.startsWith("/")) out = `/${out}`;
  return out.length > 1 ? out.replace(/\/$/, "") : out;
};

export function operationIdentity(value) {
  const rawMethod = String(value?.method ?? value?.op?.split?.(" ")[0] ?? "GET").toUpperCase();
  const method = METHOD.test(rawMethod) ? rawMethod : "GET";
  const path = value?.path ?? value?.op?.slice?.(method.length)?.trim() ?? "/";
  return { method, path: cleanPath(path), op: `${method} ${cleanPath(path)}` };
}

function pathShape(path) {
  return cleanPath(path).split("/").map((part) => {
    if (/^\{[^}]+\}$/.test(part) || /^:[A-Za-z_$][\w$-]*$/.test(part)) return "{}";
    if (/^[0-9a-f]{8,}$/i.test(part) || /^\d+$/.test(part)) return "{}";
    return part;
  }).join("/") || "/";
}

function prefixStripped(path, prefixes = []) {
  for (const prefix of prefixes.map(cleanPath).filter((p) => p !== "/")) {
    if (path === prefix) return "/";
    if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length) || "/";
  }
  return path;
}

function rejectSecrets(value, where = "input") {
  if (typeof value === "string") {
    if (secretIn(value)) throw Object.assign(new Error(`${where} contains a secret-shaped value`), { code: "RECONCILE_SECRET_REFUSED" });
    return;
  }
  if (Array.isArray(value)) return value.forEach((v, i) => rejectSecrets(v, `${where}[${i}]`));
  if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) {
    if (secretIn(k)) throw Object.assign(new Error(`${where} contains a secret-shaped key`), { code: "RECONCILE_SECRET_REFUSED" });
    rejectSecrets(v, `${where}.${k}`);
  }
}

function asOps(input) {
  if (Array.isArray(input)) return input.map(operationIdentity);
  if (Array.isArray(input?.operations)) return input.operations.map(operationIdentity);
  if (Array.isArray(input?.services)) return input.services.flatMap((s) =>
    (s.operations ?? s.ops_list ?? []).map((op) => operationIdentity(op)));
  return [];
}

/**
 * Match imported requests to measured operations. Every match has exactly one
 * rule; collisions remain ambiguous and never select a winner.
 */
export function alignOperations(imported, measured, { prefixes = [] } = {}) {
  const left = asOps(imported), right = asOps(measured);
  const rows = left.map((claim) => {
    const exact = right.filter((op) => op.method === claim.method && op.path === claim.path);
    if (exact.length === 1) return { claim: claim.op, measured: exact[0].op, rule: "exact template", status: "matched" };
    if (exact.length > 1) return { claim: claim.op, candidates: exact.map((x) => x.op), rule: "exact template", status: "ambiguous" };
    const shaped = right.filter((op) => op.method === claim.method && pathShape(op.path) === pathShape(claim.path));
    if (shaped.length === 1) return { claim: claim.op, measured: shaped[0].op, rule: "normalized path params", status: "matched" };
    if (shaped.length > 1) return { claim: claim.op, candidates: shaped.map((x) => x.op), rule: "normalized path params", status: "ambiguous" };
    const stripped = right.filter((op) => op.method === claim.method && prefixStripped(op.path, prefixes) === claim.path);
    if (stripped.length === 1) return { claim: claim.op, measured: stripped[0].op, rule: "prefix-stripped", status: "matched" };
    if (stripped.length > 1) return { claim: claim.op, candidates: stripped.map((x) => x.op), rule: "prefix-stripped", status: "ambiguous" };
    return { claim: claim.op, rule: null, status: "unmatched" };
  });
  const claimed = new Set(rows.filter((r) => r.status === "matched").map((r) => r.measured));
  return { rows, measuredUntouched: right.filter((op) => !claimed.has(op.op)).map((op) => op.op) };
}

export function reconciliationModel({ imported, measured, gateway = [], findings = [], prefixes = [] } = {}) {
  rejectSecrets(imported, "imported operations");
  rejectSecrets(measured, "measured operations");
  rejectSecrets(findings, "audit findings");
  rejectSecrets(gateway, "gateway declarations");
  const alignment = alignOperations(imported, measured, { prefixes });
  const gatewayAlignment = alignOperations(gateway, measured, { prefixes });
  const gatewayToCollections = alignOperations(gateway, imported, { prefixes });
  const claims = asOps(imported).map((x) => x.op);
  const measuredOps = asOps(measured).map((x) => x.op);
  const gatewayOps = asOps(gateway).map((x) => x.op);
  const gatewaySeen = new Set([
    ...gatewayAlignment.rows.filter((r) => r.status === "matched").map((r) => r.claim),
    ...gatewayToCollections.rows.filter((r) => r.status === "matched").map((r) => r.claim),
  ]);
  return {
    version: 1,
    alignment,
    counts: {
      collection_knows_code_serves: alignment.rows.filter((r) => r.status === "matched").length,
      code_serves_collection_does_not_touch: alignment.measuredUntouched.length,
      collection_targets_missing_code: alignment.rows.filter((r) => r.status === "unmatched").length,
      ambiguous: alignment.rows.filter((r) => r.status === "ambiguous").length,
      declared_measured_disagreements: findings.length,
      gateway_only_routes: gatewayOps.filter((op) => !gatewaySeen.has(op)).length,
    },
    claims,
    measured: measuredOps,
    disagreements: findings.map((f) => ({ op: operationIdentity(f).op, kind: f.kind ?? "audit", detail: f.detail ?? "" })),
    gateway: gatewayOps,
    gatewayAlignment,
  };
}

const cell = summaryCell;

export function renderReconciliationGfm(model) {
  const rows = model.alignment.rows.map((r) => `| ${cell(r.claim)} | ${cell(r.measured ?? r.candidates?.join(", ") ?? "—")} | ${cell(r.status)} | ${cell(r.rule ?? "—")} |`);
  const gatewayRows = (model.gatewayAlignment?.rows ?? []).map((r) => `| ${cell(r.claim)} | ${cell(r.measured ?? r.candidates?.join(", ") ?? "—")} | ${cell(r.status)} | ${cell(r.rule ?? "—")} |`);
  return ["## Reconciliation", "", "| collection claim | measured operation | status | rule |", "|---|---|---|---|", ...rows,
    ...(gatewayRows.length ? ["", "### Gateway witness", "", "| gateway claim | measured operation | status | rule |", "|---|---|---|---|", ...gatewayRows] : []),
    "", `- Collection knows / code serves: **${model.counts.collection_knows_code_serves}**`,
    `- Code serves / collection does not touch: **${model.counts.code_serves_collection_does_not_touch}**`,
    `- Collection targets / code does not serve: **${model.counts.collection_targets_missing_code}**`,
    `- Declared vs measured disagreements: **${model.counts.declared_measured_disagreements}**`,
    `- Gateway-only routes: **${model.counts.gateway_only_routes ?? 0}**`].join("\n");
}

export function renderReconciliationText(model) {
  const lines = ["Reconciliation", "============="];
  for (const r of model.alignment.rows) lines.push(`${r.status.padEnd(10)} ${r.claim} → ${r.measured ?? r.candidates?.join(", ") ?? "—"} [${r.rule ?? "no match"}]`);
  if (model.gatewayAlignment?.rows?.length) {
    lines.push("", "Gateway witness");
    for (const r of model.gatewayAlignment.rows) lines.push(`${r.status.padEnd(10)} ${r.claim} → ${r.measured ?? r.candidates?.join(", ") ?? "—"} [${r.rule ?? "no match"}]`);
  }
  lines.push("", `estate knows / code serves: ${model.counts.collection_knows_code_serves}`,
    `code serves / estate does not touch: ${model.counts.code_serves_collection_does_not_touch}`,
    `estate targets missing code: ${model.counts.collection_targets_missing_code}`,
    `declared vs measured disagreements: ${model.counts.declared_measured_disagreements}`,
    `gateway-only routes: ${model.counts.gateway_only_routes ?? 0}`);
  return lines.join("\n");
}
