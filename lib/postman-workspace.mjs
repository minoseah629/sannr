import { LAYOUT } from './layout.mjs';
// Workspace flattening for the sibling Postman corpus. Postman workspaces are
// intentionally not represented as a store hierarchy: their identity is
// retained in manifests and the existing suite importer owns each collection.

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { inspectImportDirectory } from "./import-directory.mjs";
import { importBoundary, importFailure } from "./import-input.mjs";
import { importPostman, stableStringify, sourceDrift, renderImportReport } from "./import.mjs";
import { normalizeSuite, saveSuite, serializeSuite, suiteSecretProblems } from "./suites.mjs";
import { safeOutputPath, writeOutputFile } from './output-path.mjs';
import { scanMetadataSecrets } from './verdicts.mjs';

const digest = (value) => createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex");
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "collection";

function collectionValue(entry) { return entry?.collection && !entry.item ? entry.collection : entry; }

const captureFailure = (code, rule) => Object.assign(new Error(`Postman capture at $: ${rule}.`), { code });

export function readPostmanCapture(dir) {
  inspectImportDirectory(dir);
  const file = join(resolve(dir), "capture.json");
  if (!existsSync(file)) throw captureFailure("POSTMAN_CAPTURE_NOT_FOUND", "capture.json is required");
  let text;
  try { text = readFileSync(file, "utf8"); }
  catch { throw captureFailure("POSTMAN_CAPTURE_UNREADABLE", "capture.json must be a readable regular file"); }
  try { return JSON.parse(text); }
  catch { throw captureFailure("POSTMAN_CAPTURE_JSON_INVALID", "capture.json must contain valid JSON"); }
}

export function environmentFacts(capture) {
  const facts = {};
  for (const environment of capture?.environments ?? []) {
    const meta = environment?.environment && typeof environment.environment === "object" ? environment.environment : environment;
    const name = meta?.name ?? meta?.uid ?? meta?.id;
    if (!name) continue;
    Object.defineProperty(facts, name, { enumerable: true, configurable: true, value: { names: (environment.values ?? []).map((v) => ({
      name: v.key, type: v.type ?? "default", ...(v.enabled !== undefined ? { enabled: v.enabled !== false } : {}),
    })).filter((v) => v.name) } });
  }
  return facts;
}

export function flattenPostmanWorkspace(capture, options = {}) {
  return importBoundary("POSTMAN_CAPTURE_INVALID", "Postman capture at $", capture, () => {
    if (!capture || typeof capture !== "object" || Array.isArray(capture))
      throw importFailure("POSTMAN_CAPTURE_INVALID", "$", "capture must be an object");
    for (const key of ["collections", "environments", "workspaces"]) {
      if (capture[key] !== undefined && !Array.isArray(capture[key]))
        throw importFailure("POSTMAN_CAPTURE_INVALID", `$.${key}`, "must be an array");
    }
    return flattenPostmanWorkspaceValue(capture, options);
  });
}

function flattenPostmanWorkspaceValue(capture, { previousRollup = null } = {}) {
  const results = [];
  const used = new Set();
  const skipped = [];
  for (const raw of capture?.collections ?? []) {
    const collection = collectionValue(raw);
    if (!Array.isArray(collection?.item) || !collection.item.length) {
      skipped.push({ name: raw?.name ?? raw?.uid ?? raw?.id ?? "collection", reason: "missing or empty item list" });
      continue;
    }
    const identity = collection.info?.name ?? raw?.name ?? raw?.uid ?? raw?.id ?? "collection";
    let name = slug(identity), n = 2;
    while (used.has(name)) name = `${slug(identity)}-${n++}`;
    used.add(name);
    const sourceText = stableStringify(collection);
    const out = importPostman(collection, { sourceText, suiteName: name, sourceKind: "postman-workspace-collection" });
    const norm = out.suite.requests.length ? normalizeSuite(name, out.suite) : { suite: null, problems: [] };
    const problems = norm.problems?.length ? norm.problems : (norm.suite ? suiteSecretProblems(norm.suite) : []);
    if (problems?.length) throw Object.assign(new Error("Postman capture at $.collections: collection must satisfy suite validation rules"), { code: "POSTMAN_WORKSPACE_INVALID" });
    results.push({ name, source: { id: raw?.uid ?? raw?.id ?? null, name: identity }, suite: norm.suite,
      todo: out.todo, report: out.report, provenance: out.provenance });
  }
  const old = previousRollup?.collections ?? [];
  const diffs = results.map((r) => {
    const prior = old.find((x) => x.name === r.name);
    const drift = prior ? sourceDrift(prior.provenance, r.provenance) : null;
    return { name: r.name, drift: drift?.same_source ? null : drift };
  });
  const rollup = { v: 1, kind: "postman-workspace-rollup", workspace: capture?.workspaces?.map((w) => w.workspace ?? w).map((w) => ({ id: w?.id ?? w?.uid ?? null, name: w?.name ?? null })) ?? [],
    collections: results.map((r) => ({ name: r.name, source: r.source, provenance: r.provenance })),
    counts: results.reduce((a, r) => { for (const [key, value] of Object.entries(r.report.counts)) if (typeof value === "number") a[key] = (a[key] ?? 0) + value; return a; }, {}),
    diffs, skipped, environment_facts: environmentFacts(capture) };
  return { collections: results, rollup, environmentFacts: rollup.environment_facts };
}

export function flattenPostmanCaptureDir(dir, options = {}) {
  return flattenPostmanWorkspace(readPostmanCapture(dir), options);
}

export function writeFlattenedWorkspace(root, flattened, { direct = false } = {}) {
  const outputDir = direct ? resolve(root) : join(root, LAYOUT.suites);
  scanMetadataSecrets(flattened);
  safeOutputPath(outputDir, { directory: true });
  for (const item of flattened.collections) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(item.name))
      throw Object.assign(new Error('Workspace collection name must be a safe filename segment.'), { code: 'SUITE_NAME_INVALID' });
    for (const suffix of ['.json', '.todo.json', '.provenance.json', '.report.md']) safeOutputPath(join(outputDir, `${item.name}${suffix}`));
  }
  safeOutputPath(join(outputDir, 'postman-workspace.rollup.json'));
  mkdirSync(outputDir, { recursive: true });
  for (const item of flattened.collections) {
    if (item.suite) {
      if (direct) writeOutputFile(join(outputDir, `${item.name}.json`), serializeSuite(item.suite));
      else saveSuite(root, item.suite);
    }
    if (item.todo.length) writeOutputFile(join(outputDir, `${item.name}.todo.json`), `${stableStringify(item.todo)}\n`);
    writeOutputFile(join(outputDir, `${item.name}.provenance.json`), `${stableStringify(item.provenance)}\n`);
    writeOutputFile(join(outputDir, `${item.name}.report.md`), `${renderImportReport(item.report)}\n`);
  }
  const rollupPath = join(outputDir, "postman-workspace.rollup.json");
  writeOutputFile(rollupPath, `${stableStringify(flattened.rollup)}\n`);
  return { rollupPath, collections: flattened.collections.map((x) => x.name), environmentFacts: flattened.environmentFacts };
}
