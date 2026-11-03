import { LAYOUT } from './layout.mjs';
// A snapshot, never an execution path. All grades and reports use their CLI
// owners; this module only selects promoted fields and renders plain HTML.
import { basename, join, resolve } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { PRODUCT } from "./brand.mjs";
import { reportThemeCss, renderReportTheme } from "./report-theme.mjs";
import { readContextState, liveContractDigest, freshnessFor, ageReason,
  readContract, responseSchema, inspectNoteHistory, withGitSnapshot } from "./context.mjs";
import { buildApiMapModel, renderApiMapHtml, API_MAP_CSS, escapeText, createWithholder, mergeWithheld,
  withheldSentence, operationElement, noteElement, apiMapStackScopes, collectStackApiMaps, attachCodeIndex, renderOperationCodeHtml } from "./api-map.mjs";
import { withStackScope, activeStackScopeFor } from './stack-scope.mjs';
import { readBaselineFile, renderCiSummary } from "./ci.mjs";
import { renderMapText } from "./map.mjs";
import { renderImportReport } from "./import.mjs";
import { renderMcpReport } from "./mcp-report.mjs";
import { schemaFacts } from "./mcp-facts.mjs";
import { renderVerdict } from "./verdicts.mjs";
import { readUsageSources } from "./feedback.mjs";
import { scopeToProject, buildReceipt } from "./receipt.mjs";
import { loadRegistry, resolveRef } from "./registry.mjs";
import { readViewRecords, secretOnPage, viewHead, viewError, viewMapModel,
  viewAuditModel, viewImportModel } from "./view-records.mjs";
import { buildSessionLedger } from "./session-ledger.mjs";
import { renderSessionLedgerHtml, renderSessionAttentionHtml } from "./session-ledger-render.mjs";
import { readCodeContext, withCodeLocations } from './code-locations.mjs';
import { operationAnchor, relativeViewHref } from './operation-anchor.mjs';

const sorted = object => Object.entries(object ?? {}).sort(([a], [b]) => a.localeCompare(b));
const STORE_CONTEXT = Symbol("store-context");
// One escaping rule for the whole page, the API map's: HTML-encoded, with
// control, bidirectional and format characters removed, so the same text
// renders the same way in every section.
const esc = escapeText;
const p = value => `<p>${esc(value)}</p>`;
const CONTRACT_STATES = Object.freeze({ missing: "is missing", unreadable: "is unreadable", empty: "declares no operations" });
const list = (items, empty) => items.length ? `<ul>${items.map(v => `<li>${v}</li>`).join("")}</ul>` : p(empty);
const section = (id, title, basis, body) => `<section id="${id}"><h2>${title}</h2><p class="basis">${esc(basis)}</p>${body}</section>`;
const recordBasis = record => `${record.basis}; ${record.at}; commit ${record.head ?? "not recorded"}.`;

function mcpForView(record) {
  // Capability flags are claims; arbitrary extension payloads are values.
  const claims = (value, depth = 0) => {
    if (typeof value === "boolean") return value;
    if (!value || typeof value !== "object" || depth > 16) return "value withheld";
    return Object.fromEntries(sorted(value).map(([key, child]) => [key, claims(child, depth + 1)]));
  };
  const declared = { ...record.declared };
  for (const key of ["resources", "resourceTemplates"])
    if (Array.isArray(declared[key])) declared[key] = declared[key].map(resource => ({
      uri: resource.name ?? "resource name not retained", mimeType: resource.mimeType,
    }));
  if (Array.isArray(declared.tools)) declared.tools = declared.tools.map(tool => ({
    ...tool, inputSchema: schemaFacts(tool.inputSchema),
    ...(tool.outputSchema !== undefined ? { outputSchema: schemaFacts(tool.outputSchema) } : {}),
  }));
  return { ...record, capabilities: claims(record.capabilities ?? {}), declared };
}

// Read only declared structure; examples, defaults, const, and observed values
// are deliberately absent. Bounds make a recursive schema a finite display.
function schemaFields(schema, path = "$", depth = 0) {
  if (!schema || depth > 24) return [];
  const type = Array.isArray(schema.type) ? schema.type.join(" | ") : schema.type ?? "unspecified";
  const rows = [{ name: path, type,
    ...(Array.isArray(schema.enum) ? { enum: schema.enum.filter(v => v === null || ["string", "number", "boolean"].includes(typeof v)) } : {}) }];
  for (const [name, value] of sorted(schema.properties)) rows.push(...schemaFields(value, `${path}.${name}`, depth + 1));
  if (schema.items) rows.push(...schemaFields(schema.items, `${path}[]`, depth + 1));
  for (const key of ["oneOf", "anyOf", "allOf"])
    for (const [i, value] of (schema[key] ?? []).entries()) rows.push(...schemaFields(value, `${path} ${key}[${i}]`, depth + 1));
  return rows;
}

function storedImportSources(root) {
  const dir = join(root, LAYOUT.suites);
  let files;
  try { files = readdirSync(dir).filter(f => f.endsWith(".provenance.json")).sort(); }
  catch (e) { if (e.code === "ENOENT") return []; throw viewError("VIEW_IMPORT_UNREADABLE", "Import provenance is unreadable."); }
  return files.map(file => {
    let source;
    try { source = JSON.parse(readFileSync(join(dir, file), "utf8")); }
    catch { throw viewError("VIEW_IMPORT_INVALID", "Import provenance is invalid JSON."); }
    return { name: file.replace(/\.provenance\.json$/, ""), kind: source.source_kind, at: source.imported_at };
  });
}

export function buildViewModel(root, options = {}) {
  // One snapshot: HEAD is asked once for every graded operation on the page.
  return withCodeLocations(root, () => withGitSnapshot(() => {
    const scopes = apiMapStackScopes(root, options);
    if (!scopes.length) return attachOperationEvidence(projectView(root, { ...options, ledger: true }));
    const snapshotOptions = { generatedAt: new Date().toISOString(), ...options };
    const views = scopes.map(scope => ({ scope, model: withStackScope(scope, () => projectView(root, snapshotOptions)) }));
    const api_map = attachCodeIndex(root, collectStackApiMaps(views.map(({ scope, model }) => ({ scope, api_map: model.api_map }))));
    // These categories belong to the repo baseline/import sources, receipt
    // and grants rendered once from the first model. Stack notes and their
    // other fields remain distinct even when their withheld text is equal.
    const repositoryKinds = new Set(['report-text', 'receipt-text', 'grant-text']);
    const withheld = mergeWithheld(views[0].model.withheld, ...views.slice(1).map(({ model }) =>
      Object.fromEntries(Object.entries(model.withheld).filter(([kind]) => !repositoryKinds.has(kind)))));
    // The session ledger spans every stack's evidence, so it is read once here.
    const sessions = buildSessionLedger(root, { env: options.env ?? process.env, now: Date.parse(snapshotOptions.generatedAt),
      contexts: views.map(({ scope, model }) => ({ stack: scope.stack, ctx: model[STORE_CONTEXT] ?? null })) });
    return attachOperationEvidence({ ...views[0].model, project: 'All stacks', api_map,
      stack_views: views.map(({ model }, index) => ({ name: api_map.stacks[index].name, model })),
      withheld: mergeWithheld(withheld, sessions.withheld), sessions });
  }), options);
}

function projectView(root, { generatedAt = new Date().toISOString(), env = process.env, ledger = false } = {}) {
  // One read of the store: graded and projected from the same bytes. The page
  // never refuses because of content: every value it would show passes the
  // secret scan here and, when flagged, reads "withheld" and is counted by
  // kind (lib/api-map.mjs createWithholder). The API map shares the withholder,
  // so one element shown in two sections is counted once.
  const state = readCodeContext(root, activeStackScopeFor(root)?.stack, () => readContextState(root));
  if (!["missing", "healthy"].includes(state.state)) throw viewError("VIEW_CONTEXT_INVALID", "The knowledge store is unreadable or unusable.");
  const ctx = state.snapshot?.ctx ?? null;
  const withhold = createWithholder();
  const digest = ctx ? liveContractDigest(root, ctx) : null;
  const apiMap = buildApiMapModel(root, { now: Date.parse(generatedAt), env, snapshot: state.snapshot, withhold });
  const stackBinding = activeStackScopeFor(root);
  const selectedContract = stackBinding ? stackBinding.config.contract : ctx?.api?.contract;
  // The page never refuses because of the contract: a missing, unreadable or
  // empty contract leaves the declared sections empty, and the API map names
  // which of those applies.
  let contract = null;
  if (selectedContract) {
    try {
      const doc = readContract(resolve(root, selectedContract)).doc;
      contract = doc && typeof doc === "object" && !Array.isArray(doc) ? doc : null;
    } catch { contract = null; }
  }
  const mapRows = new Map((apiMap.operations ?? []).map(row => [row.op, row]));
  const operationEntries = { ...ctx?.operations };
  // Contract-only and captured operations have context too, even before a
  // legacy learned entry exists. Do not manufacture a verification for them.
  for (const row of apiMap.operations ?? []) if (row.op && !Object.hasOwn(operationEntries, row.op)) operationEntries[row.op] = {};
  const operations = sorted(operationEntries).map(([op, entry]) => {
    // The map grades each stored operation once; its learned grade is the
    // same freshnessFor answer, so the details and the map cannot disagree.
    const row = mapRows.get(op);
    const fresh = row?.learned?.freshness ?? freshnessFor(entry, root, digest, Date.parse(generatedAt));
    const noteHistory = inspectNoteHistory(entry, op);
    const split = op.indexOf(" ");
    const schema = contract && split > 0 ? responseSchema(contract, op.slice(0, split), op.slice(split + 1)) : null;
    const element = operationElement(op);
    const detail = (field, value) => typeof value === "string" ? withhold.text("operation-detail", value, `${element}\u0000${field}`) : value;
    const measured = Boolean(entry.verified_at);
    return {
      op: withhold.text("operation-key", op, element),
      operation_anchor: operationAnchor({ stack: stackBinding?.stack ?? null, operation: op }),
      freshness: Array.isArray(fresh.reasons) ? { ...fresh, reasons: fresh.reasons.map((reason, index) =>
        withhold.text("freshness-reason", reason, `${element}\u0000reason\u0000${index}`)) } : fresh,
      standing: row?.standing ?? null, responses: row?.responses ?? 0,
      evidence_class: row?.evidence_class ?? null, code: row?.code,
      latest_status_codes: row?.latest_status_codes ?? [], latest_observed_at: row?.latest_observed_at ?? null,
      // The operation's own key-source records (path and query), as the API
      // map read them from the store's own query; a damaged list (the query's
      // record_issues) is named, never shown.
      key_sources: (apiMap.key_sources ?? []).filter(key => key.op === op),
      key_sources_damaged: (apiMap.issues ?? []).some(issue => issue.code === "KEY_SOURCES_INVALID" && issue.operation === op),
      // A list the store's query left out to keep the record within its read
      // bound is named, never shown as absent.
      key_sources_omitted: row?.key_sources_omitted === true,
      declared: schemaFields(schema).map(field => ({
        name: withhold.text("declared-field", field.name, `${element}\u0000declared\u0000${field.name}`),
        type: withhold.text("declared-field", field.type, `${element}\u0000declared-type\u0000${field.name}`),
        ...(field.enum ? { enum: field.enum.map((value, index) => typeof value === "string"
          ? withhold.text("declared-enum", value, `${element}\u0000enum\u0000${field.name}\u0000${index}`) : value) } : {}),
      })),
      // Measured names, the verifier and the environment are shown only for
      // a measured operation, so only then are they scanned and counted.
      fields: sorted(entry.fields).map(([name, field]) => ({
        name: measured ? withhold.text("measured-field", name, `${element}\u0000field\u0000${name}`) : name,
        type: measured ? withhold.text("measured-field", field?.type ?? "not retained", `${element}\u0000field-type\u0000${name}`) : field?.type ?? "not retained",
        distinct: field?.distinct })),
      verified_at: detail("verified_at", entry.verified_at ?? null),
      verified_by: measured ? detail("verified_by", entry.verified_by ?? null) : entry.verified_by ?? null,
      environment: (measured ? detail : (field, value) => value)("environment", entry.environment?.name ?? (typeof entry.environment === "string" ? entry.environment : null)),
      effect: detail("effect", entry.effect ?? "not recorded"), source_file: detail("source_file", entry.source_file ?? null),
      notes: [...noteHistory.active, ...noteHistory.history].map(note => {
        const projection = apiMap.notes?.find(item => item.op === op && item.note_id === note.id);
        return { ...withheldNote(withhold, op, note), ...(projection ? { evidence_class: projection.evidence_class,
          contradictions: projection.contradictions } : {}) };
      }),
      note_integrity: { state: noteHistory.state, digest: noteHistory.digest, issues: noteHistory.issues },
    };
  });
  const registry = loadRegistry(env);
  const self = resolveRef(registry.registry, root, root)?.id;
  const grants = registry.registry.grants.filter(g => g.consumer === self || g.provider === self).map(g => ({
    consumer: registry.registry.repos[g.consumer].name, provider: registry.registry.repos[g.provider].name, at: g.granted_at,
  })).sort((a, b) => a.consumer.localeCompare(b.consumer) || a.provider.localeCompare(b.provider));
  // Fields this page prints directly pass the scan here. Verdict lines and
  // saved reports are composed by their own renderers; each of their lines
  // passes the scan where it is rendered (renderViewHtml), so only what is
  // shown is counted.
  const text = (kind, value, id) => typeof value === "string" ? withhold.text(kind, value, id) : value;
  const baseline = readBaselineFile(root);
  const usage = readUsageSources(undefined, { env });
  const receipt = buildReceipt(scopeToProject(usage.rows, root), ctx);
  receipt.log_sources = usage.logs.map(({ source, rows }) => ({ source, rows }));
  const model = {
    stack: stackBinding?.stack ?? null,
    project: text("store-text", ctx?.api?.name ?? basename(root), "store\u0000name"),
    generated_at: generatedAt, head: viewHead(root),
    store_at: text("store-text", ctx?.generated_at ?? null, "store\u0000generated_at"),
    store_path: activeStackScopeFor(root)?.contextFile ?? LAYOUT.context,
    contract: activeStackScopeFor(root) ? apiMap.contract?.path ?? null
      : text("contract-file", ctx?.api?.contract ?? null, `contract-file\u0000${ctx?.api?.contract}`),
    contract_state: selectedContract ? apiMap.contract?.state ?? null : null,
    api_map: apiMap,
    operations, verdicts: sorted(ctx?.verdicts).map(([name, value]) => ({ name, ...value })),
    baseline: baseline && typeof baseline === "object" ? { ...baseline,
      generated_at: text("report-text", baseline.generated_at, "baseline\u0000generated_at"),
      findings: Array.isArray(baseline.findings) ? baseline.findings.map((finding, index) => finding && typeof finding === "object"
        ? Object.fromEntries(Object.entries(finding).map(([key, value]) => [key, ["service", "op", "where", "kind", "severity"].includes(key)
          ? text("report-text", value, `baseline\u0000${index}\u0000${key}`) : value])) : finding) : baseline.findings } : baseline,
    records: readViewRecords(root),
    import_sources: storedImportSources(root).map((source, index) => ({ name: text("report-text", source.name, `import-source\u0000${index}\u0000name`),
      kind: text("report-text", source.kind, `import-source\u0000${index}\u0000kind`), at: text("report-text", source.at, `import-source\u0000${index}\u0000at`),
      file_name: source.name })),
    mcp: ctx?.mcp_inspections ?? [],
    receipt: { ...receipt, window: { ...receipt.window, from: text("receipt-text", receipt.window?.from, "receipt\u0000from"),
      to: text("receipt-text", receipt.window?.to, "receipt\u0000to") },
      gotchas: { ...receipt.gotchas, operations: (receipt.gotchas?.operations ?? []).map(entry => ({ ...entry,
        op: text("receipt-text", entry.op, `receipt\u0000${entry.op}`) })) } },
    grants: grants.map((grant, index) => ({ consumer: text("grant-text", grant.consumer, `grant\u0000${index}\u0000consumer`),
      provider: text("grant-text", grant.provider, `grant\u0000${index}\u0000provider`), at: text("grant-text", grant.at, `grant\u0000${index}\u0000at`) })),
    registry_problem: registry.problem?.code ?? null,
  };
  // The single-store page's ledger shares this withholder, so an operation key
  // shown in the map and in a ledger row is counted once.
  if (ledger) model.sessions = buildSessionLedger(root, { env, now: Date.parse(generatedAt), withhold, contexts: [{ stack: null, ctx }] });
  // The parsed store travels to the stacked page's ledger, never into the page.
  Object.defineProperty(model, STORE_CONTEXT, { value: ctx, enumerable: false });
  // Names-free: the count by kind of everything withheld above, the API map's included.
  model.withheld = withhold.counts();
  return model;
}

// The operation detail retains the same bounded receipts as the ledger. It
// names that limit and includes attention basis even when a failed call fell
// outside the ledger row bound. No response content is copied into this view.
function attachOperationEvidence(model) {
  const ledger = model.sessions;
  if (!ledger) return model;
  const views = model.stack_views ? model.stack_views.map(row => row.model) : [model];
  const entries = new Map(views.flatMap(view => view.operations.filter(entry => entry.operation_anchor).map(entry => [entry.operation_anchor, { entry, view }])));
  const ensure = row => {
    if (!row.operation_anchor) return null;
    if (entries.has(row.operation_anchor)) return entries.get(row.operation_anchor).entry;
    const view = views.find(view => view.stack === row.stack);
    if (!view) return null;
    const entry = { op: row.operation, operation_anchor: row.operation_anchor,
      context_state: 'Only a recorded call identifies this operation; no stored operation context or contract detail is available.',
      freshness: { confidence: 'unverified', reasons: [] }, standing: null, responses: 0, latest_status_codes: [], latest_observed_at: null,
      declared: [], fields: [], notes: [], verified_at: null, effect: 'not recorded', source_file: null };
    view.operations.push(entry); entries.set(row.operation_anchor, { entry, view }); return entry;
  };
  for (const session of ledger.sessions) for (const block of session.rows) for (const row of block.kind === 'batch' ? block.rows : [block]) {
    const entry = ensure(row);
    if (!entry) continue;
    (entry.session_evidence ??= []).push({ session_id: session.id, at: row.at, status: row.status,
      assertions: row.assertions, assertions_basis: row.assertions_basis, attribution: row.attribution,
      basis: row.basis, produced: row.produced, left: row.left });
  }
  for (const group of ledger.needs_attention.groups) for (const item of group.items) {
    const entry = ensure(item);
    if (entry) (entry.attention_evidence ??= []).push(item);
  }
  for (const { entry } of entries.values()) {
    const rows = entry.session_evidence ?? [];
    rows.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
    entry.session_evidence_omitted = Math.max(0, rows.length - 20);
    entry.session_evidence = rows.slice(0, 20);
    entry.evidence_basis = `At most 20 receipts from the shown session rows, plus shown attention items. ${ledger.sessions.reduce((n, session) => n + session.rows_omitted, 0)} ledger rows and ${ledger.needs_attention.omitted} attention items were omitted by their display bounds; their operation split is unavailable here.`;
  }
  return model;
}

// A note as the page shows it: its text, author, date and supersession
// marker each pass the scan; the id is the one the API map's notes table uses.
const NOTE_SHOWN = Object.freeze({ provenance: ["by", "at", "kind", "pass_id"], superseded: ["at", "reason", "replacement", "by", "pass_id"] });
function withheldNote(withhold, op, note) {
  const id = noteElement(op, note.index);
  const fields = (value, part) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === "string" && NOTE_SHOWN[part].includes(key)
      ? withhold.text("note-detail", item, `${id}\u0000${part}\u0000${key}`) : item]))
    : value;
  return { ...note, text: typeof note.text === "string" ? withhold.text("note", note.text, id) : note.text,
    provenance: fields(note.provenance, "provenance"), superseded: fields(note.superseded, "superseded") };
}

function operationHtml(entry, model) {
  const f = entry.freshness, s = entry.standing;
  const why = [...f.reasons, ...(f.age ? [ageReason(f.age)] : [])].filter(Boolean).join("; ");
  // The shared standing decides whether a response is recorded in scope; the
  // learned (legacy) measurement keeps its own sentence beside it.
  const noResponse = !s || ["no-response", "write-no-response"].includes(s.key);
  const scoped = !s || noResponse ? null
    : ["observed", "observed-after-failure", "latest-response"].includes(s.key)
      ? `Responses in scope: ${entry.responses} counted; newest recorded ${entry.latest_observed_at ?? "date not recorded"}; latest status ${entry.latest_status_codes.join(", ") || "not recorded"}. Standing: ${s.label}${s.qualifiers.length ? ` (${s.qualifiers.join("; ")})` : ""}.`
      : `Standing: ${s.label}${s.qualifiers.length ? ` (${s.qualifiers.join("; ")})` : ""}; no response can be counted in scope.`;
  const measured = entry.verified_at
    ? `Measured ${entry.verified_at}; environment ${entry.environment ?? "not retained"}; verified by ${entry.verified_by ?? "not recorded"}.` : null;
  const recorded = Boolean(entry.session_evidence?.length || entry.attention_evidence?.length);
  const basis = [measured, scoped].filter(Boolean).join(" ") || (recorded
    ? 'No learned verification recorded. Local session or attention evidence is listed below.' : "Not measured: no executions recorded yet.");
  const emptyFields = entry.verified_at ? "No measured field structure retained." : noResponse && !recorded ? "No executions recorded yet." : "No learned field structure retained.";
  const declared = entry.declared.map(field => `<code>${esc(field.name)}</code>: <code>${esc(field.type)}</code>${field.enum ? `; declared enum ${esc(JSON.stringify(field.enum))}` : ""}`);
  const fields = entry.fields.map(field => `<code>${esc(field.name)}</code>: <code>${esc(field.type)}</code>${field.distinct !== undefined ? `; ${esc(field.distinct)} distinct` : ""}`);
  const notes = entry.notes.map(note => {
    const origin = note.provenance;
    const marker = note.superseded;
    const text = `${p(note.text)}${note.contradictions?.length ? p(`Contradicted by the latest response: ${note.contradictions.join(', ')}. The authored claim is retained.`) : ''}<p class="basis">${esc(origin ? `Recorded by ${origin.by ?? "not recorded"} on ${origin.at ?? "date not recorded"}${origin.kind ? `; ${origin.kind}` : ""}${origin.pass_id ? `; pass ${origin.pass_id}` : ""}.` : "Provenance and date not recorded.")}${marker ? ` ${esc(`Superseded ${marker.at}: ${marker.reason ?? `replaced by ${marker.replacement}`}; by ${marker.by ?? "not recorded"}${marker.pass_id ? `; pass ${marker.pass_id}` : ""}.`)}` : " Active note."}</p>`;
    return marker ? `<details><summary>Superseded claim — retained history</summary>${text}</details>` : text;
  });
  const state = `${entry.evidence_class ? `${entry.evidence_class.class} · ` : ''}${s ? `${s.label} · learned ${f.confidence}` : f.confidence}${f.age?.stale ? " · age-stale" : ""}`;
  const keys = (entry.key_sources ?? []).map(key => `<code>${esc(key.param)}</code> (${esc(key.location)}) from <code>${esc(key.source_operation)}</code> → <code>${esc(key.source_field)}</code>; first seen ${esc(key.first_observed_at.slice(0, 10))}, last seen ${esc(key.last_observed_at.slice(0, 10))}; also in ${esc(key.also_seen)} other response field${key.also_seen === 1 ? "" : "s"}; evidence <code>${esc(key.run_id)}</code>`);
  const keyHtml = keys.length || entry.key_sources_damaged || entry.key_sources_omitted
    ? `<h3>Key sources</h3>${p(`Basis: key-source records on this operation in the API map's scope.${entry.key_sources_damaged ? " The stored key-source list is damaged (KEY_SOURCES_INVALID); its links are treated as absent." : ""}${entry.key_sources_omitted ? " The stored key-source list is beyond the read bound; its links are not shown." : ""}`)}${keys.length ? list(keys, "") : ""}` : "";
  const evidence = (entry.session_evidence ?? []).map(row => `<code>${esc(row.basis.run_id ?? row.basis.expected_run_id ?? row.basis.envelope_id ?? 'receipt not recorded')}</code> · ${esc(row.at ?? 'date not recorded')} · session <code>${esc(row.session_id)}</code> · ${esc(row.status === null ? 'response not recorded' : `HTTP ${row.status}`)} · ${esc(row.assertions ? `assertions ${row.assertions.passed} passed, ${row.assertions.failed} failed (${row.assertions_basis})` : 'assertions not recorded')} · ${esc(`host ${row.attribution.initiator}; receipt ${row.basis.receipt_state}`)}`);
  const attention = (entry.attention_evidence ?? []).map(item => `${esc(item.summary)} Basis: <code>${esc(item.basis.run_id ?? item.basis.expected_run_id ?? item.basis.envelope_id ?? 'receipt not recorded')}</code>; session ${esc(item.session_id ?? 'unknown')}.`);
  const anchor = /^operation-[a-f0-9]{64}$/.test(entry.operation_anchor ?? '') ? entry.operation_anchor : null;
  return `<details${anchor ? ` id="${anchor}"` : ''} open><summary><code>${esc(entry.op)}</code> <span class="state">${esc(state)}</span></summary>` +
    (entry.context_state ? p(entry.context_state) : '') + p(basis) + (entry.evidence_class ? p(`Evidence class: ${entry.evidence_class.class}; ${entry.evidence_class.reason}.`) : '') + p(why) + p(`Effect: ${entry.effect}. Source: ${entry.source_file ?? "not mapped"}.`) +
    `<h3>In the code</h3>${renderOperationCodeHtml(entry.code)}<h3>Declared response</h3>${p(`Basis: ${model.contract ? (CONTRACT_STATES[model.contract_state]
      ? `contract ${model.contract} ${CONTRACT_STATES[model.contract_state]}; no declared fields can be read`
      : `declared by ${model.contract}; read ${model.generated_at.slice(0, 10)}`) : "no contract recorded; date unavailable"}.`)}` +
    list(declared, "No declared response fields recorded.") +
    `<h3>Measured field names</h3>${p(basis)}${list(entry.verified_at ? fields : [], emptyFields)}` + keyHtml +
    `<h3>Notes</h3>${entry.note_integrity?.issues?.length ? p(`History ${entry.note_integrity.state}: ${entry.note_integrity.issues.map(issue => issue.message).join(" ")}`) : ""}${list(notes, "No notes recorded; provenance and date unavailable.")}` +
    `<h3>Session evidence</h3>${p(entry.evidence_basis ?? 'No session evidence projection is available.')}${list(evidence, 'No receipt in the shown session rows; this does not establish that no call occurred.')}${entry.session_evidence_omitted ? p(`${entry.session_evidence_omitted} additional shown receipts omitted from this operation detail.`) : ''}${list(attention, 'No attention item in the shown attention projection.')}</details>`;
}

// A ledger row links to the operation detail this page renders: the stack's
// viewport on a stacked page, the Operations section on a single store.
function sessionLink(model, row) {
  const view = model.stack_views ? model.stack_views.find(stack => stack.name === row.stack)?.model : model;
  return view?.operations.some(entry => entry.operation_anchor && entry.operation_anchor === row.operation_anchor) ? row.operation_anchor : null;
}

// The page's own layout rules, shared by the view and the standalone ledger page.
const VIEW_PAGE_CSS = `*{box-sizing:border-box}body{background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,sans-serif;max-width:1100px;margin:auto;padding:24px;overflow-wrap:anywhere}
h1{font-size:1.5rem}h2{font-size:1.15rem}h3{font-size:1rem}h1,h2,h3,p{margin:0 0 10px}section{margin:28px 0}header,section{scroll-margin-top:16px}
.basis,.state{color:var(--muted);font-size:.875rem}a{color:inherit}nav{display:flex;flex-wrap:wrap;gap:8px 18px;margin:20px 0}
details,pre{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:12px 0}summary{cursor:pointer;font-weight:600}details[open]>summary{margin-bottom:12px}
code,pre{font: .875rem/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere}ul{padding-left:22px}li{margin:6px 0}.state{font-weight:400}footer{border-top:1px solid var(--line);padding-top:14px}
@media(max-width:600px){body{padding:16px}details,pre{padding:10px}}`;
const ACTIVE_CONTENT = /<script|<link|<iframe|\bsrc\s*=|@import|url\s*\(/i;

// The last guard, per section: the rendered HTML, read as written and with
// the escaper's entities decoded, must not hold anything the secret scan
// flags. Every value was withheld before this point, so a hit is a
// withholding bug: the page is refused, the section is named, nothing is written.
function guarded(id, html) {
  if (secretOnPage(html))
    throw Object.assign(viewError("VIEW_WITHHOLDING_MISSED",
      `A secret-shaped value reached the ${id} section of the page after withholding; this is a withholding bug. Nothing was written.`), { section: id });
  return html;
}

export function renderViewHtml(model) {
  // Leaves were withheld when the model was built (projectView). A verdict line
  // or a saved report composes them with other text, so each composed line
  // passes the same scan here, is withheld when flagged and joins the count.
  const withhold = createWithholder();
  const report = (kind, value, id) => `<pre>${esc(withhold.lines(kind, value, id))}</pre>`;
  // A saved record's basis sentence (its own basis text, date and commit).
  const basisOf = (record, id) => withhold.text("report-text", recordBasis(record), `${id}\u0000basis`);
  const date = model.generated_at.slice(0, 10);
  const storeBasis = model.stack_views ? `Per-stack stores and contracts; read ${date}.`
    : `${model.store_path ?? LAYOUT.context}, generated ${model.store_at ?? "date not recorded"}; read ${date}.`;
  const audit = model.records.find(r => r.kind === "audit"), map = model.records.find(r => r.kind === "map");
  const imports = model.records.filter(r => r.kind === "import");
  const baseline = model.baseline;
  const auditHtml = baseline ? p(`Accepted baseline: ${baseline.generated_at ?? "date not recorded"}.`) +
    list((baseline.findings ?? []).map(f => `${esc(f.service ?? "repository")} · ${esc(f.op ?? f.where ?? "")} · ${esc(f.kind)} · ${esc(f.severity)}`), "No findings accepted in the baseline.") +
    (audit ? p(basisOf(audit, "audit")) + report("report-text", renderCiSummary({ ...viewAuditModel(audit.model), cli: PRODUCT }), "audit") : p("No last audit summary retained; new and resolved findings are unknown. Run audit to retain its next result."))
    : p("No audit baseline recorded; new, resolved, and accepted drift are unknown.");
  const mcp = model.mcp.map((record, index) => {
    const at = withhold.text("mcp-text", record.at ?? "date not recorded", `mcp\u0000${index}\u0000at`);
    return `<details><summary>${esc(withhold.text("mcp-text", record.server?.label ?? record.server?.name ?? "Unnamed server", `mcp\u0000${index}\u0000label`))} · ${esc(at)}</summary>` +
      p(`Basis: stored MCP inspection ${at}; declarations are server claims. ${record.measured?.length ?? 0} tool calls recorded.`) +
      report("mcp-text", renderMcpReport(mcpForView(record)), `mcp\u0000${index}`) + `</details>`;
  });
  const r = model.receipt;
  const importHtml = imports.map((record, index) => `<details open><summary>${esc(withhold.text("report-text", record.source, `import\u0000${index}\u0000source`))}</summary>${p(basisOf(record, `import\u0000${index}`))}${p("Import classifications are declared or inferred, not executions.")}${report("report-text", renderImportReport(viewImportModel(record.model), { cli: PRODUCT, valuesWithheld: true }), `import\u0000${index}`)}</details>`);
  const missingImports = model.import_sources.filter(source => !imports.some(r => r.model.suite === (source.file_name ?? source.name)))
    .map(source => p(`${source.name}: ${source.kind ?? "format not recorded"}, imported ${source.at ?? "date not recorded"}. No loss report retained; translated, inferred and quarantined counts are unknown.`));
  const verdictLine = (v, index) => withhold.text("verdict-text", renderVerdict(v.name, v, date), `verdict-line\u0000${index}`);
  const confirmed = (v, index) => withhold.text("verdict-text", v.last_confirmed ?? "date not recorded", `verdict-confirmed\u0000${index}`);
  const body = [
    ...(model.sessions ? [["needs-attention", renderSessionAttentionHtml(model.sessions.needs_attention, { links: row => sessionLink(model, row) })]] : []),
    ["api-map", renderApiMapHtml(model.api_map, { withheldLine: false })],
    ["operations", section("operations", "Operations", storeBasis, model.stack_views
      ? model.stack_views.map(row => `<h3>Stack ${esc(row.name)}</h3>` + (row.model.operations.length ? row.model.operations.map(e => operationHtml(e, row.model)).join("\n") : p("No operations recorded. No executions recorded yet."))).join('\n')
      : model.operations.length ? model.operations.map(e => operationHtml(e, model)).join("\n") : p("No operations recorded. No executions recorded yet."))],
    ["verdicts", section("verdicts", "Verdicts", storeBasis + " Decisions are recorded opinions; a verdict is not proof of execution.", model.stack_views
      ? model.stack_views.map((row, stackIndex) => `<h3>Stack ${esc(row.name)}</h3>` + list(row.model.verdicts.map((v, index) => p(verdictLine(v, `${stackIndex}-${index}`)) + p(`Last confirmed: ${confirmed(v, `${stackIndex}-${index}`)}.`)), "No verdicts recorded.")).join('\n')
      : list(model.verdicts.map((v, index) => p(verdictLine(v, index)) + p(`Last confirmed: ${confirmed(v, index)}.`)), "No verdicts recorded."))],
    ["audit", section("audit", "Last audit &amp; accepted baseline", `Basis: accepted audit baseline dated ${baseline?.generated_at ?? "not recorded"}; saved summary ${audit ? withhold.text("report-text", audit.at, "audit\u0000at") : "not recorded"}.`, auditHtml)],
    ["map", section("map", "Estate map", map ? basisOf(map, "map") + " Same map text renderer, complete detail; finding values withheld." : `Basis: no saved map model; read ${date}.`, map ? report("report-text", renderMapText(viewMapModel(map.model), { complete: true }), "map") : p("No estate map recorded. Run map to retain its next model; this view does not derive a new map."))],
    ["imports", section("imports", "Import loss reports", `Basis: saved import reports and source provenance; read ${date}.`, [...importHtml, ...missingImports].join("\n") || p("No import sources or loss reports recorded."))],
    ["mcp", section("mcp", "MCP servers", storeBasis + " Each retained inspection carries its own date and declaration diff.", mcp.join("\n") || p("No MCP inspections recorded. No tool executions recorded yet."))],
    ...(model.sessions ? [["sessions", renderSessionLedgerHtml(model.sessions, { links: row => sessionLink(model, row) })]] : []),
    ["receipts", section("receipts", "Repository receipts", `Basis: usage logs scoped by project name, as receipt does; ${r.log_sources?.length ? `read sources: ${r.log_sources.map(log => `${log.source} (${log.rows} machine-wide rows)`).join(', ')}; ` : ''}${r.window.from ?? "no start date"} to ${r.window.to ?? "no end date"}. Equal repository basenames share this legacy scope.`,
      r.calls ? p(`${r.calls} calls recorded; ${r.gotchas.notes_delivered} gotchas delivered in ${r.gotchas.requests_served} calls.`) + list(r.gotchas.operations.map(o => `${esc(o.op)}: ${esc(o.notes_delivered)} notes delivered in ${esc(o.requests)} calls.`), "No gotchas delivered in these calls.") : p("No API calls recorded for this repository. No gotchas delivered."))],
    ["grants", section("grants", "Registry grants by name", `Basis: registry read ${date}; grant dates below. Names only; provider stores are not read.`, model.registry_problem ? p(`Registry unavailable: ${model.registry_problem}. No grants can be asserted.`) : list(model.grants.map(g => `${esc(g.consumer)} may read ${esc(g.provider)}; granted ${esc(g.at ?? "date not recorded")}.`), "No registry grants recorded for this repository."))],
  ];
  // One line counts everything withheld on the page, by kind.
  const withheld = withheldSentence(mergeWithheld(model.withheld, withhold.counts()));
  const title = guarded("title", `<title>${esc(PRODUCT)} view — ${esc(model.project)}</title>`);
  const header = guarded("header", `<header><h1>${esc(model.project)} — ${esc(PRODUCT)} view</h1>
<p id="generated-at">Generated at: ${esc(model.generated_at)}</p>
${p(`Snapshot of the working tree at commit ${model.head ?? "unavailable (not in git)"}. Local edits may be included. Regenerate to reflect later changes; this page executes nothing.`)}
<p class="basis">${esc(storeBasis)} Standings use the same scoped-observation rules as show; learned verification uses the same store, contract, git and age grading as show and the audit summary.</p>${withheld ? `
<p class="basis" id="withheld">${esc(withheld)}</p>` : ""}</header>`);
  const footer = guarded("footer", `<footer>${p(`Snapshot only. Run ${PRODUCT} view again to regenerate. Field names, types, declared enums, notes and verdicts appear; request and response values do not.`)}</footer>`);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
${title}
<style>
${reportThemeCss("system")}
${VIEW_PAGE_CSS}
${API_MAP_CSS}
</style>
</head>
<body>
${renderReportTheme("system")}
${header}
<nav aria-label="Sections">${model.sessions ? '<a href="#needs-attention">Needs attention</a>' : ''}<a href="#api-map">API map</a><a href="#operations">Operations</a><a href="#verdicts">Verdicts</a><a href="#audit">Audit</a><a href="#map">Map</a><a href="#imports">Imports</a><a href="#mcp">MCP</a>${model.sessions ? '<a href="#sessions">Sessions</a>' : ''}<a href="#receipts">Receipts</a><a href="#grants">Grants</a></nav>
${body.map(([id, html]) => guarded(id, html)).join("\n")}
${footer}
</body>
</html>
`;
  if (ACTIVE_CONTENT.test(html))
    throw viewError("VIEW_ACTIVE_CONTENT_REFUSED", "The page contains forbidden active content; nothing was written.");
  return html;
}

/**
 * `sessions --out`: the same ledger section the view renders, as its own
 * offline page with the view's theme controls, CSP and last guards. Operation
 * names link relatively when the caller supplies an available view and its
 * anchors; otherwise the row's inline outcome and receipt basis remain.
 */
export function renderSessionsPageHtml(ledger, { project: name, viewHref = null, viewAnchors = null }) {
  const withhold = createWithholder();
  const project = withhold.text("store-text", name, "store\u0000name");
  const report = relativeViewHref(viewHref);
  const available = Array.isArray(viewAnchors) ? new Set(viewAnchors.filter(value => /^operation-[a-f0-9]{64}$/.test(value))) : null;
  const links = row => report && row.operation_anchor && (!available || available.has(row.operation_anchor)) ? `${report}#${row.operation_anchor}` : null;
  const withheld = withheldSentence(mergeWithheld(ledger.withheld, withhold.counts()));
  const title = guarded("title", `<title>${esc(PRODUCT)} sessions — ${esc(project)}</title>`);
  const header = guarded("header", `<header><h1>${esc(project)} — ${esc(PRODUCT)} sessions</h1>
<p id="generated-at">Generated at: ${esc(ledger.generated_at)}</p>
${p(`Snapshot of local evidence. Regenerate to reflect later calls; this page executes nothing. ${report && (!available || available.size) ? 'Operation links open available anchors in the relative view snapshot; it may have been generated at a different time. Rows without a matching anchor retain inline basis.' : 'No linked operation view is available. Inline basis retains status, assertion outcome, drift, draft/note identities and receipt references; operation context and note text are unavailable here.'}`)}${withheld ? `
<p class="basis" id="withheld">${esc(withheld)}</p>` : ""}</header>`);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
${title}
<style>
${reportThemeCss("system")}
${VIEW_PAGE_CSS}
${API_MAP_CSS}
</style>
</head>
<body>
${renderReportTheme("system")}
${header}
${guarded("needs-attention", renderSessionAttentionHtml(ledger.needs_attention, { links }))}
${guarded("sessions", renderSessionLedgerHtml(ledger, { links }))}
<footer>${p(`Snapshot only. Run ${PRODUCT} sessions --out again to regenerate. Names, counts, statuses, codes and ids appear; request and response values do not.`)}</footer>
</body>
</html>
`;
  if (ACTIVE_CONTENT.test(html))
    throw viewError("VIEW_ACTIVE_CONTENT_REFUSED", "The page contains forbidden active content; nothing was written.");
  return html;
}
