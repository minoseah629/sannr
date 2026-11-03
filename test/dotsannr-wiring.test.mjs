import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PRODUCT, COLLECTION, HOME_ENV_NAME, SKILL_NAMES, FEEDBACK_ORIGIN } from "../lib/brand.mjs";
import { planSkills, planSkillRemoval, writeText, credentialReport } from "../lib/connect.mjs";
import { emptyContext, saveContext } from "../lib/context.mjs";
import { renderCiWorkflow, inspectCiWorkflowOwnership } from "../lib/ci-workflow.mjs";

function project(t) {
  const root = mkdtempSync(join(tmpdir(), "dots-wiring-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("DOTSANNR-W1: canonical skills and every host use three seam-derived names", (t) => {
  const root = project(t);
  const rows = planSkills(root);
  const names = ["request", "write", "feedback"].map(role => `${PRODUCT}-${role}`);
  for (const host of ["project", "claude-code", "codex"])
    assert.deepEqual(rows.filter(row => row.host === host).map(row => row.name), names);
  for (const row of rows) {
    assert.match(row.body, new RegExp(`^name: ${row.name}$`, "m"));
    assert.ok(!row.body.includes(root), "committed skill has no project machine path");
    assert.ok(row.body.includes(`.${PRODUCT}/`), "skill traces to the committed product directory");
  }
});

test("DOTSANNR-W2: canonical skill edits are copied to new host installs", (t) => {
  const root = project(t);
  const original = planSkills(root);
  const canonical = original.find(row => row.host === "project" && row.name === `${PRODUCT}-request`);
  assert.ok(canonical, "canonical skill must exist in the plan");
  const edited = `${canonical.body}\nOur team requires explicit scope in every note.\n`;
  writeText(canonical.to, edited, root);
  const next = planSkills(root);
  for (const row of next.filter(row => row.name === canonical.name))
    assert.equal(row.body, edited, "host copies come from canonical skill");
});

test("DOTSANNR-W3: unwire recognizes exact legacy skill names but preserves edits", (t) => {
  const root = project(t);
  const rows = planSkills(root, { alpha: true });
  for (const row of rows.filter(row => row.host === "claude-code")) {
    const role = row.name.endsWith("-request") || row.name === "api-request" ? "request"
      : row.name.endsWith("-write") ? "write" : "feedback";
    if (role === "feedback") continue;
    const name = role === "request" ? "api-request" : "write-context";
    const dir = join(root, ".claude", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), row.body.replace(/^name: .+$/m, `name: ${name}`));
  }
  const removal = planSkillRemoval(root);
  for (const name of ["api-request", "write-context"])
    assert.equal(removal.find(row => row.host === "claude-code" && row.name === name)?.action, "removed");
  const edited = join(root, ".claude", "skills", "api-request", "SKILL.md");
  writeFileSync(edited, `${readFileSync(edited, "utf8")}\nTeam-owned edit.\n`);
  assert.equal(planSkillRemoval(root).find(row => row.to === edited)?.action, "left");
});

test("DOTSANNR-W4: generated CI ownership retains the committed layout trail", () => {
  const workflow = renderCiWorkflow({ install: "registry", version: "1.2.3" });
  assert.ok(workflow.includes(`.${PRODUCT}/`), "consumer workflow names the layout");
  assert.equal(inspectCiWorkflowOwnership(workflow).owned, true);
});


test("DOTSANNR-W5: credential inspection shares the relocated config's project-relative envFile base", async (t) => {
  const root = project(t);
  const { LAYOUT } = await import("../lib/layout.mjs");
  writeText(join(root, LAYOUT.environments), JSON.stringify({
    default: "local", environments: { local: { auth: "bearer:TEAM_TOKEN", envFile: "team.env" } },
  }), root);
  writeText(join(root, "team.env"), "TEAM_TOKEN=fixture-only\n", root);
  assert.equal(credentialReport(join(root, LAYOUT.environments), { env: {} })[0].state, "envFile");
});


test("DOTSANNR-W6: collection-only rename migrates the exact prior CI workflow", (t) => {
  const root = project(t);
  const file = join(root, "workflow.txt");
  writeText(file, renderCiWorkflow({ install: "registry", version: "1.2.3" }), root);
  const module = new URL("../lib/ci-workflow.mjs", import.meta.url).href;
  const layout = new URL("../lib/layout.mjs", import.meta.url).href;
  const code = `import {readFileSync} from 'node:fs'; import {migrateCiWorkflowText,inspectCiWorkflowOwnership} from ${JSON.stringify(module)}; import {LAYOUT} from ${JSON.stringify(layout)};
    const migrated=migrateCiWorkflowText(readFileSync(process.argv[1],'utf8'),{priorLayouts:[{product:process.argv[2],collection:process.argv[3]}]});
    console.log(JSON.stringify({rewritten:typeof migrated==='string',currentTrail:migrated?.includes(LAYOUT.context),owned:migrated?inspectCiWorkflowOwnership(migrated).owned:false}));`;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code, file, PRODUCT, COLLECTION], {
    encoding: "utf8", env: { ...process.env, API_CONTEXT_COLLECTION_NAME: "qa-renamed-collection" },
  }));
  assert.deepEqual(result, { rewritten: true, currentTrail: true, owned: true });
});

test("DOTSANNR-W7: commandless skill rendering follows a renamed product without editing templates", () => {
  const module = new URL("../lib/connect.mjs", import.meta.url).href;
  const code = `import {SKILL_SOURCES,renderSkill} from ${JSON.stringify(module)}; console.log(JSON.stringify(SKILL_SOURCES.map(source=>renderSkill(source,null))));`;
  const renamed = "qa-renamed-product";
  const bodies = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8", env: { ...process.env, API_CONTEXT_PRODUCT_NAME: renamed }, stdio: ["ignore", "pipe", "pipe"],
  }));
  assert.equal(bodies.length, 3);
  for (const body of bodies) {
    assert.ok(body.includes(`name: ${renamed}-`));
    // Cosmetic product renaming cannot alter the pinned send destination.
    assert.ok(!body.replaceAll(FEEDBACK_ORIGIN, '<pinned-feedback-origin>').toLowerCase().includes(PRODUCT.toLowerCase()));
    if (body.includes('feedback.send')) {
      assert.ok(body.includes(`${FEEDBACK_ORIGIN}/api/v1/feedback`));
      assert.ok(body.includes('QA_RENAMED_PRODUCT_FEEDBACK_SEND=never'));
    }
  }
});

test("DOTSANNR-W8: migration plans update canonical and host skills through both rename seams", (t) => {
  const root = project(t);
  for (const row of planSkills(root, { cliName: null })) writeText(row.to, row.body, root);
  const module = new URL("../lib/connect.mjs", import.meta.url).href;
  const code = `import {migrateSkillPlans} from ${JSON.stringify(module)};
    const rows=migrateSkillPlans(process.argv[1],{previousLayouts:[{product:process.argv[2],collection:process.argv[3]}]});
    console.log(JSON.stringify(rows.map(({body,...row})=>({...row,bodyHasNewName:body?.includes('name: qa-renamed-product-'),bodyHasOldCollection:body?.includes('/'+process.argv[3]+'/'),bodyHasNewSendEnv:body?.includes('QA_RENAMED_PRODUCT_FEEDBACK_SEND=never'),bodyHasPinnedEndpoint:body?.includes(${JSON.stringify(`${FEEDBACK_ORIGIN}/api/v1/feedback`)})}))));`;
  const rows = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code, root, PRODUCT, COLLECTION], {
    encoding: "utf8", env: { ...process.env, API_CONTEXT_PRODUCT_NAME: "qa-renamed-product", API_CONTEXT_COLLECTION_NAME: "qa-renamed-collection" }, stdio: ["ignore", "pipe", "pipe"],
  }));
  assert.equal(rows.length, 9);
  assert.ok(rows.every(row => row.action === "moved" && row.bodyHasNewName && !row.bodyHasOldCollection), JSON.stringify(rows));
  const feedback = rows.filter(row => row.name.endsWith('-feedback'));
  assert.equal(feedback.length, 3);
  assert.ok(feedback.every(row => row.bodyHasNewSendEnv && row.bodyHasPinnedEndpoint));
  // A user's changed destination remains an edit. Only the generated policy
  // variable follows the rename; this must not broaden ownership to new URLs.
  for (const row of feedback) writeFileSync(row.from,readFileSync(row.from,'utf8').replace(FEEDBACK_ORIGIN,'https://changed.example.test'));
  const edited=JSON.parse(execFileSync(process.execPath,["--input-type=module","-e",code,root,PRODUCT,COLLECTION],{
    encoding:'utf8',env:{...process.env,API_CONTEXT_PRODUCT_NAME:'qa-renamed-product',API_CONTEXT_COLLECTION_NAME:'qa-renamed-collection'},stdio:['ignore','pipe','pipe'],
  }));
  assert.ok(edited.filter(row=>row.name.endsWith('-feedback')).every(row=>row.action==='conflict'));
});


test("DOTSANNR-W9: an unwritable old skill directory refuses rename before moving any knowledge", { skip: process.platform === "win32" ? "POSIX directory permission specimen" : false }, async (t) => {
  const root = project(t), cli = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));
  const { LAYOUT, layoutFor } = await import("../lib/layout.mjs");
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("API_"))),
    API_USAGE_LOG: "", [HOME_ENV_NAME]: join(root, "private-home") };
  execFileSync("git", ["init", "-q"], {cwd:root});
  writeText(join(root, "openapi.json"), JSON.stringify({openapi:"3.0.0",info:{title:"Fixture",version:"1"},paths:{"/health":{get:{responses:{200:{description:"ok"}}}}}}), root);
  // STACKS-1A: these permission specimens migrate the existing single-store
  // layout, rather than creating a new per-stack installation.
  saveContext(root, emptyContext({ name: "Fixture", contractPath: "openapi.json" }));
  execFileSync(process.execPath, [cli, "start", "--json"], {cwd:root,env,stdio:["ignore","pipe","pipe"]});
  const before = readFileSync(join(root, LAYOUT.context));
  const oldDir = join(root, ".claude", "skills", SKILL_NAMES.request);
  chmodSync(oldDir, 0o500);
  try {
    const next = layoutFor("qa-review-product", "qa-review-collection");
    const result = spawnSync(process.execPath, [cli, "migrate", "--json"], {cwd:root,encoding:"utf8",env:{...env,API_CONTEXT_PRODUCT_NAME:"qa-review-product",API_CONTEXT_COLLECTION_NAME:"qa-review-collection"}});
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /MIGRATION_CONFLICT/);
    assert.doesNotMatch(result.stdout + result.stderr, /\n\s+at /);
    assert.deepEqual(readFileSync(join(root, LAYOUT.context)), before);
    assert.equal(existsSync(join(root, next.context)), false);
    assert.equal(existsSync(join(root, ".claude", "skills", "qa-review-product-request")), false);
    assert.equal(existsSync(join(oldDir, "SKILL.md")), true);
  } finally { chmodSync(oldDir, 0o700); }
});

for (const boundary of ["moved source parent", "moved destination", "generated metadata", "old metadata cleanup"])
  test(`DOTSANNR-W10: migration preflights ${boundary} before any core move`, { skip: process.platform === "win32" ? "POSIX directory permission specimen" : false }, async (t) => {
    const root = project(t), cli = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));
    const { LAYOUT, layoutFor } = await import("../lib/layout.mjs");
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("API_"))),
      API_USAGE_LOG: "", [HOME_ENV_NAME]: join(root, "private-home") };
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeText(join(root, "openapi.json"), JSON.stringify({openapi:"3.0.0",info:{title:"Fixture",version:"1"},paths:{"/health":{get:{responses:{200:{description:"ok"}}}}}}), root);
    // STACKS-1A: these permission specimens migrate the existing single-store
    // layout, rather than creating a new per-stack installation.
    saveContext(root, emptyContext({ name: "Fixture", contractPath: "openapi.json" }));
    execFileSync(process.execPath, [cli, "start", "--json"], {cwd:root,env,stdio:["ignore","pipe","pipe"]});
    const product = boundary === "generated metadata" ? PRODUCT : "qa-permission-product";
    const next = layoutFor(product, "qa-permission-collection");
    let protectedDir;
    if (boundary === "moved source parent") protectedDir = join(root, LAYOUT.collection);
    else if (boundary === "moved destination") {
      protectedDir = join(root, next.collection); mkdirSync(protectedDir, {recursive:true});
    } else if (boundary === "generated metadata") {
      mkdirSync(join(root, next.collection)); protectedDir = join(root, LAYOUT.directory);
    } else {
      // Isolate cleanup authority: every moved artifact has a writable deeper
      // parent, while only the obsolete guide/marker remain in this directory.
      rmSync(join(root, LAYOUT.gitignore)); protectedDir = join(root, LAYOUT.directory);
    }
    const originalFiles = [LAYOUT.context, LAYOUT.readme, LAYOUT.marker, "AGENTS.md", "CLAUDE.md",
      join(LAYOUT.skills, SKILL_NAMES.request, "SKILL.md")];
    const before = new Map(originalFiles.map(path => [path, readFileSync(join(root, path))]));
    chmodSync(protectedDir, 0o500);
    try {
      const result = spawnSync(process.execPath, [cli, "migrate", "--json"], {cwd:root,encoding:"utf8",env:{...env,API_CONTEXT_PRODUCT_NAME:product,API_CONTEXT_COLLECTION_NAME:"qa-permission-collection"}});
      assert.equal(result.status, 1);
      assert.match(result.stdout + result.stderr, /MIGRATION_CONFLICT/);
      assert.doesNotMatch(result.stdout + result.stderr, /\n\s+at /);
      for (const [path, bytes] of before) assert.deepEqual(readFileSync(join(root,path)), bytes, path);
      assert.equal(existsSync(join(root, next.context)), false);
    } finally { chmodSync(protectedDir, 0o700); }
  });
