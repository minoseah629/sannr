// Robustness worker: runs one job list against the importer entry points in a
// separate thread so the driver can enforce a wall-clock deadline per input
// and observe memory growth. Every outcome is classified here; the driver
// never sees an exception object, only its class and a bounded message.
import { parentPort, workerData } from "node:worker_threads";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const yaml = await import(workerData.yamlModule);
const im = await import(workerData.importModule);
const pw = await import(workerData.workspaceModule);

const ENTRIES = {
  parseYaml: (input) => yaml.parseYaml(input),
  importPostman: (input) => im.importPostman(input, { sourceText: "" }),
  importPostmanV3: (input) => im.importPostmanV3(input),
  importInsomnia: (input) => im.importInsomnia(input),
  importBruno: (input) => im.importBruno(input),
  importKong: (input) => im.importKong(input),
  importBrunoDirectory: (dir) => im.importBrunoDirectory(dir),
  flattenPostmanCaptureDir: (dir) => pw.flattenPostmanCaptureDir(dir),
};

const NATIVE = [TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError];
function classify(error) {
  if (NATIVE.some((c) => error instanceof c)) return `native:${error.constructor.name}`;
  if (/Maximum call stack/.test(String(error?.message))) return "native:RangeError";
  if (error instanceof Error && typeof error.code === "string" && error.code) return `named:${error.code}`;
  return "uncoded";
}
const leaks = (text, markers) => markers.filter((m) => text.includes(m));

// Directory variations are built here, inside the worker's own temp root, so a
// timeout leaves nothing behind in the repository.
function buildDirectory(job) {
  const root = mkdtempSync(join(tmpdir(), "sannr-robustness-"));
  for (const [name, text] of Object.entries(job.files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  switch (job.variation) {
    case "directory-baseline": break;
    case "missing-manifest": for (const m of ["bruno.json", "capture.json"]) rmSync(join(root, m), { force: true }); break;
    case "bru-name-directory": mkdirSync(join(root, "request.bru")); break;
    case "empty-file": writeFileSync(join(root, job.entry === "importBrunoDirectory" ? "empty.bru" : "capture.json"), ""); break;
    case "symlink-cycle": symlinkSync(root, join(root, "cycle")); break;
    case "many-files": for (let n = 0; n < 600; n += 1) writeFileSync(join(root, `f${n}.bru`), "meta {\n  name: f\n  type: http\n}\n"); break;
    default: throw new Error(`unknown directory variation ${job.variation}`);
  }
  return root;
}

function run(job) {
  const fn = ENTRIES[job.entry];
  const before = process.memoryUsage().rss;
  const t0 = performance.now();
  let root = null, outcome, message = "", surfaces = "";
  try {
    let input = job.input;
    if (job.kind === "directory") root = input = buildDirectory(job);
    else if (job.kind === "json") {
      try { input = JSON.parse(job.input); }
      catch { return { outcome: "harness:unparseable", ms: 0, rssDelta: 0, message: "", leaks: [] }; }
    } else if (job.kind === "parsed-yaml") {
      // The parser is under test too: a named refusal is a legitimate outcome,
      // a native exception from the parser is a defect exactly like any other.
      input = yaml.parseYaml(job.input);
    }
    const result = fn(input);
    outcome = "result";
    // Every result flows through the report renderer, and every output surface
    // is scanned for the planted values that must never cross the boundary.
    if (result && typeof result === "object" && result.report) {
      const report = im.renderImportReport(result.report, { cli: "sannr" });
      surfaces = JSON.stringify({ suite: result.suite ?? null, todo: result.todo ?? null, report: result.report }) + report;
    } else surfaces = JSON.stringify(result ?? null);
  } catch (error) {
    outcome = classify(error);
    message = String(error?.message ?? "").slice(0, 200);
    surfaces = JSON.stringify({ message: error?.message, code: error?.code, name: error?.name, cause: error?.cause?.message ?? null });
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
  const ms = performance.now() - t0;
  const rssDelta = process.memoryUsage().rss - before;
  return { outcome, ms, rssDelta, message, leaks: leaks(surfaces, job.markers) };
}

for (const job of workerData.jobs) {
  const result = run(job);
  parentPort.postMessage({ position: job.position, ...result });
}
parentPort.postMessage({ done: true });
