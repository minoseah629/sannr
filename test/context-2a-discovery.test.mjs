import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOME_ENV_NAME } from '../lib/brand.mjs';
import { CONTRACT_CANDIDATES } from '../lib/setup-contract.mjs';

const cli = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const contract = JSON.stringify({ openapi:'3.0.3', info:{title:'Synthetic inventory',version:'1'},
  paths:{ '/fixture':{get:{responses:{'200':{description:'ok'}}}} } });
const unsupported = {
  Starlette: 'routes = [Route("/items", items, methods=["GET"]), Route("/things", things, methods=["GET"])]',
  Django: 'urlpatterns = [path("items/", items), path("things/", things)]',
  aiohttp: 'app.router.add_get("/items", items)\napp.router.add_get("/things", things)',
  Falcon: 'app.add_route("/items", Items())\napp.add_route("/things", Things())',
  Litestar: '@get("/items")\nasync def items(): pass\n@get("/things")\nasync def things(): pass',
  ASGI: 'async def app(scope, receive, send):\n  if scope["path"] == "/items": pass\n  if scope["path"] == "/things": pass',
};

function fixture(t, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'discovery-guidance-')), root = join(dir, 'repo'), home = join(dir, 'home');
  mkdirSync(root); mkdirSync(home);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  const guard=join(dir,'no-network.mjs'), networkAttempt=join(dir,'network-attempt');
  writeFileSync(guard, `import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import {writeFileSync} from 'node:fs';
    const refuse=()=>{writeFileSync(${JSON.stringify(networkAttempt)},'attempted');throw new Error('Static discovery must not use network I/O');};
    globalThis.fetch=refuse; http.request=http.get=https.request=https.get=refuse; net.Socket.prototype.connect=refuse;`);
  t.after(() => { try { assert.equal(existsSync(networkAttempt),false,'Static inventory attempted network I/O'); }
    finally { rmSync(dir, {recursive:true,force:true}); } });
  const env = { PATH:process.env.PATH, HOME:home, [HOME_ENV_NAME]:join(dir,'machine'),
    API_CONTEXT_DIR:root, API_USAGE_LOG:join(dir,'usage.jsonl'), API_FRICTION_OFF:'1', NO_COLOR:'1',
    NODE_OPTIONS:`--import ${pathToFileURL(guard).href}` };
  async function run(args, overrides = {}) {
    const child = spawn(process.execPath, [cli, ...args], {cwd:root,env:{...env,...overrides},stdio:['ignore','pipe','pipe']});
    let out='', err=''; child.stdout.on('data', chunk => out+=chunk); child.stderr.on('data', chunk => err+=chunk);
    const [code] = await once(child,'close');
    return {code,out,err,result:JSON.parse(out.trim() || err.trim())};
  }
  return {root,run};
}

function teaches(next) {
  for (const name of CONTRACT_CANDIDATES) assert.ok(next.includes(name), `Missing contract filename: ${name}`);
  for (const style of ['app','router','blueprint','Express','Hono','Fastify','Next','Nest','Spring'])
    assert.ok(next.includes(style), `Missing route-style explanation: ${style}`);
  for (const style of ['Starlette','Django','urlpatterns','aiohttp','Falcon','Litestar','ASGI'])
    assert.ok(next.includes(style), `Missing unsupported style: ${style}`);
  assert.match(next, /save.*app.*OpenAPI.*openapi\.json/i);
  assert.match(next, /API_CONTRACT/);
  assert.match(next, /docs\/discovery\.md/);
  assert.ok(Buffer.byteLength(next) <= 1024, 'Discovery guidance must fit the existing terminal line budget');
}

for (const command of ['map','audit']) test(`CONTEXT-2a empty ${command} teaches the current source scan without adding unsupported Python discovery`, async t => {
  for (const [style, source] of Object.entries(unsupported)) await t.test(style, async t => {
    const f = fixture(t, {'app.py':source});
    const result = await f.run([command,'.','--json','--no-execute']);
    assert.equal(result.code,1); assert.equal(result.result.error.code,'NO_API_FOUND');
    const next = result.result.error.next; teaches(next);
    assert.match(next,/openapi\*/i); assert.match(next,/swagger\*/i);
    assert.match(next,/outbound API calls/i);
    assert.equal(existsSync(join(f.root,'.sannr')),false,'An empty source scan must not initialize a project');
  });
});

test('CONTEXT-2a empty init explains its contract-only search, not a source scan', async t => {
  const f = fixture(t, {'app.py':'@app.get("/one")\ndef one(): pass\n@router.post("/two")\ndef two(): pass'});
  const result = await f.run(['init']);
  assert.equal(result.code,1); assert.equal(result.result.error.code,'CONTRACT_NOT_FOUND');
  const next = result.result.error.next; teaches(next);
  assert.match(next,/contract-only/i); assert.match(next,/does not scan (?:source|routes)/i);
  assert.equal(existsSync(join(f.root,'.sannr')),false);
});

test('CONTEXT-2a explicit contract selections never fall back to a discoverable document', async t => {
  for (const selector of ['API_CONTRACT','configured','--contract']) await t.test(selector, async t => {
    const f=fixture(t, {'openapi.json':contract});
    if (selector === 'configured') writeFileSync(join(f.root,'selected-environment.json'), JSON.stringify({v:1,default:'local',environments:{local:{contract:'missing.json'}}}));
    const result=await f.run(['init', ...(selector === '--contract' ? ['--contract','missing.json'] : [])],
      selector === 'API_CONTRACT' ? {API_CONTRACT:'missing.json'}
        : selector === 'configured' ? {API_CONFIG:join(f.root,'selected-environment.json')} : {});
    assert.equal(result.code,1); assert.match(result.result.error.message,/missing\.json/);
    assert.doesNotMatch(result.result.error.next,/Looked for:|Contract-only search:/);
    assert.equal(existsSync(join(f.root,'.sannr')),false);
  });
});

test('CONTEXT-2a a stack without a contract does not claim conventional filenames were searched', async t => {
  const f=fixture(t, {'openapi.json':contract});
  const folder=join(f.root,'.sannr','stacks','fixture'); mkdirSync(folder,{recursive:true});
  writeFileSync(join(folder,'stack.json'),JSON.stringify({v:1,name:'fixture',default_environment:'local',environments:{local:{baseUrl:'https://example.test'}}}));
  const result=await f.run(['init','--stack','fixture']);
  assert.equal(result.code,1); assert.equal(result.result.error.code,'CONTRACT_NOT_FOUND');
  assert.match(result.result.error.next,/stack.*(?:no|without).*contract/i);
  assert.match(result.result.error.next,/not searched/i);
  assert.doesNotMatch(result.result.error.next,/Looked for:|Contract-only search:/);
});

test('CONTEXT-2a saving openapi.json recovers map, audit and init without network I/O', async t => {
  const f=fixture(t,{'app.py':unsupported.ASGI});
  writeFileSync(join(f.root,'openapi.json'),contract);
  const mapped=await f.run(['map','.','--json','--no-execute']);
  assert.equal(mapped.code,0,mapped.out+mapped.err); assert.equal(mapped.result.summary.operations,1);
  const audited=await f.run(['audit','.','--json','--no-execute']);
  assert.equal(audited.code,0,audited.out+audited.err); assert.equal(audited.result.surfaces[0].declared,1);
  const initialized=await f.run(['init']);
  assert.equal(initialized.code,0,initialized.out+initialized.err); assert.equal(initialized.result.operations,1);
});

test('CONTEXT-2a API_CONTRACT init --agents followed by map inventories a custom filename without network I/O', async t => {
  const f=fixture(t,{'app.py':unsupported.ASGI,'custom.json':contract});
  const initialized=await f.run(['init','--agents'],{API_CONTRACT:'custom.json'});
  assert.equal(initialized.code,0,initialized.out+initialized.err); assert.equal(initialized.result.operations,1);
  assert.equal(existsSync(join(f.root,'AGENTS.md')),true);
  const mapped=await f.run(['map','.','--json','--no-execute']);
  assert.equal(mapped.code,0,mapped.out+mapped.err); assert.equal(mapped.result.api_map.counts.operations,1);
});
