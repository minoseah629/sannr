// A synthetic consumer of a hub-and-spokes API. No live service, no network,
// no credentials: every record below is written by hand in the exact shapes
// the client stores, using the product's own shape, identity and note
// functions, so the map is tested against what a real capture would leave.
// Evidence files carry planted marker values in URLs, headers and bodies; the
// map must hash them for identity and never show their content.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LAYOUT } from "../../../lib/layout.mjs";
import { contextShape, operationId } from "../../../lib/operation-context.mjs";
import { noteIdentity } from "../../../lib/context.mjs";

export const AT = "2026-10-01T12:00:00.000Z";
export const PROVIDER = "https://api.hearth.test";
export const STAGING = "https://staging.hearth.test";
export const CONTRACT = "contracts/hearth.openapi.json";
// Values that exist only in private evidence and the process environment.
export const MARKERS = Object.freeze({
  hub: "HUB_VALUE_7Q2X", task: "TASK_VALUE_3K8P", member: "MEMBER_VALUE_5D1M",
  query: "QUERY_VALUE_8R3W", cursor: "CURSOR_VALUE_9S4N", credential: "CRED_VALUE_5T6Z",
  body: "BODY_VALUE_6U7Y", token: "TOKEN_VALUE_4V5H",
});

const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const sha16 = text => `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;

const op = (summary, tags, parameters) => ({ ...(tags ? { tags } : {}), summary,
  ...(parameters ? { parameters } : {}), responses: { 200: { description: "OK" } } });
const query = name => ({ name, in: "query", schema: { type: "string" } });

export function hearthContract() {
  return {
    openapi: "3.0.3",
    info: { title: "Hearth API", version: "2.4.0" },
    servers: [{ url: PROVIDER }],
    tags: [{ name: "Hubs" }, { name: "Members" }, { name: "Tasks" }, { name: "Lists" }],
    components: { parameters: { Limit: { name: "limit", in: "query", schema: { type: "integer" } } } },
    paths: {
      "/v1/hubs": { get: op("List hubs", ["Hubs"], [{ $ref: "#/components/parameters/Limit" }]), post: op("Create a hub", ["Hubs"]) },
      "/v1/hubs/{hubId}": { parameters: [{ name: "hubId", in: "path", required: true }],
        get: op("Get a hub", ["Hubs"]), patch: op("Rename a hub", ["Hubs"]) },
      "/v1/hubs/{hubId}/members": { get: op("List members", ["Members"], [query("role")]) },
      "/v1/hubs/{hubId}/members/{memberId}": { get: op("Get a member", ["Members"]), delete: op("Remove a member", ["Members"]) },
      "/v1/hubs/{hubId}/tasks": { parameters: [query("status")],
        get: op("List tasks", ["Tasks"], [{ $ref: "#/components/parameters/Limit" }]), post: op("Create a task", ["Tasks"]) },
      "/v1/hubs/{hubId}/tasks/{taskId}": { get: op("Get a task", ["Tasks"]), put: op("Replace a task", ["Tasks"]) },
      "/v1/hubs/{hubId}/tasks/{taskId}/history": { get: op("Task history", ["Tasks"]) },
      "/v1/hubs/{hubId}/lists": { get: op("List lists", ["Lists"]) },
      "/v1/hubs/{hubId}/lists/{listId}/items": { get: op("List items") },
      "/v1/hubs/{hubId}/events": { get: op("Hub events") },
      "/v1/me": { get: op("Current member") },
    },
  };
}

const evidenceRef = (runId, operation, at, digest) => ({ run_id: runId, state: "available", digest,
  provenance: { initiator: "mcp.api_request", transport: "api_request:http", observed_at: at, package_version: "0.1.0-alpha.9", build_id: null },
  scope: { operation, protocol: "http", environment: "production", provider: PROVIDER, contract_digest: null } });

/**
 * Seed the fixture under `root`. Returns the store object and the names a test
 * needs to mutate it. `withSource` adds a source file that calls the API, so
 * the footprint has an external upstream and no served service; without it
 * the contract also omits `servers`, leaving no outbound reference anywhere.
 */
export function seedApiMapFixture(root, { withSource = true } = {}) {
  const contract = hearthContract();
  if (!withSource) delete contract.servers;
  const raw = JSON.stringify(contract, null, 2) + "\n";
  write(join(root, CONTRACT), raw);
  const contractDigest = sha256(raw), storedDigest = sha16(raw);
  write(join(root, LAYOUT.environments), JSON.stringify({ v: 1, default: "production", environments: {
    production: { baseUrl: PROVIDER, contract: CONTRACT, auth: "bearer:HEARTH_TOKEN", production: true },
    staging: { baseUrl: STAGING, contract: CONTRACT, auth: "bearer:HEARTH_STAGING_TOKEN" },
  } }, null, 2) + "\n");
  if (withSource) write(join(root, "src/hearth-client.mjs"),
    'export const listHubs = () => fetch("https://api.hearth.test/v1/hubs", { headers: { accept: "application/json" } });\n');

  // Private evidence, written the way the client writes it, with values.
  const evidence = {};
  const writeEvidence = (runId, method, url, status, body, headers = {}) => {
    const path = `${LAYOUT.evidence}/${runId}.json`;
    const text = JSON.stringify({ runId, origin: { initiator: "mcp.api_request" },
      request: { method, url, headers: { accept: "application/json", ...headers }, body: null, authUsed: "bearer:HEARTH_TOKEN" },
      response: { status, headers: { "content-type": "application/json" }, body }, durationMs: 41 }, null, 2);
    write(join(root, path), text);
    evidence[runId] = { path, digest: sha256(text) };
    return evidence[runId];
  };
  const M = MARKERS;
  const hubUrl = `${PROVIDER}/v1/hubs/${M.hub}`;
  const E = {
    hubs: writeEvidence("run-0a1b2c3d-0001", "GET", `${PROVIDER}/v1/hubs?limit=10`, 200, { data: [{ id: M.hub, name: M.body }] }),
    hub: writeEvidence("run-0a1b2c3d-0002", "GET", hubUrl, 200, { id: M.hub, name: M.body },
      { authorization: `Bearer ${M.credential}` }),
    tasksFailed: writeEvidence("run-0a1b2c3d-0003", "GET", `${hubUrl}/tasks?status=${M.query}&sort=${M.query}`, 400, { error: M.body }),
    tasks: writeEvidence("run-0a1b2c3d-0004", "GET", `${hubUrl}/tasks?status=${M.query}&page_cursor=${M.cursor}`, 200,
      { data: [{ id: M.task, title: M.body }], meta: { page_cursor: M.cursor } }),
    task: writeEvidence("run-0a1b2c3d-0005", "GET", `${hubUrl}/tasks/${M.task}`, 200, { id: M.task, title: M.body }),
    member: writeEvidence("run-0a1b2c3d-0006", "GET", `${hubUrl}/members/${M.member}`, 404, { error: M.body }),
    me: writeEvidence("run-0a1b2c3d-0008", "GET", `${PROVIDER}/v1/me`, 200, { id: M.member, email: M.body }),
    lists: writeEvidence("run-0a1b2c3d-0009", "GET", `${hubUrl}/lists`, 200, { data: [{ id: M.body }] }),
    events: writeEvidence("run-0a1b2c3d-0010", "GET", `${STAGING}/v1/hubs/${M.hub}/events`, 200, { data: [{ id: M.body }] }),
  };
  // Referenced by an observation but never written: missing evidence.
  const missing = { path: `${LAYOUT.evidence}/run-0a1b2c3d-0007.json`, digest: sha256("never written") };

  const identity = (operation, { provider = PROVIDER, environment = "production", digest = contractDigest } = {}) => ({
    provider, environment, protocol: "http", operation,
    endpoint: `${new URL(provider).origin}${operation.slice(operation.indexOf(" ") + 1)}`, contractDigest: digest });
  const observation = (id, operation, at, status, ref, { assertions, params = {}, body = null, response = {} } = {}) => ({
    id, recorded_at: at, observed_at: at, basis: "observed", source: { kind: "client", tool: "api_request:http" },
    verification: "client-observation", outcome: status >= 200 && status < 300 ? "success" : "error", complete: true,
    evidence: [{ path: ref.path, digest: ref.digest }],
    notes: [`HTTP response status ${status}.`],
    omissions: ["Only bounded HTTP request and response structure is committed; payload values remain in private execution evidence.",
      "A completed HTTP response does not establish complete collection traversal."],
    response_status: status, attempts: 1,
    request_shape: contextShape({ params, body }).shape, response_shape: contextShape(response).shape,
    ...(assertions ? { assertions } : {}),
    declaration: { protocol: "http", method: operation.split(" ")[0], operation, schemaValidated: false,
      requestValidated: false, responseValidated: false, validationScope: "declared-method-and-path-only" } });
  const keySource = (param, location, sourceOperation, field, first, last, alsoSeen, ref, runId) => ({
    param, location, source: { operation: sourceOperation, field }, first_observed_at: first, last_observed_at: last,
    also_seen: alsoSeen, evidence: { run_id: runId, digest: ref.digest } });

  const operations = {};
  const entry = (id, observations, extra = {}) => {
    operations[operationId(id)] = { identity: id, observations, omitted_observations: 0, ...extra };
  };
  // Shapes only: the request's query parameter names and the response's
  // field names; the values here are placeholders and never stored.
  const listShape = { data: [{ id: "x", name: "x" }] };
  entry(identity("GET /v1/hubs"), [observation("obs-hubs-1", "GET /v1/hubs", "2026-09-28T09:00:00.000Z", 200, E.hubs,
    { assertions: { passed: 1, failed: 0 }, params: { limit: 10 }, response: listShape })]);
  entry(identity("GET /v1/hubs/{hubId}"), [observation("obs-hub-1", "GET /v1/hubs/{hubId}", "2026-09-28T09:05:00.000Z", 200, E.hub,
    { response: { id: "x", name: "x" } })], { key_sources: [
    keySource("hubId", "path", "GET /v1/hubs", "data[].id", "2026-09-28T09:05:00.000Z", "2026-09-28T09:05:00.000Z", 0, E.hubs, "run-0a1b2c3d-0001")] });
  entry(identity("GET /v1/hubs/{hubId}/tasks"), [
    observation("obs-tasks-1", "GET /v1/hubs/{hubId}/tasks", "2026-09-25T10:00:00.000Z", 400, E.tasksFailed,
      { params: { status: "x", sort: "x" }, response: { error: "x" } }),
    observation("obs-tasks-2", "GET /v1/hubs/{hubId}/tasks", "2026-09-26T10:01:00.000Z", 200, E.tasks,
      { assertions: { passed: 2, failed: 0 }, params: { status: "x", page_cursor: "x" }, response: { data: [{ id: "x", title: "x" }], meta: { page_cursor: "x" } } }),
  ], { key_sources: [
    keySource("hubId", "path", "GET /v1/hubs", "data[].id", "2026-09-25T10:00:00.000Z", "2026-09-26T10:01:00.000Z", 0, E.hubs, "run-0a1b2c3d-0001"),
    keySource("page_cursor", "query", "GET /v1/hubs/{hubId}/tasks", "meta.page_cursor", "2026-09-26T10:01:00.000Z", "2026-09-26T10:01:00.000Z", 0, E.tasks, "run-0a1b2c3d-0004"),
  ] });
  entry(identity("GET /v1/hubs/{hubId}/tasks/{taskId}"), [observation("obs-task-1", "GET /v1/hubs/{hubId}/tasks/{taskId}",
    "2026-09-27T08:00:00.000Z", 200, E.task, { response: { id: "x", title: "x" } })], { key_sources: [
    keySource("hubId", "path", "GET /v1/hubs", "data[].id", "2026-09-27T08:00:00.000Z", "2026-09-27T08:00:00.000Z", 0, E.hubs, "run-0a1b2c3d-0001"),
    keySource("taskId", "path", "GET /v1/hubs/{hubId}/tasks", "data[].id", "2026-09-27T08:00:00.000Z", "2026-09-27T08:00:00.000Z", 1, E.tasks, "run-0a1b2c3d-0004"),
  ] });
  // A damaged key-source list (a location outside the schema): its links are
  // treated as absent and the record is counted; the 404 stays readable.
  entry(identity("GET /v1/hubs/{hubId}/members/{memberId}"), [observation("obs-member-1", "GET /v1/hubs/{hubId}/members/{memberId}",
    "2026-09-27T08:30:00.000Z", 404, E.member, { response: { error: "x" } })], { key_sources: [
    { param: "memberId", location: "header", source: { operation: "GET /v1/hubs/{hubId}/members", field: "data[].id" },
      first_observed_at: "2026-09-27T08:30:00.000Z", last_observed_at: "2026-09-27T08:30:00.000Z", also_seen: 0,
      evidence: { run_id: "run-0a1b2c3d-0006", digest: E.member.digest } },
  ] });
  entry(identity("GET /v1/hubs/{hubId}/members"), [observation("obs-members-1", "GET /v1/hubs/{hubId}/members",
    "2026-09-27T09:00:00.000Z", 200, missing, { params: { role: "x" }, response: listShape })], { key_sources: [
    keySource("hubId", "path", "GET /v1/me", "hub_id", "2026-09-27T09:00:00.000Z", "2026-09-27T09:00:00.000Z", 0, E.me, "run-0a1b2c3d-0008")] });
  entry(identity("GET /v1/me"), [observation("obs-me-1", "GET /v1/me", "2026-09-29T07:00:00.000Z", 200, E.me,
    { assertions: { passed: 0, failed: 1 }, response: { id: "x", email: "x" } })]);
  entry(identity("GET /v1/hubs/{hubId}/lists"), [observation("obs-lists-1", "GET /v1/hubs/{hubId}/lists",
    "2026-01-10T12:00:00.000Z", 200, E.lists, { response: listShape })], { key_sources: [
    keySource("hubId", "path", "POST /v1/hubs", "id", "2026-01-10T12:00:00.000Z", "2026-01-10T12:00:00.000Z", 0, E.hubs, "run-0a1b2c3d-0001")] });
  // Another environment: retained, never counted for production.
  entry(identity("GET /v1/hubs/{hubId}/events", { provider: STAGING, environment: "staging" }), [observation("obs-events-1",
    "GET /v1/hubs/{hubId}/events", "2026-09-28T12:00:00.000Z", 200, E.events, { response: listShape })], { key_sources: [
    keySource("hubId", "path", "GET /v1/hubs", "data[].id", "2026-09-28T12:00:00.000Z", "2026-09-28T12:00:00.000Z", 0, E.hubs, "run-0a1b2c3d-0001")] });
  // An authored claim is not a client response.
  entry(identity("GET /v1/hubs/{hubId}/lists/{listId}/items"), [{ ...observation("obs-items-1", "GET /v1/hubs/{hubId}/lists/{listId}/items",
    "2026-09-28T13:00:00.000Z", 200, E.lists), basis: "authored", source: { kind: "external", tool: "api_context_record" },
    verification: "external-claim", outcome: "unknown", complete: false }]);
  // A capture under an older contract for a route this contract dropped.
  entry(identity("GET /v1/retired", { digest: sha256("an older contract") }), [observation("obs-retired-1", "GET /v1/retired",
    "2026-09-20T09:00:00.000Z", 200, E.hubs, { response: listShape })]);

  const legacy = (extra = {}) => ({ verified_at: null, contract_digest: null, shape_hash: null, status_codes: [], fields: {}, notes: [], ...extra });
  const authored = (by, at, evidenceRefs) => ({ by, at, ...(evidenceRefs ? { evidence: evidenceRefs } : {}) });
  const hubsOld = { text: "Hubs are listed newest first.", provenance: authored("agent", "2026-09-20") };
  const hubsNew = { text: "Hubs are listed by creation time, oldest first.", provenance: authored("agent", "2026-09-28") };
  const store = {
    v: 0, generated_at: "2026-09-30", api: { name: "Hearth API", contract: CONTRACT, contract_digest: storedDigest },
    operations: {
      "GET /v1/hubs": legacy({ verified_at: "2026-09-20T10:00:00.000Z", verified_by: "learn", environment: "production",
        contract_digest: storedDigest, effect: "read", notes: [hubsOld.text, hubsNew.text],
        notes_provenance: [hubsOld.provenance, hubsNew.provenance], notes_superseded: [null, null],
        note_replacements: [{ supersedes: noteIdentity(hubsOld.text, hubsOld.provenance),
          replacement: noteIdentity(hubsNew.text, hubsNew.provenance), by: "agent", at: "2026-09-28" }] }),
      "POST /v1/hubs": legacy({ effect: "write" }),
      "GET /v1/hubs/{hubId}": legacy(),
      "PATCH /v1/hubs/{hubId}": legacy({ effect: "write" }),
      "GET /v1/hubs/{hubId}/members": legacy(),
      "GET /v1/hubs/{hubId}/members/{memberId}": legacy({ notes: ["Removed members return 404, not 410."],
        notes_provenance: [authored("human", "2026-09-27", [evidenceRef("run-0a1b2c3d-0006", "GET /v1/hubs/{hubId}/members/{memberId}",
          "2026-09-27T08:30:00.000Z", E.member.digest)])], notes_superseded: [null] }),
      "DELETE /v1/hubs/{hubId}/members/{memberId}": legacy({ effect: "write" }),
      "GET /v1/hubs/{hubId}/tasks": legacy({ notes: ["Filter by status and page with page_cursor; the first page has no cursor."],
        notes_provenance: [authored("agent", "2026-09-26", [evidenceRef("run-0a1b2c3d-0004", "GET /v1/hubs/{hubId}/tasks",
          "2026-09-26T10:01:00.000Z", E.tasks.digest)])], notes_superseded: [null] }),
      "POST /v1/hubs/{hubId}/tasks": legacy({ effect: "write", notes: ["Send an Idempotency-Key header when creating a task."],
        notes_provenance: [authored("agent", "2026-09-24")], notes_superseded: [null] }),
      "GET /v1/hubs/{hubId}/tasks/{taskId}": legacy(),
      "PUT /v1/hubs/{hubId}/tasks/{taskId}": legacy({ effect: "write" }),
      "GET /v1/hubs/{hubId}/lists": legacy({ verified_at: "2026-01-05T09:00:00.000Z", verified_by: "learn", contract_digest: storedDigest,
        shape_diverged_at: "2026-09-01", notes: ["The list endpoint timed out during learn."],
        notes_provenance: [{ by: "agent", at: "2026-01-04", kind: "learn_reachability_failure" }], notes_superseded: [null] }),
      "GET /v1/hubs/{hubId}/lists/{listId}/items": legacy(),
      "GET /v1/hubs/{hubId}/events": legacy(),
      "GET /v1/me": legacy({ notes: ["Returns the caller's own member record."] }),
      "GET /v1/exports/legacy": legacy(),
    },
    api_context: { v: 1, operations },
  };
  write(join(root, LAYOUT.context), JSON.stringify(store, null, 2) + "\n");
  return { store, contractDigest, storedDigest, evidence: E, operationId: operation => operationId(identity(operation)) };
}

// The standing each operation must receive, written out by hand.
export const EXPECTED_STANDINGS = Object.freeze({
  "GET /v1/hubs": "observed",
  "POST /v1/hubs": "write-no-response",
  "GET /v1/hubs/{hubId}": "observed",
  "PATCH /v1/hubs/{hubId}": "write-no-response",
  "GET /v1/hubs/{hubId}/members": "latest-response",
  "GET /v1/hubs/{hubId}/members/{memberId}": "latest-response",
  "DELETE /v1/hubs/{hubId}/members/{memberId}": "write-no-response",
  "GET /v1/hubs/{hubId}/tasks": "observed-after-failure",
  "POST /v1/hubs/{hubId}/tasks": "write-no-response",
  "GET /v1/hubs/{hubId}/tasks/{taskId}": "observed",
  "PUT /v1/hubs/{hubId}/tasks/{taskId}": "write-no-response",
  "GET /v1/hubs/{hubId}/tasks/{taskId}/history": "no-response",
  "GET /v1/hubs/{hubId}/lists": "latest-response",
  "GET /v1/hubs/{hubId}/lists/{listId}/items": "no-response",
  "GET /v1/hubs/{hubId}/events": "no-response",
  "GET /v1/me": "latest-response",
  "GET /v1/exports/legacy": "scope-unresolved",
});
