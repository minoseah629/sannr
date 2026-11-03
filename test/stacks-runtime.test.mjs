import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { projectEntry } from '../lib/connect.mjs';
import { normalizeSuite, serializeSuite } from '../lib/suites.mjs';
import { captureOperationContext } from '../lib/operation-context.mjs';
import { withStackScope } from '../lib/stack-scope.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { HOME_ENV_NAME, TOOL_NAME } from '../lib/brand.mjs';

const rootPackage = fileURLToPath(new URL('../', import.meta.url));
const write = (path, object) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(object) + '\n'); };
const serverCode = `
import { createServer } from 'node:http';
const requests = [];
const server = createServer(async (req, res) => {
  let text = ''; for await (const bytes of req) text += bytes;
  requests.push({ path: req.url, authorization: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null });
  if (req.url === '/login') res.setHeader('set-cookie', 'session=synthetic-session; Path=/');
  res.setHeader('content-type', 'application/json');
  setTimeout(() => {
    let body; try { body = JSON.parse(text); } catch {}
    const authorization = req.headers.authorization;
    const credentials = authorization?.startsWith('Basic ') ? Buffer.from(authorization.slice(6), 'base64').toString('utf8') : null;
    const colon = credentials?.indexOf(':');
    const echo = credentials ? { username:credentials.slice(0,colon), password:credentials.slice(colon+1), authorization,
      context_lookalike:{identity:{stack:credentials.slice(0,colon)},observations:[{evidence:[{path:credentials.slice(0,colon)}]}]} } : {};
    res.end(JSON.stringify(body?.jsonrpc ? { jsonrpc:'2.0',id:body.id,result:{ready:true,...echo} } : { ready:true,...echo }));
  }, 40);
});
server.listen(0, '127.0.0.1', () => process.send({ origin:'http://127.0.0.1:' + server.address().port }));
process.on('message', m => {
  if (m.command === 'snapshot') process.send({ id:m.id,requests });
  if (m.command === 'stop') server.close(() => process.exit(0));
});`;
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'stacks-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['--input-type=module', '-e', serverCode],
    { env: { PATH:process.env.PATH }, stdio:['ignore','pipe','pipe','ipc'] });
  t.after(async () => { if (child.exitCode !== null) return; const done = new Promise(r => child.once('exit',r)); child.send({command:'stop'}); await done; });
  const origin = await new Promise((r,j) => { child.once('message',v=>r(v.origin)); child.once('error',j); });
  let serial = 0;
  const snapshot = () => new Promise(r => { const id = ++serial; const read = v => { if (v.id === id) { child.off('message',read);r(v.requests); } }; child.on('message',read);child.send({command:'snapshot',id}); });
  const env = { PATH:process.env.PATH, HOME:join(root,'home'), [HOME_ENV_NAME]:join(root,'machine'), API_USAGE_LOG:'', API_CONTEXT_DIR:root,
    FIXTURE_ALPHA_KEY:'synthetic-alpha', FIXTURE_BETA_KEY:'synthetic-beta' };
  mkdirSync(env.HOME);
  const stack = (name, { file = false } = {}) => {
    const folder = join(root,'.sannr','stacks',name);
    write(join(folder,'stack.json'), { v:1,name,default_environment:'local',contract:'openapi.json',environments:{local:{baseUrl:origin,
      auth:`bearer:${file ? 'FIXTURE_SHARED_KEY' : name === 'alpha' ? 'FIXTURE_ALPHA_KEY' : 'FIXTURE_BETA_KEY'}`,
      ...(file ? {envFile:'credentials.env'} : {})}} });
    write(join(folder,'openapi.json'), { openapi:'3.0.3',info:{title:name,version:'1'},paths:{'/users':{get:{responses:{'200':{description:'ok'}}}},'/login':{get:{responses:{'200':{description:'ok'}}}}} });
    if (file) writeFileSync(join(folder,'credentials.env'), `FIXTURE_SHARED_KEY=synthetic-${name}-file\n`);
    return folder;
  };
  const session = async () => {
    const p = spawn(process.execPath,[join(rootPackage,'server.mjs')],{cwd:root,env,stdio:['pipe','pipe','pipe']});
    t.after(async () => { if (p.exitCode !== null) return; const done = new Promise(r=>p.once('exit',r));p.stdin.end();await done; });
    let serial=0, buffer='', stderr='';const pending=new Map();
    p.stderr.on('data',chunk=>stderr+=chunk);
    p.stdout.on('data',chunk=>{ buffer+=chunk;const lines=buffer.split('\n');buffer=lines.pop();
      for (const line of lines) { const message=JSON.parse(line);const item=pending.get(message.id);if (item) {pending.delete(message.id);item.resolve(message);}} });
    p.on('exit',()=>{for(const item of pending.values())item.reject(new Error(stderr));});
    const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});p.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
    await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture',version:'1'}});
    return async args => {const reply=await rpc('tools/call',{name:TOOL_NAME,arguments:args});
      return JSON.parse(reply.result.content[0].text);};
  };
  return {root,origin,stack,session,snapshot,env};
}
const get = stack => ({path:'/users',stack,expect:[{status:200}]});

test('stack runtime partitions concurrent identical requests and same-origin cookies', async t => {
  const f=await fixture(t);f.stack('alpha');f.stack('beta');const call=await f.session();
  const both=await Promise.all([call(get('alpha')),call(get('beta'))]);
  assert.deepEqual(both.map(r=>[r.ok,r.stack]),[[true,'alpha'],[true,'beta']]);
  const first=await f.snapshot(); assert.equal(first.length,2,'different stacks must not deduplicate one another');
  assert.deepEqual(first.map(r=>r.authorization).sort(),['Bearer synthetic-alpha','Bearer synthetic-beta']);
  assert.ok(!both.some(r=>r.coalesced));
  assert.equal((await call({path:'/login',stack:'alpha'})).ok,true);
  await call(get('beta'));await call(get('alpha'));
  const after=await f.snapshot();assert.equal(after[3].cookie,null);assert.equal(after[4].cookie,'session=synthetic-session');
});

test('stack credential files remain local and rotate in the running MCP process', async t => {
  const f=await fixture(t),a=f.stack('alpha',{file:true});f.stack('beta',{file:true});const call=await f.session();
  await Promise.all([call(get('alpha')),call(get('beta'))]);
  assert.deepEqual((await f.snapshot()).map(r=>r.authorization).sort(),['Bearer synthetic-alpha-file','Bearer synthetic-beta-file']);
  writeFileSync(join(a,'credentials.env'),'FIXTURE_SHARED_KEY=synthetic-alpha-rotated\n');
  await call(get('alpha'));await call(get('beta'));
  assert.deepEqual((await f.snapshot()).slice(2).map(r=>r.authorization),['Bearer synthetic-alpha-rotated','Bearer synthetic-beta-file']);
});

test('stack capture identities are retrievable on the next call in their own store', async t => {
  const f=await fixture(t);
  for (const name of ['alpha','beta']) {
    const folder=f.stack(name);
    write(join(folder,'sannr.json'),{v:0,api:{name},operations:{'GET /users':{
      notes:[`${name} authored constraint`],notes_provenance:[{by:'agent',at:'2026-10-06'}],notes_superseded:[null],verified_at:null,
    }}});
  }
  const call=await f.session();
  const a=await call(get('alpha'));const b=await call(get('beta'));const next=await call(get('alpha'));
  assert.equal(a.context_capture.state,'captured');assert.equal(b.context_capture.state,'captured');
  assert.deepEqual(next.known.notes,['alpha authored constraint']);
  assert.equal(next.known.scoped.identity.stack,'alpha');
  assert.deepEqual(next.known.scoped.observations.map(o=>o.id),[a.context_capture.observation_id]);
  assert.ok(!JSON.stringify(next.known).includes(b.context_capture.observation_id));
});

test('stack protocol requests preserve selected credentials, identity and evidence scope', async t => {
  const f=await fixture(t);f.stack('alpha');f.stack('beta');const call=await f.session();
  for (const stack of ['alpha','beta']) {
    const result=await call({stack,path:'/rpc',protocol:'jsonrpc',rpc:{method:'fixture.read'},expect:[{json:'result.ready',equals:true}]});
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.protocol.identity.stack,stack);
    const store=JSON.parse(readFileSync(join(f.root,'.sannr','stacks',stack,'sannr.json'),'utf8'));
    const observation=Object.values(store.api_context.operations)[0].observations[0];
    assert.ok(observation.evidence[0].path.startsWith(`.sannr/evidence/${stack}/`));
  }
  assert.deepEqual((await f.snapshot()).map(r=>r.authorization),['Bearer synthetic-alpha','Bearer synthetic-beta']);
});

function basicStack(f, name, username, password, { prefix = '', explicit = false } = {}) {
  const folder = f.stack(name, { file:true });
  const file = join(folder, 'stack.json'), doc = JSON.parse(readFileSync(file, 'utf8'));
  Object.assign(doc.environments.local, { baseUrl:f.origin + prefix, auth:'basic:FIXTURE_SHARED_USER:FIXTURE_SHARED_PASS',
    ...(explicit ? { contractPathPrefix:prefix } : {}) });
  write(file, doc);
  writeFileSync(join(folder, 'credentials.env'), `FIXTURE_SHARED_USER=${username}\nFIXTURE_SHARED_PASS=${password}\n`);
  return folder;
}
const basicHeader = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

test('Basic + stacks keeps concurrent mounted captures, credential snapshots and evidence identities isolated', async t => {
  const f = await fixture(t);
  const a = basicStack(f, 'alpha', 'path', 'synthetic-alpha-password', { prefix:'/alpha/v1' });
  const b = basicStack(f, 'beta', 'run', 'synthetic-beta-password', { prefix:'/beta/v2', explicit:true });
  const call = await f.session();
  const results = await Promise.all(['alpha','beta'].map(stack => call({ stack,path:'/users' })));
  for (const [index, stack] of ['alpha','beta'].entries()) {
    const result = results[index];
    assert.equal(result.ok, true); assert.equal(result.stack, stack);
    assert.equal(result.context_capture.state, 'captured');
    assert.deepEqual(result.context_capture.mount, { pathPrefix:index ? '/beta/v2' : '/alpha/v1', source:index ? 'contractPathPrefix' : 'base-url-path' });
    const folder = index ? b : a, store = JSON.parse(readFileSync(join(folder, 'sannr.json'), 'utf8'));
    const operation = store.api_context.operations[result.context_capture.operation_id];
    assert.equal(operation.identity.stack, stack);
    const observation = operation.observations.find(row => row.id === result.context_capture.observation_id);
    assert.ok(observation);
    assert.ok(observation.evidence[0].path.startsWith(`.sannr/evidence/${stack}/`));
    const evidence = JSON.parse(readFileSync(join(f.root, '.sannr', 'evidence', stack, `${result.evidence}.json`), 'utf8'));
    assert.equal(evidence.runId, result.evidence);
    assert.equal(evidence.origin.scope.provider, f.origin + (index ? '/beta/v2' : '/alpha/v1'));
    assert.equal(evidence.response.body.username, '[redacted]');
    // FIELD-1a: response credential fields now carry salted evidence markers;
    // configured-auth echoes in the transient envelope remain [redacted].
    assert.match(evidence.response.body.password, /^\[withheld: secret; salted-sha256:[a-f0-9]{64}\]$/);
    assert.match(evidence.response.body.authorization, /^\[withheld: secret; salted-sha256:[a-f0-9]{64}\]$/);
    assert.equal(evidence.response.body_secrets.replaced, true);
    assert.ok(evidence.response.body_secrets.replacements >= 2);
    const serialized = JSON.stringify(evidence);
    for (const [username, password] of [['path', 'synthetic-alpha-password'], ['run', 'synthetic-beta-password']]) {
      assert.ok(!serialized.includes(password));
      assert.ok(!serialized.includes(basicHeader(username, password)));
    }
    assert.equal(result.data.username, '[redacted]');
  }
  assert.deepEqual((await f.snapshot()).map(row => [row.path,row.authorization]).sort(), [
    ['/alpha/v1/users',basicHeader('path','synthetic-alpha-password')],
    ['/beta/v2/users',basicHeader('run','synthetic-beta-password')],
  ]);
  writeFileSync(join(a, 'credentials.env'), 'FIXTURE_SHARED_USER=path\n');
  const refused = await call({ stack:'alpha',path:'/users' });
  assert.equal(refused.error.code, 'AUTH_ENV_MISSING');
  assert.equal((await f.snapshot()).length, 2, 'A missing Basic pair cannot borrow the other stack or dispatch unauthenticated');
  const protocol = await call({ stack:'beta',path:'/rpc',protocol:'jsonrpc',rpc:{method:'fixture.read'},expect:[{json:'result.ready',equals:true}] });
  assert.equal(protocol.ok, true); assert.equal(protocol.protocol.identity.stack, 'beta');
  const p = JSON.parse(readFileSync(join(f.root,'.sannr','evidence','beta',`${protocol.evidence}.json`),'utf8'));
  assert.equal(p.identity.stack, 'beta');
  assert.match(p.response.body.result.password, /^\[withheld: secret; salted-sha256:[a-f0-9]{64}\]$/);
  assert.equal(p.response.body_secrets.replaced, true);
  assert.ok(p.response.body_secrets.replacements >= 2);
  assert.ok(!JSON.stringify(p).includes('synthetic-beta-password'));
  assert.ok(!JSON.stringify(p).includes(basicHeader('run', 'synthetic-beta-password')));
});

test('Basic + stacks withholds credential-matching routing labels for HTTP, protocol and pre-dispatch refusals', async t => {
  const f = await fixture(t), folder = basicStack(f, 'alpha', 'alpha', 'synthetic-alpha-password');
  const call = await f.session();
  for (const args of [
    { stack:'alpha',path:'/users' }, { upstream:'alpha',path:'/users' },
    { upstream:'alpha',path:'/rpc',protocol:'jsonrpc',rpc:{method:'fixture.read'} },
    { upstream:'alpha',path:'/rpc',protocol:'jsonrpc',rpc:{method:'fixture.read'},body:{} },
  ]) {
    const result = await call(args);
    assert.equal(result.stack, null, 'Wrapper must not reintroduce the raw credential as a configured stack label');
    assert.equal(result.stack_withheld, true);
    if (args.upstream) { assert.equal(result.routing_alias.value, null); assert.equal(result.routing_alias.value_withheld, true); }
    if (result.protocol) {
      assert.equal(result.protocol.identity.stack, null); assert.equal(result.protocol.identity.stack_withheld, true);
      assert.equal(result.context_capture.identity.stack, null); assert.equal(result.context_capture.identity.stack_withheld, true);
      const stored = JSON.parse(readFileSync(join(folder, 'sannr.json'), 'utf8')).api_context.operations[result.context_capture.operation_id];
      assert.equal(stored.identity.stack, 'alpha', 'Presentation withholding cannot change the actual saved identity');
    }
    assert.equal(JSON.stringify(result).includes('alpha'), false);
  }
  assert.equal((await f.snapshot()).length, 3);
});

for (const protocol of ['http', 'jsonrpc']) test(`Basic + stacks withholds saved ${protocol} context labels and evidence pointers without changing stored identities`, async t => {
  const f = await fixture(t), folder = basicStack(f, 'alpha', 'alpha', 'synthetic-alpha-password');
  f.env.API_BUDGET = '4000';
  const call = await f.session(), args = protocol === 'http' ? { upstream:'alpha',path:'/users' }
    : { upstream:'alpha',path:'/rpc',protocol:'jsonrpc',rpc:{method:'fixture.read'} };
  const first = await call(args), next = await call(args);
  const context = protocol === 'http' ? next.known.scoped : next.known.operations[0];
  assert.equal(context.identity.stack, null, 'Saved configured labels must not bypass returned-context scrubbing');
  assert.equal(context.identity.stack_withheld, true);
  const previous = context.observations.find(row => row.id === first.context_capture.observation_id);
  assert.ok(previous, 'The earlier observation must still be identifiable');
  assert.equal(previous.evidence[0].path, null, 'A redacted evidence path is not a usable file pointer');
  assert.equal(previous.evidence[0].path_withheld, true);
  assert.equal(JSON.stringify(next.known).includes('alpha'), false);
  const payload = protocol === 'http' ? next.data : next.data.result;
  // Protocol credential scrubbing precedes response scanning, which protects
  // the scrubbed password marker and all of its aliases with an opaque hash.
  if (protocol === 'http') assert.equal(payload.username, '[redacted]');
  else assert.match(payload.username, /^\[withheld: secret; salted-sha256:[a-f0-9]{64}\]$/);
  assert.equal(payload.context_lookalike.identity.stack, payload.username, 'Provider lookalikes cannot acquire context-reader trust');
  assert.equal(payload.context_lookalike.observations[0].evidence[0].path, payload.username);
  assert.equal(JSON.stringify(payload).includes('alpha'), false, 'Provider data remains untrusted');
  assert.equal(Object.hasOwn(payload.context_lookalike.identity, 'stack_withheld'), false);
  const stored = JSON.parse(readFileSync(join(folder, 'sannr.json'), 'utf8')).api_context.operations[first.context_capture.operation_id];
  assert.equal(stored.identity.stack, 'alpha');
  const observation = stored.observations.find(row => row.id === first.context_capture.observation_id);
  const evidence = JSON.parse(readFileSync(join(f.root, observation.evidence[0].path), 'utf8'));
  assert.equal(evidence.runId, first.evidence, 'Saved evidence IDs still match the actual files');
  assert.ok(stored.observations.some(row => row.id === next.context_capture.observation_id));
  const requests = await f.snapshot();
  assert.equal(requests.length, 2);
  assert.ok(requests.every(row => row.authorization === basicHeader('alpha', 'synthetic-alpha-password')),
    'Returned credential masking must not change either authenticated request');
});

test('Basic + stacks rejected contracts retain per-stack diagnostics instead of claiming no contract was bound', async t => {
  const f = await fixture(t), a = basicStack(f, 'alpha', 'fixture-user', 'fixture-password'), b = f.stack('beta');
  write(join(a, 'openapi.json'), { openapi:'3.0.0',paths:{ '/users?synthetic=PRIVATE_QUERY_VALUE':{get:{}} } });
  const call = await f.session();
  const bad = await call(get('alpha')), good = await call(get('beta'));
  assert.equal(bad.ok, true); assert.equal(bad.context_capture.code, 'HTTP_CONTEXT_ROUTE_UNRESOLVED');
  assert.equal(bad.context_capture.reason, 'contract-rejected');
  assert.equal(bad.context_capture.contract_reason, 'no-matchable-routes');
  assert.equal(good.context_capture.state, 'captured');
  assert.ok(existsSync(join(b, 'sannr.json')));
  assert.equal(JSON.stringify(bad).includes('PRIVATE_QUERY_VALUE'), false);
});

test('Basic + stacks routing metadata participates in the measured presentation budget', async t => {
  const f = await fixture(t);
  f.env.API_BUDGET = '425';
  basicStack(f, 'alpha', 'alpha', 'synthetic-alpha-password', { prefix:'/v1' });
  const call = await f.session(), result = await call({ upstream:'alpha',path:'/users' });
  assert.equal(result.ok, true);
  assert.equal(result.stack, null); assert.equal(result.routing_alias.value, null);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 425 * 4 || result.budget_min >= Math.ceil(Buffer.byteLength(JSON.stringify(result))/4), 'Routing labels and withheld markers must be measured before return');
});

test('explicit-stack registrations omit single-API pins while legacy registrations retain them', async t => {
  const f=await fixture(t),cfg={name:'local',file:join(f.root,'api-environments.json'),contract:join(f.root,'openapi.json'),defaults:{evidenceDir:'evidence'}};
  const old=projectEntry(f.root,cfg);assert.equal(old.env.API_ENV,'local');assert.ok(old.env.API_CONFIG);assert.ok(old.env.API_CONTRACT);
  f.stack('alpha');const current=projectEntry(f.root,cfg);
  for (const key of ['API_ENV','API_CONFIG','API_CONTRACT','API_BASE_URL']) assert.equal(current.env[key],undefined,key);
  assert.equal(current.env.API_CONTEXT_DIR,f.root);assert.equal(current.env.API_EVIDENCE,join(f.root,'.sannr','evidence'));
});

test('saved suites retain envelope and step stack/environment selections', () => {
  const normalized=normalizeSuite('cross-stack',{stack:'alpha',environment:'local',requests:[
    {path:'/users',stack:'beta',environment:'staging',expect:[{status:200}]},
    {path:'/users',upstream:'alpha',expect:[{status:200}]},
  ]});
  assert.deepEqual(normalized.problems,[]);
  const saved=JSON.parse(serializeSuite(normalized.suite));
  assert.equal(saved.stack,'alpha');assert.equal(saved.environment,'local');
  assert.equal(saved.requests[0].stack,'beta');assert.equal(saved.requests[0].environment,'staging');assert.equal(saved.requests[1].upstream,'alpha');
});


test('stack batch routing mistakes refuse all steps before traffic', async t => {
  const f=await fixture(t);f.stack('alpha');f.stack('beta');const call=await f.session();
  for (const last of [{stack:'missing'}, {stack:'beta',environment:'missing'}]) {
    const result=await call({requests:[{path:'/login',stack:'alpha',expect:[{status:200}]},
      {path:'/users',expect:[{status:200}],...last}]});
    assert.equal(result.ok,false);assert.equal(result.attempted,0);assert.equal(result.error.details.request_index,1);
    assert.ok(['STACK_NOT_FOUND','ENVIRONMENT_NOT_FOUND'].includes(result.error.code));
  }
  assert.deepEqual(await f.snapshot(),[]);
});


function externalCaptureFixture(t) {
  const base=realpathSync(mkdtempSync(join(tmpdir(),'stacks-external-')));
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const root=join(base,'project'),alias=join(base,'project-alias');mkdirSync(root);symlinkSync(root,alias,'dir');
  const scope={root:alias,stack:'alpha',contextFile:'.sannr/stacks/alpha/sannr.json',evidenceDir:'.sannr/evidence/alpha'};
  mkdirSync(dirname(join(root,scope.contextFile)),{recursive:true});
  for(const name of ['alpha','beta']) write(join(root,'.sannr','evidence',name,'run-fixture.json'),{fixture:'synthetic-private-evidence'});
  const input={identity:{provider:'https://alpha.example.test',environment:'local',protocol:'graphql',operation:'query Fixture',
    endpoint:'https://alpha.example.test/graphql',contractDigest:null},source:{tool:'fixture-client'},basis:'authored',
    outcome:'unknown',complete:false,evidence:[{path:'.sannr/evidence/alpha/run-fixture.json'}],notes:['Synthetic external observation.']};
  const run=value=>withStackScope(scope,()=>captureOperationContext(root,value));
  const context=()=>readFileSync(join(root,scope.contextFile),'utf8');
  return {root,input,run,context};
}

test('external capture injects the active stack under a canonical root alias', t => {
  const f=externalCaptureFixture(t),result=f.run(f.input);
  assert.equal(result.state,'captured');assert.equal(result.identity.stack,'alpha');
  const stored=JSON.parse(f.context()),record=Object.values(stored.api_context.operations)[0];
  assert.equal(record.identity.stack,'alpha');assert.equal(record.observations[0].verification,'external-claim');
  assert.equal(record.observations[0].source.kind,'external');
  assert.equal(existsSync(join(f.root,LAYOUT.context)),false,'capture must not create the legacy store');
  assert.doesNotMatch(f.context(),/synthetic-private-evidence/);
});

test('external capture rejects evidence belonging to a different stack without changing knowledge', t => {
  const f=externalCaptureFixture(t);f.run(f.input);const before=f.context();
  assert.throws(()=>f.run({...f.input,evidence:[{path:'.sannr/evidence/beta/run-fixture.json'}]}),{code:'CONTEXT_EVIDENCE_INVALID'});
  assert.equal(f.context(),before);
  assert.throws(()=>f.run({...f.input,identity:{...f.input.identity,stack:'beta'}}),{code:'CONTEXT_IDENTITY_INVALID'});
  assert.equal(f.context(),before);
});
