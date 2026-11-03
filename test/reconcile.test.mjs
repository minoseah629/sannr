import { test } from "node:test";
import assert from "node:assert/strict";
import { alignOperations, reconciliationModel, renderReconciliationGfm, renderReconciliationText } from "../lib/reconcile.mjs";

test("reconciliation matches exact, normalized parameters, and prefixes explainably", () => {
  const out = alignOperations(
    [{ method: "get", path: "/orders/{id}" }, { method: "POST", path: "/v1/orders" }, { method: "GET", path: "/missing" }],
    [{ op: "GET /orders/:orderId" }, { op: "POST /api/v1/orders" }, { op: "GET /else" }], { prefixes: ["/api"] });
  assert.deepEqual(out.rows.map((r) => [r.status, r.rule]), [["matched", "normalized path params"], ["matched", "prefix-stripped"], ["unmatched", null]]);
  assert.deepEqual(out.measuredUntouched, ["GET /else"]);
});

test("ambiguous matches remain ambiguous and renderers share one model", () => {
  const model = reconciliationModel({ imported: [{ op: "GET /orders/123" }], measured: [{ op: "GET /orders/:id" }, { op: "GET /orders/{orderId}" }] });
  assert.equal(model.counts.ambiguous, 1);
  assert.match(renderReconciliationText(model), /ambiguous/);
  assert.match(renderReconciliationGfm(model), /ambiguous/);
});

test("reconciliation refuses secret-shaped document content", () => {
  assert.throws(() => reconciliationModel({ imported: [{ op: "GET /orders?api_key=secret" }], measured: [] }), { code: "RECONCILE_SECRET_REFUSED" });
});

test("gateway reconciliation exposes a fourth gateway-only count", () => {
  const model = reconciliationModel({ imported: [{ op: "GET /orders/{id}" }], measured: [{ op: "GET /orders/:id" }], gateway: [{ op: "GET /orders/{orderId}" }, { op: "POST /admin" }] });
  assert.equal(model.counts.gateway_only_routes, 1);
  assert.match(renderReconciliationGfm(model), /Gateway-only routes: \*\*1\*\*/);
  assert.match(renderReconciliationGfm(model), /Gateway witness/);
});
