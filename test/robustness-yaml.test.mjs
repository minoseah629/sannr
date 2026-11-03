import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { parseYaml, YAML_MAX_DEPTH } from "../lib/yaml.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/robustness/${name}`, import.meta.url), "utf8");
const named = (code) => (error) => {
  assert.equal(error.constructor, Error);
  assert.equal(error.code, code);
  assert.doesNotMatch(error.message, /Maximum call stack|ROB1_YAML_PRIVATE_TAG_VALUE_9f4b/);
  assert.equal(error.cause, undefined, "raw parser exceptions must not escape through cause");
  return true;
};

test("ROB-1 YAML anchor-prefix stack specimen is refused at the parser depth bound", () => {
  assert.throws(() => parseYaml(fixture("yaml-anchor-prefix-stack.yaml")), named("YAML_DEPTH_EXCEEDED"));
});

test("ROB-1 YAML aliases count their expanded container depth", () => {
  assert.throws(() => parseYaml(fixture("yaml-alias-depth.yaml")), named("YAML_DEPTH_EXCEEDED"));
  const source = ["a0: &a0 [0]", ...Array.from({ length: YAML_MAX_DEPTH - 2 }, (_, i) => `a${i + 1}: &a${i + 1} [*a${i}]`)];
  assert.ok(parseYaml(source.join("\n")), "aliases at the existing depth boundary are accepted");
});

for (const style of ["block", "flow"]) {
  test(`ROB-1 YAML ${style} tag errors describe the location and rule without echoing input`, () => {
    assert.throws(() => parseYaml(fixture(`yaml-private-tag-${style}.yaml`)), (error) => {
      named("YAML_UNKNOWN_TAG")(error);
      assert.match(error.message, /YAML document .*tag.*not supported/);
      return true;
    });
  });
}

test("ROB-1 YAML complex key specimen returns a named failure instead of a native TypeError", () => {
  assert.throws(() => parseYaml(fixture("yaml-complex-key-typeerror.yaml")), named("YAML_KEY_INVALID"));
});

test("ROB-1 YAML unclosed multiline quote specimen scans linearly within two seconds", async () => {
  // Keep the specimen minimal; repetition exposes the formerly quadratic scan.
  const [opening, continuation] = fixture("yaml-unclosed-multiline-quote.yaml").trimEnd().split("\n");
  const input = `${opening}\n${`${continuation}\n`.repeat(60_000)}`;
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    import(workerData.module).then(({ parseYaml }) => {
      try { parseYaml(workerData.input); parentPort.postMessage("result"); }
      catch (error) { parentPort.postMessage({ name: error.name, code: error.code, message: error.message }); }
    });
  `, { eval: true, workerData: { input, module: new URL("../lib/yaml.mjs", import.meta.url).href } });
  try {
    const result = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("ROB-1 timeout: seed=0 source=yaml-unclosed-multiline-quote.yaml variation=60000")), 2_000);
      worker.once("message", (value) => { clearTimeout(deadline); resolve(value); });
      worker.once("error", (error) => { clearTimeout(deadline); reject(error); });
    });
    assert.equal(result, "result");
  } finally { await worker.terminate(); }
});
