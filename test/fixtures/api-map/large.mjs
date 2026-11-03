// A 2,000-operation store: the operation-context capacity, every operation
// with one retained response and its evidence file, a tenth with notes and a
// quarter with key sources. Synthetic and deterministic.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LAYOUT } from "../../../lib/layout.mjs";
import { contextShape, operationId } from "../../../lib/operation-context.mjs";

const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const sha256 = text => `sha256:${createHash("sha256").update(text).digest("hex")}`;

export function seedLargeStore(root, { operations = 2000 } = {}) {
  const provider = "https://api.large.test", paths = {};
  const ops = [];
  for (let i = 0; ops.length < operations; i++) {
    const path = i % 2 ? `/v1/hubs/{hubId}/r${i}/{itemId}` : `/v1/hubs/{hubId}/r${i}`;
    paths[path] = {};
    for (const method of i % 2 ? ["get", "put"] : ["get", "post"]) {
      if (ops.length >= operations) break;
      paths[path][method] = { tags: [`Group ${i % 40}`], summary: `Operation ${ops.length}`, responses: { 200: { description: "OK" } } };
      ops.push(`${method.toUpperCase()} ${path}`);
    }
  }
  const raw = JSON.stringify({ openapi: "3.0.3", info: { title: "Large", version: "1" }, paths });
  write(join(root, "contracts/large.json"), raw);
  write(join(root, LAYOUT.environments), JSON.stringify({ v: 1, default: "prod", environments: {
    prod: { baseUrl: provider, contract: "contracts/large.json" } } }));
  const digest = sha256(raw), legacy = {}, context = {};
  ops.forEach((op, index) => {
    legacy[op] = { verified_at: null, fields: {}, notes: index % 10 ? [] : [`Note for operation ${index}.`],
      ...(index % 10 ? {} : { notes_provenance: [{ by: "agent", at: "2026-09-20" }], notes_superseded: [null] }) };
    const runId = `run-large-${String(index).padStart(5, "0")}`;
    const evidencePath = `${LAYOUT.evidence}/${runId}.json`, body = JSON.stringify({ runId, response: { status: 200 } });
    write(join(root, evidencePath), body);
    const identity = { provider, environment: "prod", protocol: "http", operation: op,
      endpoint: `${provider}${op.slice(op.indexOf(" ") + 1)}`, contractDigest: digest };
    const at = new Date(Date.parse("2026-09-01T00:00:00.000Z") + index * 60000).toISOString();
    context[operationId(identity)] = { identity, omitted_observations: 0, observations: [{ id: `obs-${index}`, recorded_at: at, observed_at: at,
      basis: "observed", source: { kind: "client", tool: "api_request:http" }, verification: "client-observation",
      outcome: index % 7 ? "success" : "error", complete: true, evidence: [{ path: evidencePath, digest: sha256(body) }],
      notes: [], omissions: [], response_status: index % 7 ? 200 : 500, request_shape: contextShape({ params: {}, body: null }).shape }],
      ...(index % 4 ? {} : { key_sources: [{ param: "hubId", location: "path", source: { operation: ops[0], field: "data[].id" },
        first_observed_at: at, last_observed_at: at, also_seen: 0, evidence: { run_id: runId, digest: sha256(body) } }] }) };
  });
  write(join(root, LAYOUT.context), JSON.stringify({ v: 0, generated_at: "2026-09-30",
    api: { name: "Large API", contract: "contracts/large.json", contract_digest: null }, operations: legacy,
    api_context: { v: 1, operations: context } }));
  return { operations: ops.length, store: join(root, LAYOUT.context) };
}
