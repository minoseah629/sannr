import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DOCS = ["docs/agent-guide.md", "docs/agent-examples.md"];

function read(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

function fenced(markdown, language) {
  return [...markdown.matchAll(new RegExp("```" + language + "\\n([\\s\\S]*?)^```", "gm"))]
    .map((match) => match[1]);
}

test("agent documentation shell examples use real project-local commands", () => {
  const help = execFileSync(process.execPath, [join(ROOT, "bin", "cli.mjs"), "--help"],
    { cwd: ROOT, encoding: "utf8" });
  const commands = new Set([...help.matchAll(/^  ([a-z][a-z-]*)\s+/gm)].map((match) => match[1]));
  const commandLines = DOCS.flatMap((path) => fenced(read(path), "sh"))
    .flatMap((block) => block.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line.startsWith("./node_modules/.bin/sannr "));

  assert.ok(commandLines.length > 0, "no project-local command examples found");
  for (const line of commandLines) {
    const command = line.split(/\s+/)[1];
    if (command === "--help") continue;
    assert.ok(commands.has(command), `documented command is not in CLI help: ${line}`);
  }
  for (const path of DOCS) {
    assert.doesNotMatch(read(path), /^sannr\s+[a-z]/gm, `${path} uses a bare command instead of the local shim`);
    assert.doesNotMatch(read(path), /\/Users\/|\/private\/var\//, `${path} contains a machine-local path`);
  }
});

test("every JSON example in the agent documentation parses", () => {
  const examples = DOCS.flatMap((path) => fenced(read(path), "json"));
  assert.ok(examples.length > 0, "no JSON examples found");
  for (const example of examples) assert.doesNotThrow(() => JSON.parse(example));
});

test("capture examples interpolate expect only after the named capture is defined", () => {
  const examples = DOCS.flatMap((path) => fenced(read(path), "json")).map((example) => JSON.parse(example));
  let interpolated = 0;
  for (const example of examples) {
    const requests = example.requests ?? (example.path ? [example] : []);
    const defined = new Set();
    for (const request of [...requests, ...(example.finally ?? [])]) {
      for (const clause of request.expect ?? []) {
        for (const [, name] of JSON.stringify(clause).matchAll(/\{([A-Za-z][A-Za-z0-9_-]*)\}/g)) {
          assert.ok(defined.has(name), `expect refers to capture ${name} before a previous step defines it`);
          interpolated++;
        }
      }
      for (const name of Object.keys(request.capture ?? {})) defined.add(name);
    }
  }
  assert.ok(interpolated > 0, "the examples must demonstrate captured expect interpolation");
});

test("the npm artifact contains the canonical agent documentation", () => {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--offline"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0].files
    .map(({ path }) => path);
  for (const path of DOCS) assert.ok(packed.includes(path), `${path} is not in the package artifact`);
});
