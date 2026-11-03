import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
// The upstream corpus lives outside the repository; a sibling-free checkout (CI) skips by name.
const corpusSkip = existsSync(resolve("../import-corpus")) ? false
  : "sibling corpus ../import-corpus absent — local yardstick, run where it exists";
import { parseYaml, YAML_MAX_DEPTH } from "../lib/yaml.mjs";
import { importPostmanV3, importKong, importInsomnia, stableStringify } from "../lib/import.mjs";

test("R1-A2 document markers are only column-zero stream markers", () => {
  assert.deepEqual(parseYaml("desc: |\n  line one\n  ---\n  line two\nnext: 1\n"), {
    desc: "line one\n---\nline two\n", next: 1,
  });
  assert.deepEqual(parseYaml("desc: |\n  Loading\n  ...\n  done\nnext: 1\n"), {
    desc: "Loading\n...\ndone\n", next: 1,
  });
  assert.deepEqual(parseYaml("quoted: 'first\n---\nlast'\nnext: 1\n"), {
    quoted: "first\n---\nlast", next: 1,
  });
  assert.deepEqual(parseYaml("items:\n  - one\n  - ---\n  - three\n"), {
    items: ["one", "---", "three"],
  });
});

test("R1-A2 multi false rejects multiple documents by name", () => {
  assert.throws(() => parseYaml("a: 1\n---\nb: 2\n"), {
    code: "YAML_MULTI_DOCUMENT",
    message: /2 documents/,
  });
  assert.deepEqual(parseYaml("a: 1\n---\nb: 2\n", { multi: true }), [{ a: 1 }, { b: 2 }]);
});

test("R1-A2 structural depth counts flow and block nesting", () => {
  assert.throws(() => parseYaml("a: " + "[".repeat(35) + "]".repeat(35)), { code: "YAML_DEPTH_EXCEEDED" });
  assert.throws(() => parseYaml("a: " + "{b: ".repeat(35) + "null" + "}".repeat(35)), { code: "YAML_DEPTH_EXCEEDED" });
  const lines = Array.from({ length: 17 }, (_, i) => `${"    ".repeat(i)}k${i}:`);
  lines.push(`${"    ".repeat(17)}v: 1`);
  assert.equal(parseYaml(lines.join("\n")).k0.k1.k2.k3.k4.k5.k6.k7.k8.k9.k10.k11.k12.k13.k14.k15.k16.v, 1);
});

test("R1-H YAML depth boundary counts containers including the root", () => {
  const nested = {
    "block maps": (n) => Array.from({ length: n - 1 }, (_, i) => `${"  ".repeat(i)}k${i}:`).concat(`${"  ".repeat(n - 1)}k${n - 1}: value`).join("\n"),
    "block sequences": (n) => Array.from({ length: n - 1 }, (_, i) => `${"  ".repeat(i)}-`).concat(`${"  ".repeat(n - 1)}- value`).join("\n"),
    "flow sequences": (n) => "[".repeat(n) + "1" + "]".repeat(n),
    // Mixed nesting: the flow collection sits INSIDE block containers, so its
    // brackets must continue the block count, not restart at zero. Found by
    // the lead measuring the boundary with a helper that counts containers
    // including the root — the pure-flow row above passed while these did not.
    "root map + flow sequences": (n) => "a: " + "[".repeat(n - 1) + "1" + "]".repeat(n - 1),
    "root map + flow maps": (n) => "a: " + "{b: ".repeat(n - 1) + "1" + "}".repeat(n - 1),
    "two block maps + flow sequences": (n) => ("a:" + "\n  b: ") + "[".repeat(n - 2) + "1" + "]".repeat(n - 2),
  };
  const containerCount = (value) => {
    let count = 0;
    while (value && typeof value === "object") {
      count += 1;
      value = Array.isArray(value) ? value[0] : Object.values(value)[0];
    }
    return count;
  };
  assert.equal(YAML_MAX_DEPTH, 33);
  for (const [kind, build] of Object.entries(nested)) {
    const accepted = parseYaml(build(YAML_MAX_DEPTH));
    assert.equal(containerCount(accepted), YAML_MAX_DEPTH, `${kind} accept boundary`);
    assert.throws(() => parseYaml(build(YAML_MAX_DEPTH + 1)), { code: "YAML_DEPTH_EXCEEDED" }, `${kind} refuse boundary`);
  }
});

test("R1-H YAML warnings are readable before serialization; importers do not surface them", () => {
  const source = "type: collection.insomnia.rest/5.0\ncollection:\n  - name: one\n    name: duplicate\n    method: GET\n    url: /x\n";
  const parsed = parseYaml(source);
  assert.deepEqual(parsed.yamlWarnings, ["duplicate key: name"]);
  assert.equal(JSON.stringify(parsed).includes("yamlWarnings"), false);
  assert.equal(importInsomnia(parsed).report.yamlWarnings, undefined,
    "importers deliberately do not copy the non-enumerable warning channel into loss reports");
});

test("R1-A2 importers use the bounded YAML facade", () => {
  const oversized = "x".repeat(50 * 1024 * 1024 + 1);
  for (const load of [importPostmanV3, importKong]) {
    assert.throws(() => load(oversized), { code: "YAML_INPUT_OVERSIZED" });
    assert.throws(() => load("a: 1\n---\nb: 2\n"), { code: "YAML_MULTI_DOCUMENT" });
  }
});

test("R1-A YAML tags, scalar indicators, comments, CRLF, and duplicate reporting", () => {
  const doc = parseYaml("\uFEFFa: !!str 12\r\nb: !!int \"12\" # comment\r\nc: !!bool false\r\nd: !!null null\r\ntext: |2-\r\n    first # literal\r\n    second\r\nfold: >+\r\n  one\r\n  two\r\na: last\r\n");
  assert.deepEqual({ a: doc.a, b: doc.b, c: doc.c, d: doc.d }, { a: "last", b: 12, c: false, d: null });
  assert.equal(doc.text, "  first # literal\n  second");
  assert.equal(doc.fold, "one two\n\n");
  assert.deepEqual(doc.yamlWarnings, ["duplicate key: a"]);
  assert.throws(() => parseYaml("x: !custom value"), { code: "YAML_UNKNOWN_TAG" });
});

test("R1-A bounds reject alias bombs, deep indentation, tabs, and oversized input", () => {
  const lines = ["a: &a [lol, lol, lol, lol, lol, lol, lol, lol, lol, lol]"];
  for (let i = 0; i < 8; i++) {
    const ref = `*a${i ? i - 1 : "a"}`;
    lines.push(`a${i}: &a${i} [${Array(10).fill(ref).join(", ")}]`);
  }
  assert.throws(() => parseYaml(lines.join("\n")), { code: "YAML_ALIAS_EXPANSION_EXCEEDED" });
  assert.throws(() => parseYaml(Array.from({ length: 40 }, (_, i) => `${"  ".repeat(i)}x${i}:`).join("\n")), { code: "YAML_DEPTH_EXCEEDED" });
  assert.throws(() => parseYaml(("a:" + "\n\tb: 1")), { code: "YAML_TABS_INDENTATION" });
  assert.throws(() => parseYaml("x".repeat(50 * 1024 * 1024 + 1)), { code: "YAML_INPUT_OVERSIZED" });
});

test("R1-A prototype-shaped keys are ordinary own data properties", () => {
  const doc = parseYaml("__proto__: {polluted: true}\nconstructor: safe\nprototype: also-safe");
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(doc, "__proto__"), true);
  assert.deepEqual(doc["__proto__"], { polluted: true });
});

test("R1-A corpus files parse or return named failures without crashing", { skip: corpusSkip }, () => {
  const roots = [resolve("../import-corpus/kong"), resolve("../import-corpus/insomnia")];
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.ya?ml$/i.test(name)) files.push(path);
    }
  };
  for (const root of roots) walk(root);
  const counts = { parsed: 0, namedFailure: 0 };
  for (const path of files) {
    try { parseYaml(readFileSync(path, "utf8")); counts.parsed += 1; }
    catch (error) {
      assert.match(error?.code ?? "", /^YAML_[A-Z0-9_]+$/, path);
      counts.namedFailure += 1;
    }
  }
  console.log(`R1-A corpus: ${counts.parsed} parsed, ${counts.namedFailure} named failures (${files.length} files)`);
  assert.equal(counts.parsed + counts.namedFailure, files.length);
});

test("R1-D Kong corpus imports safely and leaks no fixture material", { skip: corpusSkip }, () => {
  const root = resolve("../import-corpus/kong/kong-deck-testdata");
  const files = [], walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.ya?ml$/i.test(name)) files.push(path);
    }
  };
  walk(root);
  const materialKeys = /^(?:key|secret|password|client_secret|private_key|certificate|ca_certificate|cert|ca_cert)$/i;
  const materials = new Set(), outputs = [];
  const collect = (value, key = "") => {
    if (typeof value === "string") {
      if (materialKeys.test(key) && value) materials.add(value);
      for (const pem of value.match(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g) ?? []) materials.add(pem);
    } else if (Array.isArray(value)) value.forEach((item) => collect(item, key));
    else if (value && typeof value === "object") Object.entries(value).forEach(([k, v]) => collect(v, k));
  };
  let imported = 0, namedFailures = 0;
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    try {
      const parsed = parseYaml(source);
      collect(parsed);
      outputs.push(stableStringify(importKong(parsed, { suiteName: "corpus" })));
      imported += 1;
    } catch (error) {
      assert.match(error?.code ?? "", /^(?:KONG|YAML)_[A-Z0-9_]+$/, path);
      namedFailures += 1;
    }
  }
  const artifact = outputs.join("\n");
  for (const literal of materials) assert.equal(artifact.includes(literal), false, literal.slice(0, 40));
  assert.equal(imported + namedFailures, files.length);
  assert.ok(materials.size > 0);
  console.log(`R1-D Kong corpus: ${imported} imported, ${namedFailures} named failures, ${materials.size} fixture literals withheld`);
});

test("R1-H Kong 1.x declarative fixtures import with explicit path semantics", { skip: corpusSkip }, () => {
  const root = resolve("../import-corpus/kong/kong-deck-testdata/dump/004-skip-consumers-with-consumer-groups");
  const files = ["kong.yaml", "expected-no-flag_1.yaml", "expected-with-flag_1.yaml"];
  for (const file of files) {
    const out = importKong(parseYaml(readFileSync(join(root, file), "utf8")));
    assert.equal(out.report.facts.path_semantics, "Kong 1.x/2.x paths use pre-3.0 path semantics", file);
  }
  assert.throws(() => importKong(parseYaml(readFileSync(resolve("../import-corpus/kong/kong-deck-testdata/lint/002-extends/oas.yaml"), "utf8"))),
    (error) => error.code === "KONG_OPENAPI_DOCUMENT" && /init.*learn/.test(error.message));
  const synthetic21 = { _format_version: "2.1", services: [] };
  assert.equal(importKong(synthetic21).report.facts.path_semantics, "Kong 1.x/2.x paths use pre-3.0 path semantics");
});
