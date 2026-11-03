// Robustness driver: turns seed files into deterministic variations, runs
// them in a worker per source with a wall-clock deadline per input, and
// reports outcomes by entry point and variation class. Shared by the gate
// test (in-repo seeds only, bounded) and the extended runner (a local corpus).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { Worker } from "node:worker_threads";
import { TEXT_CLASSES, DIRECTORY_CLASSES, vary } from "./variations.mjs";

export const DEADLINE_MS = 2_000;
export const MEMORY_BOUND = 200 * 1024 * 1024;
export const MARKERS = ["ROB1_AUTH_VALUE_", "ROB1_ENV_VALUE_"];
export const SEEDS_DIR = new URL("../fixtures/robustness/seeds/", import.meta.url).pathname;
const MODULES = {
  yamlModule: new URL("../../lib/yaml.mjs", import.meta.url).href,
  importModule: new URL("../../lib/import.mjs", import.meta.url).href,
  workspaceModule: new URL("../../lib/postman-workspace.mjs", import.meta.url).href,
};

/** Which entry point reads a file, decided from its shape, never its origin. */
export function entryFor(path, text) {
  const ext = extname(path).toLowerCase();
  if (ext === ".bru") return { entry: "importBruno", kind: "text" };
  if (ext === ".json") {
    let doc; try { doc = JSON.parse(text); } catch { return null; }
    if (doc?._type === "export" || /insomnia\.rest/.test(String(doc?.type ?? ""))) return { entry: "importInsomnia", kind: "json" };
    if (doc?.info?.schema || Array.isArray(doc?.item)) return { entry: "importPostman", kind: "json" };
    return null;
  }
  if (ext === ".yaml" || ext === ".yml") {
    if (/^_format_version:/m.test(text)) return { entry: "importKong", kind: "text" };
    if (/insomnia\.rest\/5\.0/.test(text)) return { entry: "importInsomnia", kind: "parsed-yaml" };
    if (/^collection:/m.test(text) || /schema\.getpostman\.com/.test(text)) return { entry: "importPostmanV3", kind: "text" };
    return { entry: "parseYaml", kind: "text" };
  }
  return null;
}

/** Text sources: every seed file that an entry point reads. */
export function textSources(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      const text = readFileSync(p, "utf8");
      const target = entryFor(p, text);
      if (target) out.push({ path: p, name: p.slice(dir.length).replace(/^\//, ""), text, ...target });
    }
  };
  walk(dir);
  return out;
}

/** Directory sources: a Bruno collection directory and a Postman capture directory. */
export function directorySources(dir) {
  const sources = [];
  const bruno = join(dir, "bruno");
  if (statSync(bruno, { throwIfNoEntry: false })?.isDirectory()) {
    const files = {};
    for (const name of readdirSync(bruno)) { const p = join(bruno, name); if (statSync(p).isFile()) files[name] = readFileSync(p, "utf8"); }
    sources.push({ name: "bruno/", entry: "importBrunoDirectory", files });
  }
  const capture = join(dir, "capture.json");
  if (statSync(capture, { throwIfNoEntry: false })?.isFile()) {
    const files = { "capture.json": readFileSync(capture, "utf8") };
    const env = join(dir, "environment.json");
    if (statSync(env, { throwIfNoEntry: false })?.isFile()) files["environment.json"] = readFileSync(env, "utf8");
    sources.push({ name: "capture/", entry: "flattenPostmanCaptureDir", files });
  }
  return sources;
}

/** Build the job list for one source: every class × every index. */
export function jobsFor(source, { seed, iterations }) {
  const jobs = [];
  if (source.files) {
    for (const variation of DIRECTORY_CLASSES) jobs.push({ source: source.name, entry: source.entry, kind: "directory", variation, index: 0, files: source.files, markers: MARKERS });
    return jobs;
  }
  for (const variation of TEXT_CLASSES) {
    for (let index = 0; index < iterations; index += 1) {
      const text = vary(source.text, { seed, source: source.name, index, variation, entry: source.entry });
      // parsed-yaml entries take the parsed document; a parse failure is the
      // harness's, unless it is not a named failure — that is a finding.
      jobs.push({ source: source.name, entry: source.entry, kind: source.kind, variation, index, input: text, markers: MARKERS });
    }
  }
  return jobs;
}

/** Run one source's jobs in a worker, enforcing the per-input deadline. */
export function runSource(jobs) {
  return new Promise((resolve) => {
    const results = new Map();
    // Jobs travel with their list position; the variation index stays the job's own.
    const worker = new Worker(new URL("./worker.mjs", import.meta.url), { workerData: { ...MODULES, jobs: jobs.map((j, i) => ({ ...j, position: i })) } });
    let timer = null, cursor = 0;
    const finish = () => { clearTimeout(timer); worker.terminate().finally(() => resolve(jobs.map((job, i) => ({ ...job, ...(results.get(i) ?? { outcome: "skipped-after-timeout", ms: null, rssDelta: 0, message: "", leaks: [] }) })))); };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        results.set(cursor, { outcome: "timeout", ms: DEADLINE_MS, rssDelta: 0, message: `no result within ${DEADLINE_MS} ms`, leaks: [] });
        finish();
      }, DEADLINE_MS + 500);
    };
    worker.on("message", (m) => {
      if (m.done) return finish();
      const { position, ...result } = m;
      results.set(position, result); cursor = position + 1; arm();
    });
    worker.on("error", (error) => { results.set(cursor, { outcome: "worker-error", ms: null, rssDelta: 0, message: String(error?.message ?? "").slice(0, 200), leaks: [] }); finish(); });
    arm();
  });
}

export function isDefect(r) {
  return /^native:|^uncoded$|^timeout$|^worker-error$|^skipped-after-timeout$/.test(r.outcome) || r.leaks.length > 0
    || (r.rssDelta > MEMORY_BOUND && (typeof r.input !== "string" || r.input.length < 1024 * 1024));
}

export async function runAll(sources, { seed = 1, iterations = 1 } = {}) {
  const all = [];
  for (const source of sources) {
    const jobs = jobsFor(source, { seed, iterations }).map((job) => ({ ...job, seed }));
    if (!jobs.length) continue;
    all.push(...(await runSource(jobs)));
  }
  return all;
}

/** Re-run every defect once more; a defect that does not reproduce is reported as such. */
export async function reproduce(results) {
  const defects = results.filter(isDefect);
  const again = [];
  for (const d of defects) again.push(...(await runSource([d])));
  return defects.map((d, i) => ({ ...d, reproduced: isDefect(again[i]) && again[i].outcome === d.outcome }));
}

export function table(results) {
  const rows = new Map();
  for (const r of results) {
    const key = `${r.entry} × ${r.variation}`;
    const row = rows.get(key) ?? { entry: r.entry, variation: r.variation, result: 0, named: 0, harness: 0, defect: 0 };
    if (isDefect(r)) row.defect += 1;
    else if (r.outcome === "result") row.result += 1;
    else if (r.outcome.startsWith("named:")) row.named += 1;
    else row.harness += 1;
    rows.set(key, row);
  }
  return [...rows.values()];
}

export function summary(results) {
  const defects = results.filter(isDefect);
  return {
    inputs: results.length,
    results: results.filter((r) => r.outcome === "result").length,
    named: results.filter((r) => r.outcome.startsWith("named:")).length,
    harness: results.filter((r) => r.outcome.startsWith("harness:")).length,
    defects: defects.length,
    maxMs: Math.max(0, ...results.map((r) => r.ms ?? 0)),
    maxRssDelta: Math.max(0, ...results.map((r) => r.rssDelta ?? 0)),
    findings: defects.map((d) => `${d.outcome}${d.leaks.length ? ` leaks=${d.leaks.join(",")}` : ""} — ${d.entry} ${d.variation} seed=${d.seed ?? 1} source=${d.source} index=${d.index}: ${d.message}`),
  };
}

