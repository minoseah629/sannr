import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { importBruno, importBrunoDirectory, importInsomnia, importKong, importPostman, stableStringify } from "../lib/import.mjs";
import { parseYaml as readYaml } from "../lib/yaml.mjs";

const ROOT = resolve("..");
const corpus = join(ROOT, "import-corpus");
const postmanCorpus = join(ROOT, "postman-corpus");
// Local yardstick: the sibling corpora live OUTSIDE the repository on purpose
// (upstream material with its own provenance README). A clean checkout — a CI
// runner — has neither; these tests skip BY NAME rather than fail, and the
// local gate discipline runs them wherever the corpora exist.
const corpusSkip = existsSync(corpus) && existsSync(postmanCorpus) ? false
  : "sibling corpora ../import-corpus and ../postman-corpus are absent — local yardstick, run where they exist";
const walk = (root, predicate) => {
  const files = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) visit(path);
      else if (predicate(name, path)) files.push(path);
    }
  };
  visit(root);
  return files;
};

test("R1-E pins every real importer coverage and loss shape", { skip: corpusSkip }, () => {
  const postman = walk(join(corpus, "postman"), (name) => name.endsWith(".json"));
  // The AWS signature fixture now names unsupported own auth and raw body;
  // both fixtures remain manual and assertionless.
  assert.deepEqual(postman.map((path) => {
    const text = readFileSync(path, "utf8");
    const out = importPostman(JSON.parse(text), { sourceText: text });
    return [out.report.counts.items, out.report.counts.imported, out.report.counts.todo,
      out.report.counts.assertions_translated, out.report.counts.scripts_quarantined.length];
  }), [[1, 0, 1, 0, 2], [1, 0, 1, 0, 0]]);

  const ownerLegacy = join(postmanCorpus, "legacy", "legacy-claims.collection.json");
  const legacyText = readFileSync(ownerLegacy, "utf8");
  const legacy = importPostman(JSON.parse(legacyText), { sourceText: legacyText, sourceKind: "postman-v2.1" });
  // Only the status clause is exact: raw responseBody includes must not become
  // a parsed-JSON-root check, and timing has no executable suite target.
  assert.deepEqual([legacy.report.counts.items, legacy.report.counts.imported, legacy.report.counts.todo,
    legacy.report.counts.assertions_translated], [1, 1, 0, 1]);

  const brunoFile = join(corpus, "bruno", "usebruno-bruno-tests", "asserts", "test-assert-combinations.bru");
  const brunoText = readFileSync(brunoFile, "utf8");
  const one = importBruno(brunoText, { sourceText: brunoText });
  // The standalone file lacks declarations for httpfaker and foobar: both
  // unresolved-template losses are now named; its 28 translated clauses remain.
  assert.deepEqual([one.report.counts.items, one.report.counts.imported, one.report.counts.todo,
    one.report.counts.assertions_translated, one.report.counts.scripts_quarantined.length], [1, 0, 1, 28, 2]);

  const directory = importBrunoDirectory(join(corpus, "bruno", "usebruno-bruno-tests"));
  // IMPORT-POLICY-1 accepted floor: inherited setup is unverified metadata,
  // not a veto. The 26 historical runnable->todo rows have own blockers:
  // 17 body limits, 3 undeclared templates, 3 missing faithful assertions and
  // 3 unsupported/conflicting auth cases. The 226-clause total predates this
  // restoration; historical response alias/contains/truthiness approximations
  // are not restored. Named losses retain own semantics and each inherited owner once.
  assert.deepEqual([directory.report.counts.items, directory.report.counts.imported, directory.report.counts.todo,
    directory.report.counts.translated, directory.report.counts.scripts_quarantined.length], [223, 92, 131, 226, 1643]);

  const insomnia = walk(join(corpus, "insomnia"), (name) => name.endsWith(".yaml"));
  let accepted = 0, items = 0, todo = 0, quarantined = 0, refused = 0;
  for (const path of insomnia) {
    const text = readFileSync(path, "utf8");
    try {
      const out = importInsomnia(readYaml(text), { sourceText: text });
      accepted += 1; items += out.report.counts.items; todo += out.report.counts.todo;
      quarantined += out.report.counts.scripts_quarantined.length;
    } catch (error) {
      refused += 1;
      assert.match(error.code, /^INSOMNIA_(?:UNSUPPORTED_DOCUMENT|DOCUMENT_UNRECOGNIZED)$/);
    }
  }
  // Insomnia still has no faithful response assertions in these exports.
  // The ledger now names unresolved templates, omitted sensitive body values
  // and unsupported own auth, while inherited scripts are counted per owner.
  assert.deepEqual([accepted, items, todo, quarantined, refused], [12, 77, 77, 142, 2]);

  const kongFiles = walk(join(corpus, "kong"), (name) => /\.ya?ml$/i.test(name));
  let kongImported = 0, declared = 0, skipped = 0, losses = 0, kongRefused = 0;
  const kongReasons = new Set();
  for (const path of kongFiles) {
    const text = readFileSync(path, "utf8");
    try {
      const out = importKong(readYaml(text), { sourceText: text });
      kongImported += 1; declared += out.report.counts.declared; skipped += out.report.counts.skipped;
      losses += out.report.loss.length; out.report.loss.forEach((entry) => kongReasons.add(entry.name));
    } catch (error) {
      kongRefused += 1;
      assert.match(error.code, /^(?:KONG|YAML)_[A-Z0-9_]+$/);
    }
  }
  assert.deepEqual([kongFiles.length, kongImported, declared, skipped, losses, kongRefused], [189, 174, 68, 74, 258, 15]);
  assert.deepEqual([...kongReasons].sort(), ["ca_certificates", "certificates", "config", "consumer", "consumers", "key_sets", "keys"]);
});

// Literal source presence is weaker than semantic equivalence. In particular,
// existing projections such as numberBig.toString() are not certified as valid
// network-response JSON selectors merely because their text occurs in source.
const sourceSegmentPattern = segment => {
  const escaped = segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\w$])${escaped}(?=$|[^\\w$])`);
};

test("R1-E source presence handles literal punctuation and identifier boundaries", () => {
  const call = sourceSegmentPattern("toString()");
  assert.match("res.body.numberBig.toString(): eq value", call);
  assert.doesNotMatch("res.body.numberBig.toString: eq value", call);
  assert.doesNotMatch("res.body.numberBig.xtoString(): eq value", call);
  assert.doesNotMatch("res.body.numberBig.toString()suffix: eq value", call);
  assert.match("res.body.numberBig: eq value", sourceSegmentPattern("numberBig"));
  assert.doesNotMatch("res.body.numberBiggest: eq value", sourceSegmentPattern("numberBig"));
});

test("R1-E translation-truth sample is response-backed, not local-variable-backed", { skip: corpusSkip }, () => {
  const files = walk(join(corpus, "bruno"), (name) => name.endsWith(".bru"));
  const translated = [];
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    let out;
    try { out = importBruno(text, { sourceText: text }); } catch { continue; }
    // A translated clause can survive on a manual request whose own URL/body
    // cannot run. Sample both stores to retain coverage without claiming that
    // standalone files have their collection's runtime bindings available.
    // Source translation validity does not prove request executability.
    for (const step of [...out.suite.requests, ...out.todo]) {
      for (const [index, assertion] of (step.expect ?? []).entries()) {
        if (step.assertion_provenance?.[index] === "translated") translated.push({ path, text, assertion });
      }
    }
  }
  assert.ok(translated.length >= 20);
  const sampleIndexes = Array.from({ length: 20 }, (_, index) => Math.floor(index * translated.length / 20));
  for (const sample of sampleIndexes.map((index) => translated[index])) {
    const response = /\bres\b|\bresponse(?:Body|Code|Headers?)\b|pm\.response/i.test(sample.text);
    assert.ok(response, `${sample.path}: ${stableStringify(sample.assertion)} has no response reference`);
    const claimed = sample.assertion.json ?? sample.assertion.header;
    if (claimed) for (const segment of String(claimed).split(/[.\[\]]/).filter(Boolean))
      assert.match(sample.text, sourceSegmentPattern(segment), `${sample.path}: missing claimed path ${claimed}`);
  }
  const legacyPath = join(postmanCorpus, "legacy", "legacy-claims.collection.json");
  const legacyText = readFileSync(legacyPath, "utf8");
  const legacy = importPostman(JSON.parse(legacyText), { sourceText: legacyText });
  // The faithful legacy sample is the status clause; neither raw-body includes
  // nor response timing is approximated into an unrelated suite operator.
  assert.equal(legacy.report.counts.assertions_translated, 1);
  assert.deepEqual(legacy.suite.requests[0].expect, [{ status: 200 }]);
  assert.ok(legacy.report.counts.scripts_quarantined.some(entry =>
    entry.script.endsWith(":body") && entry.reason === "legacy assertion is outside the complete mechanical grammar"));
  assert.ok(legacy.report.counts.scripts_quarantined.some(entry =>
    entry.script.endsWith(":timing") && entry.reason === "response-time comparison has no suite target"));
  assert.ok(legacy.report.items[0].notes.includes("reported-only legacy fact(s): response-time comparison (not executed)"));
  assert.match(legacyText, /response(?:Body|Code|Headers?)/);
});

test("R1-E external corpus README has one provenance row for every corpus file", { skip: corpusSkip }, () => {
  const manifest = readFileSync(join(corpus, "README.md"), "utf8");
  const rows = new Map(manifest.split("## Per-file manifest\n")[1].split("\n").filter((line) => line.startsWith("| ") && line.endsWith(" |"))
    .slice(1).map((line) => { const cells = line.slice(2, -2).split(" | "); return [cells[0], cells.slice(1)]; }));
  const files = ["bruno", "kong", "insomnia", "postman"].flatMap((dir) => walk(join(corpus, dir), () => true))
    .map((path) => path.slice(corpus.length + 1)).sort();
  assert.deepEqual([...rows.keys()].sort(), files);
  for (const [path, [source, commit, license, synthetic]] of rows) {
    assert.equal(synthetic, "no", path);
    assert.ok(source.startsWith("https://github.com/") || source === "owner-provided corpus", path);
    assert.notEqual(commit, "", path);
    assert.notEqual(license, "", path);
  }
});

test("R1-E corpus artifacts never contain Kong or Bruno credential material", { skip: corpusSkip }, () => {
  const roots = [join(corpus, "kong"), join(corpus, "bruno")];
  const forbidden = ["your_secret_token", "collection_pre_var_value", "fixture-secret", "fixture-key", "fixture-password"];
  for (const root of roots) for (const path of walk(root, () => true)) {
    const text = readFileSync(path, "utf8");
    let out;
    try { out = path.endsWith(".bru") ? importBruno(text, { sourceText: text }) : importKong(readYaml(text), { sourceText: text }); }
    catch { continue; }
    assert.ok(forbidden.every((value) => !stableStringify(out).includes(value)), `${path}: fixture material crossed into output`);
  }
});
