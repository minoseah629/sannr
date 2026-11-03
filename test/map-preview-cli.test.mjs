import { LAYOUT } from "../lib/layout.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin/cli.mjs");

function fixture(t, { tty = false, mode = "allow" } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "map-preview-cli-")));
  const eventsPath = join(root, "preview-events.jsonl");
  const preload = join(root, "preview-guard.mjs");
  const events = () => existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
    : [];
  t.after(() => {
    for (const event of events()) if (event.pid) {
      try { process.kill(event.pid, "SIGTERM"); } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "openapi.json"), JSON.stringify({
    openapi: "3.0.3", info: { title: "Browser preview fixture", version: "1" },
    paths: { "/items": { get: { responses: { 200: { description: "Items" } } } } },
  }));
  writeFileSync(preload, `
    import child from 'node:child_process';
    import http from 'node:http'; import https from 'node:https';
    import net from 'node:net'; import tls from 'node:tls';
    import { appendFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const record = event => appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + '\\n');
    if (${tty}) Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const originalFork = child.fork;
    child.fork = (...args) => {
      if (${JSON.stringify(mode)} !== 'allow') {
        record({ kind: 'fork-refused' });
        throw new Error('Fixture refused preview process');
      }
      const worker = originalFork(...args);
      record({ kind: 'fork', pid: worker.pid });
      return worker;
    };
    if (${JSON.stringify(mode)} === 'forbid') {
      const forbidden = () => { record({ kind: 'network-refused' }); throw new Error('Unexpected network or listener'); };
      globalThis.fetch = forbidden;
      for (const module of [http, https, net, tls])
        for (const name of ['request', 'get', 'connect', 'createConnection', 'createServer'])
          if (typeof module[name] === 'function') module[name] = forbidden;
    }
    syncBuiltinESMExports();
  `);
  const run = (args = []) => spawnSync(process.execPath, [CLI, "map", ".", "--no-execute", ...args], {
    cwd: root, encoding: "utf8", timeout: 10000,
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}`, NO_COLOR: "1", TERM: "dumb",
      SANNR_HOME: join(root, "home"), API_USAGE_LOG: join(root, "usage.jsonl"), API_EVIDENCE: join(root, "evidence") },
  });
  return { root, events, run, output: join(root, LAYOUT.mapOutput) };
}

function success(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

async function assertBrowserPreview(project, result) {
  success(result);
  const output = stripVTControlCharacters(result.stdout);
  const urls = output.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s]+/g) ?? [];
  assert.ok(urls.length > 0, "the receipt exposes a clickable HTTP URL");
  const response = await fetch(urls[0], { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/html\b/);
  assert.equal(await response.text(), readFileSync(project.output, "utf8"),
    "the browser receives the exact saved map after the CLI has exited");
  const workers = project.events().filter(event => event.kind === "fork");
  assert.equal(workers.length, 1, "one bounded preview worker serves the artifact");
  assert.doesNotThrow(() => process.kill(workers[0].pid, 0));
  assert.doesNotMatch(output, /Browser preview unavailable/);
}

test("AH-2 preview opt-in prints its worker pid and an executable stop command", async t => {
  const project = fixture(t, { tty: true });
  const result = project.run(["--preview"]);
  await assertBrowserPreview(project, result);
  const [{ pid }] = project.events().filter(event => event.kind === "fork");
  assert.match(result.stdout, new RegExp(`pid ${pid}\\b`));
  const stop = process.platform === "win32" ? `taskkill /PID ${pid} /T /F` : `kill ${pid}`;
  assert.ok(result.stdout.includes(`Stop: ${stop}`), "the receipt gives the worker's stop command");
});

test("map --preview enables the browser URL in piped, uncolored output", async t => {
  const project = fixture(t);
  const result = project.run(["--preview"]);
  await assertBrowserPreview(project, result);
  assert.doesNotMatch(result.stdout, /\x1b/);
});

for (const [name, options, args] of [
  ["piped map", {}, []],
  ["AH-2 interactive map without --preview", { tty: true }, []],
  ["interactive map --no-preview", { tty: true }, ["--no-preview"]],
  ["--no-preview takes precedence over --preview", { tty: true }, ["--preview", "--no-preview"]],
]) test(`${name} writes HTML without a listener or preview process`, t => {
  const project = fixture(t, { ...options, mode: "forbid" });
  const result = project.run(args);
  success(result);
  assert.match(readFileSync(project.output, "utf8"), /^<!doctype html>/i);
  assert.deepEqual(project.events(), [], "opting out must not attempt preview startup");
  assert.doesNotMatch(result.stdout, /http:\/\/127\.0\.0\.1:\d+\//);
  assert.doesNotMatch(result.stdout + result.stderr, /Browser preview unavailable/);
});

for (const format of ["--json", "--text"]) test(`map ${format} --preview remains listener and child free`, t => {
  const project = fixture(t, { tty: true, mode: "forbid" });
  const result = project.run([format, "--preview"]);
  success(result);
  if (format === "--json") assert.equal(JSON.parse(result.stdout).summary.operations, 1);
  else assert.match(result.stdout, /1 (?:documented )?operation/);
  assert.equal(existsSync(project.output), false);
  assert.deepEqual(project.events(), [], "machine/text output must bypass preview startup entirely");
  assert.doesNotMatch(result.stdout + result.stderr, /Browser preview unavailable/);
});

test("preview startup failure preserves the successful map and explains the file fallback", t => {
  const project = fixture(t, { tty: true, mode: "fail" });
  const result = project.run(["--preview"]);
  success(result);
  assert.match(readFileSync(project.output, "utf8"), /^<!doctype html>/i);
  assert.match(result.stdout + result.stderr, /Browser preview unavailable/);
  assert.ok(result.stdout.includes(project.output), "the saved artifact remains discoverable");
  assert.deepEqual(project.events(), [{ kind: "fork-refused" }]);
  assert.doesNotMatch(result.stdout, /http:\/\/127\.0\.0\.1:\d+\//);
});
