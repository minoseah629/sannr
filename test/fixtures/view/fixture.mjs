import { LAYOUT, ensureLayout } from '../../../lib/layout.mjs';
// Synthetic historical records: no live service, credentials, or network.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readContract } from "../../../lib/context.mjs";
import { recordViewModel } from "../../../lib/view-records.mjs";
import { registerRepo, grant, emptyRegistry, saveRegistry } from "../../../lib/registry.mjs";

export const AT = "2026-09-08T12:00:00.000Z";
export function seedViewFixture(root) {
  ensureLayout(root);
  writeFileSync(join(root, "openapi.json"), JSON.stringify({ openapi: "3.0.0", info: { title: "Fixture inventory", version: "1" }, paths: {
    "/items": { get: { responses: { 200: { description: "Items", content: { "application/json": { schema: { type: "object", properties: {
      state: { type: "string", enum: ["ready", "held"] }, owner: { type: "string", example: "CONTRACT_EXAMPLE_MUST_NOT_APPEAR" },
    } } } } } } } },
    "/draft": { post: { responses: { 201: { description: "Created" } } } },
  } }));
  const { digest } = readContract(join(root, "openapi.json"));
  const store = { v: 0, generated_at: "2026-09-07", api: { name: "Fixture inventory", contract: "openapi.json", contract_digest: digest }, operations: {
    "GET /items": { verified_at: "2026-09-07T12:00:00.000Z", verified_by: "ci", environment: "local", contract_digest: digest,
      effect: "read", fields: { owner: { distinct: 2, values: ["CUSTOMER_VALUE_MUST_NOT_APPEAR"] }, state: { distinct: 1, values: ["OBSERVED_ENUM_MUST_NOT_APPEAR"] } },
      body: { private: "BODY_MUST_NOT_APPEAR" }, headers: { "X-Customer": "HEADER_MUST_NOT_APPEAR" }, query: { q: "QUERY_MUST_NOT_APPEAR" },
      notes: ["Use the opaque cursor.", "Pagination was unavailable.", "Keep the response order."],
      notes_provenance: [{ by: "human", at: "2026-09-06" }, { by: "agent", at: "2026-09-06", kind: "learn_reachability_failure" }, { by: "ci", at: "2026-09-07", pass_id: "ci-pass-17" }],
      notes_superseded: [null, { at: "2026-09-07T12:00:00.000Z", by: "ci", reason: "successful_verification" }, null],
    },
    "POST /draft": { verified_at: null, effect: "write", fields: {}, notes: [] },
    "GET /legacy": { verified_at: "2025-01-01T12:00:00.000Z", effect: "read", fields: {}, shape_diverged_at: "2026-09-07" },
  }, verdicts: { "POST /draft": { verdict: "rejected", class: "structural", reason: "No idempotency declaration.", last_confirmed: "2026-09-07", recorded_at: "2026-09-07", recorded_by: "human", held_by: "org" } },
  mcp_inspections: [{ at: "2026-09-07T13:00:00.000Z", initialized: true,
    server: { name: "catalog-tools", label: "catalog", version: "1", protocolVersion: "2025-06-18", transport: "stdio" }, capabilities: { tools: {}, experimental: { internal: "CAPABILITY_VALUE_MUST_NOT_APPEAR" } },
    instructions: "The server claims read-only inventory access.", declared: {
      tools: [{ name: "list_items", inputSchema: { type: "object", properties: { cursor: { type: "string" } } }, outputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
      resources: { state: "not_declared" }, resourceTemplates: { state: "not_declared" }, prompts: { state: "not_declared" },
    }, measured: [{ tool: "list_items", observed: { result_kind: "object", matches_output_schema: true, fields: [{ name: "items", type: "array" }] } }],
    diff: { since: "2026-09-06T13:00:00.000Z", tools: { added: [], removed: [], changed: [{ name: "list_items", changes: ["input field added: cursor"] }] } },
  }] };
  writeFileSync(join(root, LAYOUT.context), JSON.stringify(store));
  const finding = (op, kind, severity = "high") => ({ key: `${op}:${kind}`, service: "inventory", op, kind, severity, where: "inventory" });
  const accepted = finding("GET /items", "schema-mismatch");
  writeFileSync(join(root, LAYOUT.baseline), JSON.stringify({ version: 1, generated_at: "2026-09-06", findings: [accepted] }));
  const options = { at: "2026-09-07T14:00:00.000Z", head: "1111111111111111111111111111111111111111" };
  recordViewModel(root, "audit", { added: [finding("GET /new", "missing")], resolved: [finding("GET /old", "missing")], unchanged: 1,
    baselineGeneratedAt: "2026-09-06", noExecute: false, reportOnly: true, freshness: [{ op: "POST /draft", state: "unverified", why: "never executed", where: "inventory" }] },
    { ...options, basis: "Fixture audit: 2 responses recorded against env local" });
  recordViewModel(root, "map", { version: 1, root: "fixture-project", generated_at: "2026-09-07 14:00", summary: { services: 1, operations: 2, edges: 1, external: 0, shadow: 0, findings: 1, high: 1 },
    services: [{ id: "inventory", name: "inventory", kind: "documented", ops: 2, repo: "inventory", owner: "human", reachable: true, findings: [{ ...accepted, detail: "OBSERVED_FINDING_VALUE_MUST_NOT_APPEAR" }], shadow: [] }],
    edges: [{ from: "frontend", to: "inventory", via: "src/client.mjs", operations: ["GET /items"] }], external: [], platform: [],
  }, { ...options, basis: "Fixture map from declarations and 2 recorded responses against env local" });
  recordViewModel(root, "import", { suite: "collection", source_kind: "postman-v2.1", counts: { items: 3, imported: 2, todo: 1,
    assertions_translated: 1, assertions_derived_from_examples: 1, scripts_needing_manual_conversion: 1, scripts_quarantined: [{ script: "test", reason: "unsupported dynamic expression", source: "item-3" }] },
    items: [{ id: "item-1", status: "imported", notes: ["translated assertion"] }, { id: "item-2", status: "imported", notes: ["inferred from example"] }, { id: "item-3", status: "todo", notes: ["NO_ASSERTIONS: no supported assertion"] }],
  }, { ...options, source: "collection", basis: "Imported collection; not executed" });
  mkdirSync(join(root, LAYOUT.suites), { recursive: true });
  writeFileSync(join(root, LAYOUT.suites, "legacy.provenance.json"), JSON.stringify({ source_kind: "bruno", imported_at: "2026-08-01" }));
  const name = root.split("/").at(-1);
  writeFileSync(join(root, "usage.jsonl"), [
    { project: name, ts: "2026-09-07T14:00:00.000Z", knownNotes: 2, knownOp: "GET /items", tokensSaved: 40 },
    { project: "UNRELATED_MACHINE_PROJECT", ts: AT, knownNotes: 999, knownOp: "GET /private", tokensSaved: 99999 },
  ].map(x => JSON.stringify(x)).join("\n"));
  const registry = emptyRegistry();
  const self = registerRepo(registry, root, { name: "inventory" });
  // The granted provider exists (with no store yet); a vanished one would be
  // named with its random registry id, which a golden page cannot hold.
  mkdirSync(join(root, "billing"), { recursive: true });
  const provider = registerRepo(registry, join(root, "billing"), { name: "billing" });
  grant(registry, self.id, provider.id);
  registry.grants[0].granted_at = "2026-09-06T12:00:00.000Z";
  saveRegistry(registry, { SANNR_HOME: join(root, "home") });
  return store;
}
