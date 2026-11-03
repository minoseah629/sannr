import { basename } from "node:path";
import { activeNotes } from "./context.mjs";

// The savings receipt (F6c, PRD Track A2). The cold-agent harness measured it:
// the agent uses the tool and never once argues for it. So the tool must emit
// its own value as numbers a human reads to justify the spend. This module
// turns the usage log into that number — and its one governing rule is that it
// COUNTS, it never estimates. Every figure here is a sum over rows the client
// actually wrote at request time:
//
//   tokens saved   — tokensSaved per row, the measured raw-body-vs-envelope
//                    delta (net: rows where the envelope cost MORE subtract).
//   gotchas reused — knownNotes per row: notes the client DELIVERED in the
//                    `known` block, logged at the moment of delivery. Rows
//                    predating that field count zero, deliberately: matching
//                    old rows against the CURRENT context file would claim
//                    credit for notes that may not have existed when the
//                    request ran. Undercounting is honest; reconstruction is
//                    fabrication.
//   drift surfaced — rows whose drift array is non-empty, by kind.
//
// The context file is read only to show WHICH notes an operation carries — the
// display text next to a count the log already proved. It never adds to any
// count. Pure over (rows, ctx): no I/O here, so the arithmetic is testable
// without a filesystem and the CLI owns every path decision.

// --- scope --------------------------------------------------------------
// USAGE_LOG is deliberately global across repos (client.mjs's own comment:
// "so it accumulates into a real answer about where API work actually
// goes"). A human standing in ONE repo asking for a receipt does not mean
// that — they mean this repo. Found 2026-08-23 via a real alpha report: a
// two-route skeleton's feedback claimed 1,339 calls and 92 gotchas reused,
// because every other project tested on the same machine had been silently
// folded in. Each row already carries `project: basename(cwd)` at request
// time (client.mjs) — a weak key (two differently-located repos sharing a
// folder name collide) but the one that exists, and good enough to fix a
// report that was flatly impossible to reconcile.
export function scopeToProject(rows, root) {
  const name = basename(root);
  return rows.filter((r) => r.project === name);
}

// --- the window -------------------------------------------------------------
// "24h", "7d", "90m", "2w", or an ISO date. Returns an epoch ms floor, or null
// for an unrecognised spec — the CALLER must treat null as a usage error. A
// wrong window silently ignored would answer for the whole log while the human
// believes they are reading a day, which is misreporting, the receipt's one sin.
export function parseSince(spec, now = Date.now()) {
  if (!spec) return null;
  const rel = /^(\d+)([mhdw])$/.exec(spec.trim());
  if (rel) {
    const ms = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2]];
    return now - Number(rel[1]) * ms;
  }
  const abs = Date.parse(spec);
  return Number.isNaN(abs) ? null : abs;
}

// --- the arithmetic ---------------------------------------------------------
export function buildReceipt(rows, ctx, { sinceMs = null, log = null, logs = null } = {}) {
  const inWindow = sinceMs == null ? rows
    : rows.filter((r) => Date.parse(r.ts) >= sinceMs);

  // Same divisor the client used to compute tokensSaved, so raw/envelope/saved
  // stay one consistent arithmetic rather than three estimates.
  const tok = (bytes) => Math.ceil((bytes ?? 0) / 4);
  const tokens = {
    raw: inWindow.reduce((s, r) => s + tok(r.rawBytes), 0),
    envelope: inWindow.reduce((s, r) => s + tok(r.envelopeBytes), 0),
    saved: inWindow.reduce((s, r) => s + (r.tokensSaved ?? 0), 0),
    calls_where_envelope_cost_more: inWindow.filter((r) => (r.tokensSaved ?? 0) < 0).length,
  };

  // Gotchas: only rows that LOGGED a delivery. The per-op breakdown attaches
  // the current note texts as display — if the file has since changed or is
  // absent, the counts stand alone, because the log is the evidence.
  const served = inWindow.filter((r) => (r.knownNotes ?? 0) > 0);
  const byOp = new Map();
  for (const r of served) {
    const e = byOp.get(r.knownOp) ?? { op: r.knownOp, requests: 0, notes_delivered: 0 };
    e.requests += 1;
    e.notes_delivered += r.knownNotes;
    byOp.set(r.knownOp, e);
  }
  const operations = [...byOp.values()]
    .sort((a, b) => b.notes_delivered - a.notes_delivered)
    .map((e) => ({ ...e, notes: activeNotes(ctx?.operations?.[e.op]) ?? [] }));
  const gotchas = {
    requests_served: served.length,
    notes_delivered: served.reduce((s, r) => s + r.knownNotes, 0),
    operations,
  };
  // Cross-repo delivery is a distinct value claim: the notes arrived through
  // a grant rather than from this repo's own context. The client records only
  // a provider hash at request time, so this breakdown can never expose a
  // provider's filesystem path.
  const granted = served.filter((r) => typeof r.knownProviderHash === "string");
  const providers = new Map();
  for (const r of granted) {
    const p = providers.get(r.knownProviderHash) ?? {
      provider_hash: r.knownProviderHash, requests_served: 0, notes_delivered: 0,
    };
    p.requests_served += 1;
    p.notes_delivered += r.knownNotes;
    providers.set(r.knownProviderHash, p);
  }
  gotchas.grant_delivered = {
    requests_served: granted.length,
    notes_delivered: granted.reduce((s, r) => s + r.knownNotes, 0),
    providers: [...providers.values()],
  };
  // Rows the old client wrote, before delivery logging existed. Named so the
  // human knows the count is a floor, without those rows adding to anything.
  const legacy = inWindow.filter((r) => !("knownNotes" in r)).length;
  if (legacy) gotchas.rows_predating_delivery_log = legacy;

  const tally = (xs) => xs.reduce((a, k) => (a[k] = (a[k] ?? 0) + 1, a), {});
  const drifted = inWindow.filter((r) => r.drift?.length);
  const frictioned = inWindow.filter((r) => r.friction);

  const receipt = {
    ...(log ? { log } : {}),
    ...(logs ? { logs } : {}),
    window: {
      since: sinceMs == null ? null : new Date(sinceMs).toISOString(),
      from: inWindow[0]?.ts ?? null,
      to: inWindow.at(-1)?.ts ?? null,
    },
    calls: inWindow.length,
    tokens,
    gotchas,
    drift: { calls: drifted.length, kinds: tally(drifted.flatMap((r) => r.drift)) },
    friction: { captured: frictioned.length, kinds: tally(frictioned.map((r) => r.friction)) },
  };
  receipt.bottom_line = bottomLine(receipt);
  return receipt;
}

// The sentence a human actually reads. "~" belongs on the token figure alone:
// tokens are chars/4, an approximation by construction; the gotcha and drift
// counts are exact. A zero window says zero in plain words — an empty receipt
// that still sounds valuable would be the tool doing the advocacy F6c proved
// the agent will not, with numbers it does not have.
function bottomLine(r) {
  if (!r.calls)
    return "this window: no recorded API calls — 0 tokens saved, 0 gotchas reused. Nothing claimed.";
  const parts = [
    r.tokens.saved < 0
      ? `~${r.tokens.saved} tokens saved (envelopes cost more than raw here)`
      : `~${r.tokens.saved} tokens saved (envelopes vs raw responses)`,
    `${r.gotchas.notes_delivered} gotchas reused instead of rediscovered`,
  ];
  if (r.drift.calls) parts.push(`${r.drift.calls} call${r.drift.calls === 1 ? "" : "s"} with drift surfaced`);
  // Per-call envelope size only: agent turns, standing context and session
  // cost are not measured here (README "What this alpha claims").
  return `this window: ${parts.join(", ")} (${r.calls} call${r.calls === 1 ? "" : "s"}; not a session cost measure).`;
}

// --- the human rendering ----------------------------------------------------
export function renderReceipt(r) {
  const lines = [];
  const span = r.window.from ? `  ${r.window.from.slice(0, 10)} .. ${r.window.to.slice(0, 10)}` : "";
  lines.push(`${r.calls} call${r.calls === 1 ? "" : "s"}${span}${r.window.since ? `  (since ${r.window.since})` : ""}`);
  if (r.logs?.length) {
    lines.push("logs (machine-wide rows before project/date scoping):");
    for (const log of r.logs) lines.push(`  ${log.source}: ${log.path} (${log.rows} rows)`);
  } else if (r.log) lines.push(`log: ${r.log}`);
  lines.push("");
  lines.push("tokens vs returning raw bodies");
  lines.push(`  raw ~${r.tokens.raw.toLocaleString()}  envelopes ~${r.tokens.envelope.toLocaleString()}  saved ~${r.tokens.saved.toLocaleString()}`);
  if (r.tokens.calls_where_envelope_cost_more)
    lines.push(`  calls where the envelope cost MORE than raw: ${r.tokens.calls_where_envelope_cost_more}`);
  lines.push("");
  lines.push(`gotchas served from the context file: ${r.gotchas.notes_delivered}` +
    ` (on ${r.gotchas.requests_served} request${r.gotchas.requests_served === 1 ? "" : "s"})`);
  for (const o of r.gotchas.operations) {
    lines.push(`  ${o.op} — ${o.notes_delivered} delivered over ${o.requests} request${o.requests === 1 ? "" : "s"}`);
    for (const n of o.notes) lines.push(`    · ${n}`);
  }
  const grants = r.gotchas.grant_delivered;
  if (grants) {
    lines.push(`gotchas delivered through grants: ${grants.notes_delivered}` +
      ` (on ${grants.requests_served} request${grants.requests_served === 1 ? "" : "s"})`);
    for (const p of grants.providers)
      lines.push(`  provider ${p.provider_hash} — ${p.notes_delivered} delivered over ${p.requests_served} request${p.requests_served === 1 ? "" : "s"}`);
  }
  if (r.gotchas.rows_predating_delivery_log)
    lines.push(`  (${r.gotchas.rows_predating_delivery_log} older row(s) predate delivery logging and count zero)`);
  lines.push("");
  lines.push(`drift surfaced: ${r.drift.calls} call${r.drift.calls === 1 ? "" : "s"}`);
  for (const [k, n] of Object.entries(r.drift.kinds)) lines.push(`  ${k}: ${n}`);
  if (r.friction.captured) {
    lines.push(`friction learning moments captured: ${r.friction.captured}`);
    for (const [k, n] of Object.entries(r.friction.kinds)) lines.push(`  ${k}: ${n}`);
  }
  lines.push("");
  lines.push(r.bottom_line);
  return lines.join("\n");
}
