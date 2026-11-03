import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenPostmanWorkspace } from "../lib/postman-workspace.mjs";
import { stableStringify } from "../lib/import.mjs";

const collection = (name, path) => ({ info: { name }, item: [{ name: "health", request: { method: "GET", url: `https://api.example.test/${path}` }, response: [{ code: 200 }] }] });

test("workspace flatten reuses the v2.1 importer for every collection", () => {
  const out = flattenPostmanWorkspace({ workspaces: [{ workspace: { id: "w1", name: "Team" } }],
    collections: [{ uid: "c1", collection: collection("Orders", "orders") }, { uid: "c2", collection: collection("Users", "users") }],
    environments: [{ uid: "e1", name: "local", values: [{ key: "baseUrl", value: "https://secret-must-not-cross", type: "default" }] }] });
  assert.deepEqual(out.collections.map((x) => x.name), ["orders", "users"]);
  assert.equal(out.collections[0].suite.requests[0].expect[0].status, 200);
  assert.deepEqual(Object.keys(out.environmentFacts), ["local"]);
  assert.deepEqual(out.environmentFacts.local.names, [{ name: "baseUrl", type: "default" }]);
  assert.equal(stableStringify(out).includes("secret-must-not-cross"), false);
  assert.equal(out.rollup.workspace[0].name, "Team");
});

test("same capture is byte-identical and changed source produces named drift", () => {
  const capture = { collections: [{ uid: "c1", collection: collection("Orders", "orders") }] };
  const a = flattenPostmanWorkspace(capture);
  const b = flattenPostmanWorkspace(capture, { previousRollup: a.rollup });
  assert.equal(stableStringify(a.rollup), stableStringify(b.rollup));
  const changed = { collections: [{ uid: "c1", collection: collection("Orders", "orders-v2") }, { uid: "c2", collection: collection("New", "new") }] };
  const c = flattenPostmanWorkspace(changed, { previousRollup: a.rollup });
  assert.deepEqual(c.rollup.diffs[0].drift.changed, ["health"]);
  assert.equal(c.rollup.diffs[1].drift, null);
});
