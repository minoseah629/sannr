import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { LAYOUT } from "../lib/layout.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,

} from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { POINTER_BEGIN, POINTER_END, PRODUCT } from "../lib/brand.mjs";
import { blockText } from "../lib/block-text.mjs";
import { start } from "./fixture-server.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");
const PORTABLE_CLI = `./node_modules/.bin/${PRODUCT}`;
const execFileAsync = promisify(execFile);

function invoke(cli, cwd, args, env = {}) {
  try {
    const out = execFileSync("node", [cli, ...args], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

async function invokeAsync(cli, cwd, args, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("node", [cli, ...args], {
      cwd, encoding: "utf8", env: { ...process.env, ...env },
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (error) {
    return { code: error.code ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function makeRepo(base, name, origin = "http://127.0.0.1:9") {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "openapi.yaml"), [
    "openapi: 3.0.0",
    "info: { title: Fixture, version: '1' }",
    "paths:",
    "  /json:",
    "    get:",
    "      responses: { '200': { description: ok } }",
    "",
  ].join("\n"));
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
    v: 1, default: "local", environments: { local: { baseUrl: origin } },
  }, null, 2));
  return dir;
}

function copyBareTool(to) {
  mkdirSync(to, { recursive: true });
  cpSync(join(ROOT, "bin"), join(to, "bin"), { recursive: true });
  cpSync(join(ROOT, "lib"), join(to, "lib"), { recursive: true });
  cpSync(join(ROOT, "package.json"), join(to, "package.json"));
  return join(to, "bin", "cli.mjs");
}

function installPortableShim(dir, cli, name = PRODUCT) {
  const path = join(dir, "node_modules", ".bin", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`);
  chmodSync(path, 0o755);
}

function blockIn(dir, name = "AGENTS.md", begin = POINTER_BEGIN, end = POINTER_END) {
  const text = readFileSync(join(dir, name), "utf8");
  const start = text.indexOf(begin);
  const finish = text.indexOf(end, start);
  assert.notEqual(start, -1, `${name} has no managed block`);
  assert.notEqual(finish, -1, `${name} has no managed block end`);
  return text.slice(start, finish + end.length);
}

function assertNoMachinePath(block) {
  let prose = block.replace(/`[A-Z]+ \/[^`]+`/g, "");
  const punctuation = { "25": "%", "2e": ".", "2f": "/", "3a": ":", "5c": "\\" };
  for (let pass = 0; pass < 2; pass += 1) prose = prose.replace(/%(?:25|2e|2f|3a|5c)/gi,
    (token) => punctuation[token.slice(1).toLowerCase()]);
  const chunks = [];
  const scheme = /\bhttps?:\/\//gi;
  let cursor = 0, match;
  while ((match = scheme.exec(prose))) {
    let quoteAt = match.index - 1;
    while (quoteAt >= 0 && /\s/.test(prose[quoteAt])) quoteAt -= 1;
    const possibleWrapper = prose[quoteAt];
    let precedingCodePoint = prose[quoteAt - 1] ?? "";
    const lastUnit = prose.charCodeAt(quoteAt - 1);
    const priorUnit = prose.charCodeAt(quoteAt - 2);
    if (lastUnit >= 0xdc00 && lastUnit <= 0xdfff
        && priorUnit >= 0xd800 && priorUnit <= 0xdbff)
      precedingCodePoint = prose.slice(quoteAt - 2, quoteAt);
    const wrapper = /["'`]/.test(possibleWrapper ?? "")
      && (quoteAt === 0 || !/^[\p{L}\p{N}\p{M}_]$/u.test(precedingCodePoint))
      ? possibleWrapper : undefined;
    let end = scheme.lastIndex, parentheses = 0, squareBrackets = 0, curlyBraces = 0;
    while (end < prose.length) {
      const character = prose[end];
      const code = character.charCodeAt(0);
      if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)
          || /\s/.test(character) || character === "<" || character === ">"
          || character === '"' || character === "`" || character === "\\"
          || character === "|" || (character === "'" && wrapper === "'")) break;
      if (character === "(") parentheses += 1;
      else if (character === ")") { if (!parentheses) break; parentheses -= 1; }
      else if (character === "[") squareBrackets += 1;
      else if (character === "]") { if (!squareBrackets) break; squareBrackets -= 1; }
      else if (character === "{") curlyBraces += 1;
      else if (character === "}") { if (!curlyBraces) break; curlyBraces -= 1; }
      end += 1;
    }
    chunks.push(prose.slice(cursor, match.index), " ");
    cursor = end;
    scheme.lastIndex = Math.max(end, scheme.lastIndex);
  }
  chunks.push(prose.slice(cursor));
  prose = chunks.join("");
  assert.doesNotMatch(prose,
    /(?:^|[^A-Za-z0-9_./-])\/+(?:\.\/)*(?:Users|home|private(?:\/tmp)?|tmp|Volumes|var\/folders)(?=$|[\/\s"'`<>()\[\]{}*_,;:!?.])/m,
    `pointer contains a POSIX machine-local path:\n${block}`);
  assert.doesNotMatch(prose, /(?:^|[^A-Za-z])[A-Za-z]:[\\/]/m,
    `pointer contains a drive-absolute path:\n${block}`);
  assert.doesNotMatch(prose,
    /(?:^|[^A-Za-z0-9_./-])(?:\\{2,}[^\\/\s]+(?=$|[\\/\s"'`<>()\[\]{}*_,;:!?.])|[\\/]{2,}[^\\/\s]+[\\/][^\\/\s]+)/m,
    `pointer contains a UNC path:\n${block}`);
  assert.doesNotMatch(prose, /\bfile:(?:[\\/]+|[A-Za-z]:[\\/]|%)/i,
    `pointer contains a local file URI:\n${block}`);
}

test("managed pointer commands are byte-identical across checkout path shapes", () => {
  const base = mkdtempSync(join(tmpdir(), "pointer-portability-"));
  const home = join(base, "home");
  mkdirSync(home);
  try {
    const shapes = [
      { tool: "POSIX checkout with spaces/tool", repo: "POSIX project with spaces" },
      { tool: ("C:" + "/" + "Users/Alice/Sannr checkout"), repo: ("D:" + "/Work/same-project") },
    ];
    const blocks = shapes.map(({ tool, repo }) => {
      const cli = copyBareTool(join(base, tool));
      const dir = makeRepo(base, repo);
      installPortableShim(dir, cli);
      const result = invoke(cli, dir, ["init", "--agents"], { HOME: home });
      assert.equal(result.code, 0, result.out);
      const block = blockIn(dir);
      assert.match(block, new RegExp(`\\./node_modules/\\.bin/${PRODUCT} map \\.`));
      assert.match(block, new RegExp(`\\./node_modules/\\.bin/${PRODUCT} learn`));
      assert.match(block, new RegExp(`\\./node_modules/\\.bin/${PRODUCT} unwire`));
      assertNoMachinePath(block);
      return block;
    });
    assert.equal(blocks[1], blocks[0],
      "the same logical context rendered differently under another checkout path shape");

    const renamedRepo = makeRepo(base, "quoted relative command");
    const renamedCli = copyBareTool(join(base, "tool for quoted command"));
    installPortableShim(renamedRepo, renamedCli, "sannr-tool");
    const renamed = invoke(renamedCli, renamedRepo,
      ["init", "--agents"], { HOME: home, API_CONTEXT_PRODUCT_NAME: "sannr-tool" });
    assert.equal(renamed.code, 0, renamed.out);
    const renamedBlock = blockIn(renamedRepo, "AGENTS.md",
      "<!-- sannr-tool:begin -->", "<!-- sannr-tool:end -->");
    assert.match(renamedBlock, /`\.\/node_modules\/\.bin\/sannr-tool map \.`/,
      "a portable relative command containing spaces is not quoted as one command word");
    assert.doesNotMatch(renamedBlock, /\\node_modules\\/,
      "committed command paths must keep forward slashes on every platform");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("cold, learned, refreshed, and recreated pointers describe current knowledge truthfully", async () => {
  const fixture = await start();
  const base = mkdtempSync(join(tmpdir(), "pointer-lifecycle-"));
  const home = join(base, "home");
  mkdirSync(home);
  const dir = makeRepo(base, "repo", fixture.origin);
  createFixtureStack(dir, { contract: "openapi.yaml", baseUrl: fixture.origin });
  writeFileSync(join(dir, "AGENTS.md"), "# Team rules\n\nBefore managed block.\n");
  writeFileSync(join(dir, "CLAUDE.md"), "# Claude rules\n\nBefore managed block.\n");
  try {
    const initialized = invoke(CLI, dir, ["init", "--agents"], { HOME: home });
    assert.equal(initialized.code, 0, initialized.out);
    const cold = blockIn(dir);
    assert.match(cold, /No current response, passing assertion or learn verification is counted/i,
      "cold inventory does not explain its current evidence state");
    assert.doesNotMatch(cold, /starts empty/i);
    assert.match(cold, /1 operation; 1 written, 0 observed, 0 asserted, 0 verified/);
    appendFileSync(join(dir, "AGENTS.md"), "\nAfter managed block.\n");
    appendFileSync(join(dir, "CLAUDE.md"), "\nAfter managed block.\n");

    const learned = await invokeAsync(CLI, dir, ["learn", "--env", "local", "--agents"],
      { HOME: home });
    assert.equal(learned.code, 0, learned.out);
    const learnedBlock = blockIn(dir);
    assert.match(learnedBlock, /1 operation; 0 written, 0 observed, 0 asserted, 1 verified/);
    assert.match(learnedBlock, /current committed knowledge/i);
    assert.doesNotMatch(learnedBlock, /starts empty|begins unverified/i);
    assert.match(learnedBlock, /promptly record[\s\S]*CLI fallback/);
    assert.doesNotMatch(learnedBlock, /api_context|snapshot\.state/,
      "learning does not register optional graph tools or their recording receipt");

    const initRefresh = invoke(CLI, dir, ["init", "--agents"], { HOME: home });
    assert.equal(initRefresh.code, 0, initRefresh.out);
    assert.equal(blockIn(dir), learnedBlock,
      "init refresh rendered a different lifecycle story for the same learned context");
    const connectRefresh = invoke(CLI, dir, ["connect", "--json"], { HOME: home });
    assert.equal(connectRefresh.code, 0, connectRefresh.out);
    const connectedBlock = blockIn(dir);
    const bindingId = JSON.parse(connectRefresh.out).setup.host.binding_id;
    assert.ok(bindingId, "connect did not record the new host binding");
    assert.ok(connectedBlock.includes(`Expected tool description marker: Setup binding: ${bindingId}`));
    assert.equal(connectedBlock.slice(connectedBlock.indexOf("## API workflow")),
      learnedBlock.slice(learnedBlock.indexOf("## API workflow")),
      "connect refresh changed the knowledge story while adding host setup identity");

    const beforeRefresh = ["AGENTS.md", "CLAUDE.md"].map((name) =>
      readFileSync(join(dir, name), "utf8"));
    const refreshed = await invokeAsync(CLI, dir, ["learn", "--env", "local", "--agents"],
      { HOME: home });
    assert.equal(refreshed.code, 0, refreshed.out);
    assert.deepEqual(["AGENTS.md", "CLAUDE.md"].map((name) =>
      readFileSync(join(dir, name), "utf8")), beforeRefresh,
    "repeated refresh changed an already-current pointer file");
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const text = readFileSync(join(dir, name), "utf8");
      assert.equal(text.split(POINTER_BEGIN).length - 1, 1, `${name} duplicated the managed block`);
      assert.match(text, /Before managed block\./);
      assert.match(text, /After managed block\./);
    }

    rmSync(join(dir, "CLAUDE.md"));
    const recreated = await invokeAsync(CLI, dir, ["learn", "--env", "local"], { HOME: home });
    assert.equal(recreated.code, 0, recreated.out);
    assert.deepEqual(JSON.parse(recreated.out).pointers_written,
      [{ file: "CLAUDE.md", action: "created" }]);
    assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "@AGENTS.md\n",
      "a missing Claude file is recreated as an import of the canonical instructions");
    assert.equal(blockIn(dir, "AGENTS.md"), connectedBlock,
      "recreating the bridge must retain the learned canonical knowledge");

    // R6 registrations no longer pin one stack config. A stack-only change
    // keeps the same host binding; request-time resolution reads the stack.
    appendFileSync(join(dir, LAYOUT.collection, "fixture", "stack.json"), "\n");
    const staleRefresh = invoke(CLI, dir, ["init", "--agents"], { HOME: home });
    assert.equal(staleRefresh.code, 0, staleRefresh.out);
    assert.ok(blockIn(dir).includes(`Expected tool description marker: Setup binding: ${bindingId}`));
    assert.match(blockIn(dir), /1 operation; 0 written, 0 observed, 0 asserted, 1 verified/);
    const repaired = invoke(CLI, dir, ["connect", "--json"], { HOME: home });
    assert.equal(repaired.code, 0, repaired.out);
    const currentBinding = JSON.parse(repaired.out).setup.host.binding_id;
    assert.equal(currentBinding, bindingId);
    assert.ok(blockIn(dir).includes(`Expected tool description marker: Setup binding: ${currentBinding}`));
  } finally {
    await fixture.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test("unsafe machine-local gotchas stay verbatim in knowledge but not in managed prose", () => {
  const base = mkdtempSync(join(tmpdir(), "pointer-gotchas-"));
  const home = join(base, "home");
  mkdirSync(home);
  const dir = makeRepo(base, "repo");
  createFixtureStack(dir, { contract: "openapi.yaml" });
  const unsafe = [
    ("Read /" + "Users/Alice/workspace/config.yaml before calling this route."),
    ("The symlink resolved to /" + ("private/tmp" + "/sannr-fixture/config.yaml.")),
    ("Windows stores it at C:" + "\\Users\\Alice\\workspace\\config.yaml."),
    ("The alternate Windows spelling is C:" + "/" + "Users/Alice/workspace/config.yaml."),
    ("The shared copy was at \\\\" + "MACHINE\\Share\\workspace\\config.yaml."),
    "Exact local roots are unsafe too: /Users",
    "This exact Unix root is local: /home",
    "This exact temporary root is local: /tmp",
    "This exact volume root is local: /Volumes",
    "This exact runtime root is local: /var/folders",
    ("A local file URI is still machine-specific: file:///" + "Users/Alice/x"),
    ("Markdown emphasis must not hide **/" + "Users/Alice/x**."),
    ("Angle wrappers must not hide <C:" + "\\Users\\Alice\\x>."),
    ("Lowercase forward drives remain local: [c:" + "/" + "users/alice/x]."),
    ("Parentheses must not hide (\\\\" + "MACHINE\\Share\\x)."),
    ("Backticks must not hide `/" + "home/Alice/x`."),
    (("Extended drives remain local: \\\\" + "?\\C:") + "\\Users\\Alice\\x."),
    ("Device UNC remains local: \\\\" + "?\\UNC\\MACHINE\\Share\\x."),
    ("A one-slash local URI is unsafe: file:/" + "Users/Alice/x"),
    "Encoded local URI separators are unsafe: file:%2F%2F%2FUsers%2FAlice%2Fx",
    ("An exact UNC host root is unsafe: \\\\" + "server"),
    ("A colon prefix must not hide a drive: path:C:" + "\\Users\\Alice\\x"),
    ("A colon prefix must not hide POSIX: path:/" + "Users/Alice/x"),
    ("Redundant leading separators stay local: ///" + "Users/Alice/x"),
    ("Dot segments stay local: /./" + "Users/Alice/x"),
    ("A Markdown-link suffix is separate local prose: [docs](https://api.example.test/docs)/" + "tmp/x"),
    ("An autolink suffix is separate local prose: <https://api.example.test/docs>/" + "Users/Alice/x"),
    "Malformed local URI encoding is unsafe and must not throw: file:%2G%2FUsers%2FAlice/x",
    "Encoded backslash separators are unsafe: file:%5C%5Cserver%5Cshare%5Cx",
    ("Canonical localhost file URI is local: file://localhost/" + "Users/Alice/x"),
    ("A titled Markdown-link suffix is local: [docs](https://api.example.test/docs \"safe title\")/" + "tmp/x"),
    ("Mixed separators stay local: path:c:" + ("/Users\\Alice/x and \\\\" + "server/share/x")),
    "Double-encoded POSIX stays local: %252FUsers%252FAlice%252Fx",
    "Double-encoded drive stays local: C%253A%255CUsers%255CAlice%255Cx",
    "Double-encoded UNC stays local: %255C%255Cserver%255Cshare",
    ('A quoted URL suffix is local: "https://api.example/docs"/' + 'tmp/x'),
    ("A backticked URL suffix is local: `https://api.example/docs`/" + "Users/Alice/x"),
    ("A bracketed URL suffix is local: [https://api.example/docs]/" + "tmp/x"),
    ("A C0-delimited URL suffix is local: https://api.example/docs\u0001/" + "tmp/x"),
    ("An apostrophe-delimited URL suffix is local: 'https://api.example/docs'/" + "tmp/x"),
    ("A curly-wrapped URL suffix is local: {https://api.example/docs}/" + "Users/Alice/x"),
    ("A DEL-delimited URL suffix is local: https://api.example/docs\u007f/" + "tmp/x"),
    ("A C1-delimited URL suffix is local: https://api.example/docs\u0085/" + "Users/Alice/x"),
    ("A raw-backslash URL suffix is local: https://api.example/docs\\C:" + "\\Users\\Alice\\x"),
    ("A pipe URL suffix is local: https://api.example/docs|/" + "tmp/x"),
    ("A spaced apostrophe wrapper suffix is local: ' https://api.example/docs'/" + "tmp/x"),
    ("A newline apostrophe wrapper suffix is local: '\nhttps://api.example/docs'/" + "Users/Alice/x"),
    ("A colon-prefixed wrapper suffix is local: colon prefix:' https://api.example/docs'/" + "tmp/colon"),
    ("An equals-prefixed wrapper suffix is local: equals prefix=' https://api.example/docs'/" + "Users/Alice/eq"),
    ("A comma-prefixed wrapper suffix is local: comma prefix,' https://api.example/docs'/" + "home/comma"),
    ("A semicolon-prefixed wrapper suffix is local: semicolon prefix;' https://api.example/docs'/" + ("private/tmp" + "/semicolon")),
    ("A dot-prefixed wrapper suffix is local: dot prefix.' https://api.example/docs'/" + "Volumes/dot"),
    ("A hyphen-prefixed wrapper suffix is local: hyphen prefix-' https://api.example/docs'/" + "var/folders/hyphen"),
    ("An exclamation-prefixed wrapper suffix is local: bang prefix!' https://api.example/docs'/" + "tmp/bang"),
    ("A question-prefixed wrapper suffix is local: question prefix?' https://api.example/docs'/" + "Users/Alice/question"),
    ("A slash-prefixed wrapper suffix is local: slash prefix/' https://api.example/docs'/" + "home/slash"),
    ("A pipe-prefixed wrapper suffix is local: pipe prefix|' https://api.example/docs'/" + ("private/tmp" + "/pipe")),
  ];
  assert.equal(unsafe.length, 57, "the exact N4 unsafe-note matrix changed silently");
  const longSafeUrl = `Long URL remains safe: https://api.example/${"a".repeat(4096)}${'/' + 'Users'}/Alice/x`;
  const safeNotes = [
    ("Literal and paired URLs remain safe: https://api.example.com/" + "Users/Alice/" + ("private/tmp" + "/v1, http://api.example.test/") + "tmp/x, https://api.example/a'/" + "Users/Alice/x, https://host.test/a(b)/" + "Users/Alice/x, and https://host.test/docs?q=(/" + "Users/Alice/x)#next=(/" + "tmp/x)."),
    ("URL query, Markdown, autolink, and IPv6 forms stay safe: https://host.test:8443/docs?next=/" + "tmp/x#source=/" + "Volumes/x [docs](https://host.test/a(b)/" + "Users/Alice/x) <https://host.test/a(b)/" + "Users/Alice/x> https://[::1]/" + "Users/Alice/x."),
    ("Encoded, malformed, and ordinary prose stay safe: https:%2F%2Fhost.test%2FUsers%2FAlice%2Fx http%3A%2F%2Fhost.test%2Ftmp%2Fx https://host.test/%ZZ/" + "Users/Alice/x //TODO file: config.yaml file:docs/readme /json /api/v1/items config/config.yaml."),
    ('Wrapper-only URLs stay safe: "https://api.example/' + 'Users/Alice/x" \'https://api.example/' + 'Users/Alice/x\' `https://api.example/' + 'tmp/x` [https://api.example/' + 'Volumes/x] {https://api.example/' + 'tmp/x}.'),
    ("Possessives and contractions stay safe: agents' https://host.test/a'/" + "Users/Alice/x and don't hide https://host.test/b'/" + "tmp/x."),
    ("Identifier quote boundaries stay safe: agent_'\thttps://host.test/i'/" + "home/x and ٣' https://host.test/n'/" + "tmp/x."),
    ("NFD possessive stays safe: cafe\u0301' https://host.test/d'/" + "Users/Alice/in-url"),
    ("Devanagari possessive stays safe: कै' https://host.test/dev'/" + "tmp/in-url"),
    ("Astral-letter possessive stays safe: 𐐀' https://host.test/l'/" + "Users/Alice/in-url"),
    ("Astral-number possessive stays safe: 𝟘' https://host.test/n'/" + "tmp/in-url"),
    ("Unicode possessives and contractions stay safe: café' https://host.test/u'/" + "Users/Alice/x, l'été https://host.test/v'/" + "tmp/x, and a\u20dd' https://host.test/e'/" + "home/x."),
    ("Spaced wrappers stay safe: '  https://api.example/" + "Users/Alice/x' \"\thttps://api.example/" + "tmp/x\" `\r\nhttps://api.example/" + "Volumes/x`."),
    longSafeUrl,
  ];
  const safeOperations = [
    ["GET /health/:id", "A safe operation-ID note about pagination and /api/v1/items."],
    [("GET /" + "users/:id"), "A safe operation-ID note about the response schema."],
  ];
  try {
    assert.equal(invoke(CLI, dir, ["init"], { HOME: home }).code, 0);
    for (const note of [...unsafe, ...safeNotes]) {
      const result = invoke(CLI, dir, ["note", "GET /json", note, "--alongside"], { HOME: home });
      assert.equal(result.code, 0, result.out);
    }
    for (const [operation, note] of safeOperations) {
      const result = invoke(CLI, dir, ["note", operation, note], { HOME: home });
      assert.equal(result.code, 0, result.out);
    }
    const wired = invoke(CLI, dir, ["init", "--agents"], { HOME: home });
    assert.equal(wired.code, 0, wired.out);

    const context = JSON.parse(readFileSync(fixtureContextFile(dir), "utf8"));
    assert.deepEqual(context.operations["GET /json"].notes, [...unsafe, ...safeNotes],
      "renderer safety rewrote the source-of-truth note text");
    const shown = JSON.parse(invoke(CLI, dir, ["show", "GET /json"], { HOME: home }).out);
    assert.deepEqual(shown.notes, [...unsafe, ...safeNotes], "show did not preserve literal note text");
    for (const [operation, note] of safeOperations)
      assert.deepEqual(context.operations[operation].notes, [note],
        `${operation} was not preserved as structured operation identity`);

    const block = blockIn(dir);
    for (const note of unsafe) assert.ok(!block.includes(note), `unsafe gotcha leaked: ${note}`);
    // Safe prose reaches the block flattened to one line (control characters
    // become spaces, comment markup is made visible): a newline inside a note
    // is the heading injection lib/block-text.mjs exists to remove. The
    // knowledge file keeps the literal text; the block carries its safe form.
    for (const note of safeNotes)
      assert.ok(block.includes(blockText(note)), `safe prose was mistaken for a machine path: ${note}`);
    for (const [operation, note] of safeOperations) {
      assert.ok(block.includes(`- \`${operation}\` — ${note}`),
        `safe structured operation ID was redacted: ${operation}`);
    }
    assert.match(block, new RegExp(`${unsafe.length} gotchas? omitted[^.]*machine-local`, "i"),
      "unsafe gotchas were silently dropped instead of counted for the reader");
    assertNoMachinePath(block);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("delimiter-owned pre-AX pointer blocks upgrade and unwire without touching neighbouring text", () => {
  const base = mkdtempSync(join(tmpdir(), "pointer-legacy-"));
  const home = join(base, "home");
  mkdirSync(home);
  const dir = makeRepo(base, "repo");
  const legacy = `${POINTER_BEGIN}\nnode ${'/' + 'Users'}/Alice/tool/bin/cli.mjs learn\n` +
    ("C:" + ("\\Users\\Alice\\tool\\bin\\cli.mjs\n\\\\" + "MACHINE\\Share\\tool\\cli.mjs\n")) +
    `${POINTER_END}`;
  try {
    assert.equal(invoke(CLI, dir, ["init"], { HOME: home }).code, 0);
    for (const name of ["AGENTS.md", "CLAUDE.md"])
      writeFileSync(join(dir, name), `Before ${name}.\n\n${legacy}\n\nAfter ${name}.\n`);
    const refreshed = invoke(CLI, dir, ["init", "--agents"], { HOME: home });
    assert.equal(refreshed.code, 0, refreshed.out);
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const text = readFileSync(join(dir, name), "utf8");
      assert.match(text, new RegExp(`Before ${name}\\.`));
      assert.match(text, new RegExp(`After ${name}\\.`));
      assert.equal(text.split(POINTER_BEGIN).length - 1, 1);
      assertNoMachinePath(text);
      assert.doesNotMatch(blockIn(dir, name), /pointer-v1|sha256=/,
        "AX-B added an ownership line beyond its one verb-owning line");
    }
    const unwired = invoke(CLI, dir, ["unwire", "--json"], { HOME: home });
    assert.equal(unwired.code, 0, unwired.out);
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const text = readFileSync(join(dir, name), "utf8");
      assert.match(text, new RegExp(`Before ${name}\\.`));
      assert.match(text, new RegExp(`After ${name}\\.`));
      assert.doesNotMatch(text, new RegExp(POINTER_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("no-context setup leaves continuation guidance while learning still needs a real contract", () => {
  const base = mkdtempSync(join(tmpdir(), "pointer-no-context-"));
  const home = join(base, "home");
  mkdirSync(home);
  const dir = makeRepo(base, "repo");
  rmSync(join(dir, "openapi.yaml"));
  try {
    const connected = invoke(CLI, dir, ["connect", "--json"], { HOME: home });
    assert.equal(connected.code, 0, connected.out);
    assert.match(JSON.parse(connected.out).context, /^skipped/);
    assert.ok(!existsSync(join(dir, LAYOUT.context)), "connect must not fabricate API knowledge");
    const guidance = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.match(guidance, /Finish .* setup/);
    assert.match(guidance, /api_request/);
    assert.ok(guidance.includes(`no \`${LAYOUT.context}\` yet`));
    assert.doesNotMatch(guidance, /API knowledge for this service is in/);
    assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
    const learned = invoke(CLI, dir, ["learn"], { HOME: home });
    assert.notEqual(learned.code, 0);
    assert.match(learned.out, /STACKS_MIGRATION_REQUIRED/);
    assert.match(learned.out, /migrate --dry-run/);
    const initialized = invoke(CLI, dir, ["init"], { HOME: home });
    assert.notEqual(initialized.code, 0);
    assert.match(initialized.out, /CONTRACT_NOT_FOUND/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
