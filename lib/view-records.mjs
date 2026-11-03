import { evidenceDirectoryFor } from './stack-scope.mjs';
import { LAYOUT, ensureLayout } from './layout.mjs';
// Retain presentations at their owning CLI boundary. The view reads these
// dated models; it cannot probe, recompute drift, or silently replace a last
// measurement with a fresh static audit. No raw request/response data enters.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { readConfigDefaults } from "./config.mjs";
import { resolveOutputPath } from "./output-path.mjs";
import { secretIn } from "./verdicts.mjs";

export const viewError = (code, message) => Object.assign(new Error(message), { code });
export const evidenceDirectory = root => resolve(root, evidenceDirectoryFor(root, readConfigDefaults(root).evidenceDir));
export function viewHead(root) {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}

// Scan strings independently too: HTML escaping must not hide a credential
// from the committed-surface scanner. Diagnostics never repeat the value.
// Saved records use this before they are written; a page withholds instead
// (lib/api-map.mjs createWithholder) and keeps secretOnPage as its last guard.
export function scanViewSurface(value) {
  if (typeof value === "string") {
    if (secretIn(value, { allowAuthReferences: true })) throw viewError("VIEW_SECRET_REFUSED", "A secret-shaped value was found; nothing was written.");
  } else if (Array.isArray(value)) value.forEach(scanViewSurface);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) { scanViewSurface(key); scanViewSurface(item); }
}

// The entities the page escaper writes (lib/api-map.mjs escapeText). The last
// guard reads rendered HTML both as written and with these decoded, so that
// escaping ("@" as "&#64;", "=" as "&#61;") never hides a value from the scan.
const PAGE_ENTITIES = Object.freeze({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#61;": "=", "&#64;": "@", "&#40;": "(" });
export const decodePageEntities = html => String(html).replace(/&(?:amp|lt|gt|quot|#39|#61|#64|#40);/g, entity => PAGE_ENTITIES[entity]);
export const secretOnPage = html => Boolean(secretIn(String(html), { allowAuthReferences: true })
  || secretIn(decodePageEntities(html), { allowAuthReferences: true }));

export function writeViewFile(root, path, text, { allowOutside = false } = {}) {
  scanViewSurface(text);
  const options = { allowOutside, fileOnly: true };
  resolveOutputPath(root, path, options);
  const defaultEvidence = resolve(root, LAYOUT.evidence);
  if (resolve(path).startsWith(defaultEvidence + sep)) ensureLayout(root);
  mkdirSync(dirname(path), { recursive: true });
  resolveOutputPath(root, path, options);
  const temp = join(dirname(path), `.view-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
    resolveOutputPath(root, path, options);
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

const pick = (value, keys) => Object.fromEntries(keys.filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
const finding = value => pick(value, ["key", "service", "op", "kind", "severity", "where"]);

// These are projections, not detectors. Finding prose and endpoint URLs can
// contain observed values; the map keeps identities and graded severities.
export function viewMapModel(model) {
  return {
    version: model.version, root: model.root, generated_at: model.generated_at,
    summary: pick(model.summary, ["services", "operations", "undocumented_routes", "edges", "external", "shadow", "findings", "platform", "high", "operations_probed"]),
    // Whether probes ran at all, and how many operations answered, are counts
    // about the run. Dropping them here would make every retained map read as
    // "probe coverage not recorded" even when it was measured.
    ...(model.probe_execution ? { probe_execution: model.probe_execution } : {}),
    // Declared client reads are a separate measurement from source probes.
    // Keep their structural report so reopening a map does not erase it; target
    // URLs, evidence paths and response/assertion payloads stay private.
    ...(model.map_execution ? { map_execution: {
      ...pick(model.map_execution, ["planned", "attempted", "responses"]),
      requests: (model.map_execution.requests ?? []).map(row => pick(row,
        ["stack", "service", "environment", "method", "path", "attempts", "status", "refusal"])),
      omitted: (model.map_execution.omitted ?? []).map(row => pick(row, ["stack", "service", "reason", "count"])),
    } } : {}),
    services: (model.services ?? []).map(s => ({
      // `probe` and `knowledge` are integer counts, never operation names or
      // field values, so they cross the promotion boundary as freely as `ops`.
      // They travel because a snapshot whose estate line states coverage while
      // its services cannot is one document disagreeing with itself.
      ...pick(s, ["id", "name", "kind", "ops", "framework", "repo", "repos", "checkouts", "owner", "ownerSource", "reachable", "infraShadow", "probe", "knowledge"]),
      findings: (s.findings ?? []).map(f => ({ ...finding(f), detail: f.kind })),
      shadow: (s.shadow ?? []).map(r => pick(r, ["method", "path", "file", "severity"])),
      uncontracted: (s.uncontracted ?? []).map(r => pick(r, ["method", "path", "file"])),
    })),
    edges: (model.edges ?? []).map(e => pick(e, ["from", "to", "via", "operations", "unmatchedCalls"])),
    external: (model.external ?? []).map(e => pick(e, ["host", "callers"])),
    platform: (model.platform ?? []).map(p => ({ dimension: p.dimension, detail: "Recorded convention disagreement; value detail withheld." })),
  };
}

export function viewAuditModel(model) {
  return { ...pick(model, ["unchanged", "baselineGeneratedAt", "noExecute", "reportOnly"]),
    added: (model.added ?? []).map(finding), resolved: (model.resolved ?? []).map(finding),
    freshness: (model.freshness ?? []).map(f => pick(f, ["op", "state", "why", "where"])),
    ...(model.mcp ? { mcp: { ...pick(model.mcp, ["baseline", "checked", "registered"]),
      drift: (model.mcp.drift ?? []).map(f => pick(f, ["server", "op", "kind", "detail", "file"])),
      coverage_gaps: (model.mcp.coverage_gaps ?? []).map(f => pick(f, ["server", "code", "reason", "file"])),
    } } : {}),
  };
}

export function viewImportModel(report) {
  return { ...pick(report, ["suite", "source_kind"]),
    counts: pick(report.counts, ["items", "imported", "todo", "assertions_translated", "assertions_derived_from_examples", "assertions_inferred", "scripts_needing_manual_conversion", "secrets_omitted_by_design", "dialects", "translated_quarantined_coverage", "declared", "skipped"]),
    items: (report.items ?? []).map(i => pick(i, ["id", "status", "notes"])),
    loss: (report.loss ?? []).map(i => pick(i, ["path", "reason"])),
    environmentFacts: (report.environmentFacts ?? []).map(i => pick(i, ["name", "vars"])),
    ...(report.counts?.scripts_quarantined ? { counts: {
      ...pick(report.counts, ["items", "imported", "todo", "assertions_translated", "assertions_derived_from_examples", "assertions_inferred", "scripts_needing_manual_conversion", "secrets_omitted_by_design", "dialects", "translated_quarantined_coverage"]),
      scripts_quarantined: report.counts.scripts_quarantined.map(i => pick(i, ["script", "reason", "source"])),
    } } : {}),
  };
}

export function recordViewModel(root, kind, model, { source = kind, basis = "Recorded CLI result", at = new Date().toISOString(), head = viewHead(root) } = {}) {
  const projectors = { map: viewMapModel, audit: viewAuditModel, import: viewImportModel };
  if (!Object.hasOwn(projectors, kind)) throw viewError("VIEW_RECORD_INVALID", "Unknown view record kind.");
  const record = { version: 1, kind, source, basis, at, head, model: projectors[kind](model) };
  scanViewSurface(record);
  const key = kind === "import" ? `import-${createHash("sha256").update(source).digest("hex").slice(0, 24)}` : kind;
  if (evidenceDirectory(root) === resolve(root, LAYOUT.evidence)) ensureLayout(root);
  const path = join(evidenceDirectory(root), "view", "records", `${key}.json`);
  writeViewFile(root, path, JSON.stringify(record, null, 2) + "\n");
  return path;
}

// Reporting must not turn an otherwise successful audit into an execution
// failure. A failed retention is visible and cannot leave a stale model that
// pretends to be that run: its own timestamp and commit always travel with it.
export function retainViewModel(root, kind, model, options) {
  try { recordViewModel(root, kind, model, options); }
  catch (error) { console.error(JSON.stringify({ code: "VIEW_RECORD_NOT_SAVED", reason: error.code ?? "VIEW_WRITE_FAILED", kind })); }
}

export function readViewRecords(root) {
  const dir = join(evidenceDirectory(root), "view", "records");
  let files;
  try { files = readdirSync(dir).filter(f => /^(?:map|audit|import-[a-f0-9]{24})\.json$/.test(f)).sort(); }
  catch (error) { if (error.code === "ENOENT") return []; throw viewError("VIEW_RECORD_UNREADABLE", "Saved view records are unreadable."); }
  return files.map(file => {
    const path = resolveOutputPath(root, join(dir, file), { fileOnly: true });
    let record;
    try { record = JSON.parse(readFileSync(path, "utf8")); }
    catch { throw viewError("VIEW_RECORD_INVALID", "A saved view record is invalid JSON."); }
    if (record?.version !== 1 || !["map", "audit", "import"].includes(record.kind) || !record.model || !record.at)
      throw viewError("VIEW_RECORD_INVALID", "A saved view record has an unsupported shape.");
    // Content is not refused here: the page withholds what the scan flags
    // where it would render (records are written already scanned; an edited
    // or older one is withheld field by field, line by line).
    return record;
  });
}
