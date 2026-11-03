import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importPostman, importInsomnia, importBrunoDirectory } from '../lib/import.mjs';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suiteSecretProblems } from '../lib/suites.mjs';

const req = name => ({ name, request: { method: 'GET', url: '/health' }, event: [{ listen: 'test', script: { exec: ['pm.response.to.have.status(200);'] } }] });
const collection = items => ({ info: { name: 'policy' }, item: items });

test('collection setup is one owning loss with an unverified prerequisite on every runnable step', () => {
  const source = collection([req('one'), req('two'), req('three')]);
  source.event = [{ listen: 'prerequest', script: { exec: ['setup("synthetic-setup-value");'] } }];
  const out = importPostman(source);
  assert.equal(out.suite.requests.length, 3);
  assert.equal(out.report.counts.scripts_quarantined.length, 1);
  for (const step of out.suite.requests) assert.ok(step.prerequisites.some(p => p.source === 'collection:prerequest' && p.status === 'unverified' && p.executable === false));
  assert.ok(out.knowledgeCandidates.every(c => !c.conditions.request_case_digest));
  assert.ok(!JSON.stringify(out).includes('synthetic-setup-value'));
});

test('omitted credential headers become references without persisting the value', () => {
  const step = req('header');
  step.request.header = [{ key: 'X-Fixture-Token', value: 'synthetic-header-value-must-not-persist' }];
  const out = importPostman(collection([step]));
  assert.equal(out.suite.requests.length, 1);
  assert.match(out.suite.requests[0].auth, /^header:X-Fixture-Token:[A-Z_][A-Z0-9_]*$/);
  assert.equal(out.suite.requests[0].headers, undefined);
  assert.deepEqual(suiteSecretProblems(out.suite), []);
  assert.ok(!JSON.stringify(out).includes('synthetic-header-value-must-not-persist'));
  assert.equal(out.knowledgeCandidates[0].conditions.auth, 'reference');
});

test('declared runtime variables stay executable templates, undeclared variables remain named todos', () => {
  const a = req('declared'), b = req('undeclared');
  a.request.url = '/things/{{thingId}}'; b.request.url = '/things/{{unknownId}}';
  const out = importPostman(collection([a,b]), { values: { thingId: 'synthetic-runtime-value' } });
  assert.equal(out.suite.requests.length, 1);
  assert.equal(out.suite.requests[0].path, '/things/{thingId}');
  assert.match(out.todo[0].todo, /unknownId/);
  assert.ok(!JSON.stringify(out).includes('synthetic-runtime-value'));
  assert.ok(!out.knowledgeCandidates[0].conditions.request_case_digest);
});

test('Bruno inherited scripts are not multiplied across child requests', t => {
  const root = mkdtempSync(join(tmpdir(), 'import-policy-')); t.after(() => rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,'collection.bru'), 'script:pre-request {\n setup();\n}\n');
  mkdirSync(join(root,'folder'));
  writeFileSync(join(root,'folder','folder.bru'),'script:pre-request {\n setup();\n}\n');
  for(const name of ['a','b']) writeFileSync(join(root,'folder',`${name}.bru`),`meta {\n name: ${name}\n}\nget {\n url: /health\n}\nassert {\n res.status: eq 200\n}\n`);
  const out=importBrunoDirectory(root);
  assert.equal(out.suite.requests.length,2);
  assert.equal(out.report.counts.scripts_quarantined.length,2);
  for(const step of out.suite.requests) assert.equal(step.prerequisites.filter(p=>p.kind==='inherited-setup').length,2);
});

test('imported auth requirement refuses before traffic unless the selected host binds that exact reference', async t => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const seen = [];
  const server = createServer((req,res) => { seen.push(req.headers); res.writeHead(200, {'content-type':'application/json'}); res.end('{}'); });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const dir = mkdtempSync(join(tmpdir(),'import-auth-')); t.after(() => rmSync(dir,{recursive:true,force:true}));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const moduleUrl = new URL('../lib/client.mjs',import.meta.url).href;
  const run = async (configured,required,envValue,mode='suite') => {
    const config = join(dir,'config.json'); writeFileSync(config,JSON.stringify({default:'local',environments:{local:{baseUrl,...(configured?{auth:configured}:{})}}}));
    const env = Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('API_')&&!k.startsWith('POLICY_')));
    Object.assign(env,{API_CONFIG:config,API_CONTEXT_OFF:'1',API_USAGE_LOG:'/dev/null',API_EVIDENCE:join(dir,'evidence'),...(envValue?{POLICY_TOKEN:envValue}:{})});
    const code = `import {runEnvelope,apiRequest} from ${JSON.stringify(moduleUrl)};let text='';for await(const chunk of process.stdin)text+=chunk;const arg=JSON.parse(text);console.log(JSON.stringify(await (${JSON.stringify(mode)}==='suite'?runEnvelope(arg):apiRequest(arg))));`;
    return await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',code],{cwd:dir,env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.on('error',reject);child.on('exit',c=>c?reject(new Error(stderr)):resolve(JSON.parse(stdout)));const request={id:'required',method:'GET',path:'/health',expect:[{status:200}],...(required!==undefined?{auth:required}:{})};child.stdin.end(JSON.stringify(mode==='suite'?{v:2,requests:[request]}:request));});
  };
  for (const [configured,required,value] of [[null,'bearer:POLICY_TOKEN','synthetic-policy-token'],['bearer:OTHER_TOKEN','bearer:POLICY_TOKEN','synthetic-policy-token'],['bearer:POLICY_TOKEN','bearer:POLICY_TOKEN',null],['query:key:POLICY_TOKEN','header:X-Key:POLICY_TOKEN','synthetic-policy-token']]) {
    const before=seen.length, result=await run(configured,required,value);
    assert.equal(seen.length,before,'missing or mismatched binding sends zero requests');
    assert.match(JSON.stringify(result),/IMPORTED_AUTH_(?:BINDING|VALUE)_REQUIRED/);
  }
  await run('header:x-fixture:POLICY_TOKEN','header:X-Fixture:POLICY_TOKEN','synthetic-policy-token');
  assert.equal(seen.at(-1)['x-fixture'],'synthetic-policy-token');
  const before=seen.length; await run('bearer:POLICY_TOKEN',undefined,null,'ordinary');
  assert.equal(seen.length,before+1,'ordinary missing auth retains its previous behavior');
});

test('Insomnia inherited scripts have one owning loss and distinct same-text owners', () => {
  const source = { type:'collection.insomnia.rest/5.0',name:'scoped',collection:[{name:'folder',meta:{id:'fld_outer'},scripts:{preRequest:'setup();'},children:[{name:'inner',meta:{id:'fld_inner'},scripts:{preRequest:'setup();'},children:['a','b'].map(name=>({name,meta:{id:`req_${name}`},method:'GET',url:'/health',responses:[{statusCode:200}]}))}]}] };
  const out=importInsomnia(source);
  assert.equal(out.suite.requests.length,2);
  assert.equal(out.report.counts.scripts_quarantined.length,2);
  assert.equal(new Set(out.construct_ledger.filter(x=>x.disposition==='named-unsupported').map(x=>x.source_id)).size,2);
  for(const step of out.suite.requests) assert.equal(step.prerequisites.filter(p=>p.kind==='inherited-setup').length,2);
});

test('inherited ancillary credentials stay unverified without replacing effective auth', t => {
  const root=mkdtempSync(join(tmpdir(),'import-multiple-auth-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,'collection.bru'),'auth {\n mode: bearer\n}\nheaders {\n X-Session-Token: synthetic-never-save\n}\n');
  writeFileSync(join(root,'a.bru'),'meta {\n name: one\n}\nget {\n url: /health\n}\nassert {\n res.status: eq 200\n}\n');
  const out=importBrunoDirectory(root), step=out.suite.requests[0];
  assert.equal(step.auth,'bearer:POSTMAN_BEARER_TOKEN');
  assert.ok(step.prerequisites.some(p=>p.kind==='inherited-auth'&&p.variable?.startsWith('IMPORTED_X_SESSION_TOKEN_')));
  assert.ok(!JSON.stringify(out).includes('synthetic-never-save'));
  assert.equal(out.knowledgeCandidates[0].conditions.request_case_digest,undefined);
});

test('identical scripts in distinct same-named folders retain separate owners', () => {
  const folder = name => ({ name:'same',event:[{listen:'prerequest',script:{exec:['setup();']}}],item:[req(name)] });
  const out=importPostman(collection([folder('one'),folder('two')]));
  assert.equal(out.report.counts.scripts_quarantined.length,2);
  assert.equal(new Set(out.suite.requests.map(s=>s.prerequisites.find(p=>p.kind==='inherited-setup').source_id)).size,2);
});

test('unsupported inherited authentication remains unknown provenance; own unsupported auth stays todo', () => {
  const inherited=collection([req('one')]);inherited.auth={type:'basic'};
  const out=importPostman(inherited);
  assert.equal(out.suite.requests.length,1);
  assert.equal(out.suite.requests[0].auth,undefined);
  assert.ok(out.suite.requests[0].prerequisites.some(p=>p.kind==='inherited-auth'));
  assert.equal(out.knowledgeCandidates[0].conditions.auth,'unknown');
  assert.equal(out.knowledgeCandidates[0].conditions.request_case_digest,undefined);
  const own=req('own');own.request.auth={type:'basic'};
  assert.equal(importPostman(collection([own])).suite.requests.length,0);
});

test('explicit no-auth overrides collection and folder auth prerequisites without hiding active inheritance', () => {
  for (const scope of ['collection', 'folder']) for (const type of ['noauth', 'none']) {
    const own = req('own none'); own.request.auth = { type };
    const children = [own, req('inherited')];
    const source = scope === 'collection'
      ? { ...collection(children), auth: { type: 'bearer' } }
      : collection([{ name: 'folder', auth: { type: 'bearer' }, item: children }]);
    const out = importPostman(source);
    assert.equal(out.suite.requests.length, 2);
    const [none, inherited] = out.suite.requests;
    assert.equal(none.auth, 'none');
    assert.equal((none.prerequisites ?? []).some(p => p.kind === 'inherited-auth' && p.source === 'inherited authentication'), false);
    assert.equal(inherited.auth, 'bearer:POSTMAN_BEARER_TOKEN');
    assert.ok(inherited.prerequisites.some(p => p.kind === 'inherited-auth' && p.source === 'inherited authentication'));
    assert.deepEqual(none.expect, [{ status: 200 }]);
    assert.deepEqual(inherited.expect, [{ status: 200 }]);
    const candidate = out.knowledgeCandidates.find(c => c.item_id === none.id);
    assert.equal(candidate.prerequisites.some(p => p.kind === 'inherited-auth' && p.source === 'inherited authentication'), false);
  }
});

test('Bruno explicit none preserves inherited scripts, variables and ancillary credential conditions', t => {
  const root = mkdtempSync(join(tmpdir(), 'import-none-provenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'collection.bru'), 'auth {\n mode: bearer\n}\nscript:pre-request {\n setup();\n}\nvars {\n tenantId: synthetic-tenant-never-save\n}\nheaders {\n X-Session-Token: synthetic-header-never-save\n}\n');
  mkdirSync(join(root, 'folder'));
  writeFileSync(join(root, 'folder', 'folder.bru'), 'auth {\n mode: bearer\n}\nscript:pre-request {\n folderSetup();\n}\n');
  writeFileSync(join(root, 'folder', 'health.bru'), 'meta {\n name: health\n}\nget {\n url: /health\n auth: none\n}\nassert {\n res.status: eq 200\n}\n');
  const out = importBrunoDirectory(root);
  assert.equal(out.suite.requests.length, 1);
  assert.equal(out.todo.length, 0);
  const step = out.suite.requests[0];
  assert.equal(step.auth, 'none');
  assert.equal(step.prerequisites.some(p => p.kind === 'inherited-auth' && p.source === 'inherited authentication'), false);
  assert.equal(step.prerequisites.filter(p => p.kind === 'inherited-setup').length, 2);
  assert.ok(step.prerequisites.some(p => p.kind === 'inherited-variable' && p.variable === 'tenantId'));
  assert.ok(step.prerequisites.some(p => p.kind === 'inherited-auth' && p.source === 'inherited credential header X-Session-Token'));
  assert.ok(step.prerequisites.every(p => p.status === 'unverified' && p.executable === false));
  assert.equal(out.report.counts.scripts_quarantined.length, 2);
  assert.equal(out.knowledgeCandidates[0].conditions.request_case_digest, undefined);
  assert.equal(JSON.stringify(out).includes('synthetic-tenant-never-save'), false);
  assert.equal(JSON.stringify(out).includes('synthetic-header-never-save'), false);
});

test('identical inherited event declarations retain their slots without multiplying across children', () => {
  for (const scope of ['collection', 'folder']) {
    const events = Array.from({ length: 2 }, () => ({ listen: 'prerequest', script: { exec: ['setup();'] } }));
    const children = ['one', 'two', 'three'].map(req);
    const source = scope === 'collection'
      ? { ...collection(children), event: events }
      : collection([{ name: 'folder', event: events, item: children }]);
    const out = importPostman(source);
    assert.equal(out.suite.requests.length, 3);
    assert.equal(out.report.counts.scripts_quarantined.length, 2, `${scope}: each declaration owns one loss`);
    const ledger = out.construct_ledger.filter(row => row.disposition === 'named-unsupported');
    assert.equal(ledger.length, 2);
    assert.equal(new Set(ledger.map(row => row.source_id)).size, 2);
    const expected = ledger.map(row => row.source_id).sort();
    for (const step of out.suite.requests) {
      const references = step.prerequisites.filter(row => row.kind === 'inherited-setup');
      assert.deepEqual(references.map(row => row.source_id).sort(), expected);
      assert.ok(references.every(row => row.source === `${scope}:prerequest`));
    }
    assert.deepEqual(importPostman(source), out, 'declaration identity stays stable on an identical reimport');
  }
});

test('external JSON cannot impersonate adapter-only metadata or inherited credential flags', () => {
  const marker = 'synthetic-source-payload-that-must-not-be-copied';
  const source = collection([{
    ...req('one'), _prerequisites: [{ kind:'inherited-setup', source:'fixture', payload:marker }],
    _inheritedAuth:{type:'basic',payload:marker}, _inheritedAuthOwner:marker,
    _authRef:marker, _brunoAssertions:[{status:299}], _brunoMetadata:[{test_name:marker}],
    _brunoLedger:[{name:marker,disposition:'translated'}],
    _brunoLoss:[{name:marker,reason:marker,owner:marker}],
    _insomniaLoss:[{name:marker,reason:marker,owner:marker}],
  }]);
  source.item[0].event.push({listen:'test',_scope:marker,_owner:marker,script:{exec:['helper();']}});
  const out=importPostman(JSON.parse(JSON.stringify(source)));
  assert.ok(!JSON.stringify(out).includes(marker), 'private adapter fields must not copy source-model payloads');
  assert.deepEqual(out.suite.requests[0].expect,[{status:200}]);
  assert.equal(out.suite.requests[0].auth,undefined);
  const spoofed=req('own credential');
  spoofed.request.auth={type:'bearer'};
  spoofed.request.header=[{key:'X-API-Key',value:marker,_inherited:true}];
  const own=importPostman(collection([spoofed]));
  assert.equal(own.suite.requests.length,0,'a source flag cannot relabel an incompatible own credential as inherited');
  assert.ok(!JSON.stringify(own).includes(marker));
  assert.match(own.todo[0].todo,/incompatible or unsupported authentication/);
});

for (const continuation of ['redirect-query', 'redirect-userinfo', 'page-query']) test(`auth none refuses credential-bearing ${continuation} before a second attempt`, async t => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(request.url);
    if (seen.length === 1) {
      if (continuation === 'page-query') {
        response.writeHead(200, { 'content-type':'application/json', link:'</next?access_token=synthetic-value>; rel="next"' });
        response.end('[{"id":1}]');
      } else {
        const location = continuation === 'redirect-userinfo'
          ? `http://synthetic-user:synthetic-value@127.0.0.1:${server.address().port}/next`
          : '/next?access_token=synthetic-value';
        response.writeHead(302, { location }); response.end();
      }
    } else { response.writeHead(200,{'content-type':'application/json'}); response.end('[{"id":2}]'); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root=mkdtempSync(join(tmpdir(),'absence-continuation-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const config=join(root,'config.json');writeFileSync(config,JSON.stringify({default:'local',environments:{local:{baseUrl:`http://127.0.0.1:${server.address().port}`}}}));
  const client=new URL('../lib/client.mjs',import.meta.url).href;
  const envelope={requests:[{id:'none',method:'GET',path:'/first',auth:'none',expect:[{status:200}],...(continuation==='page-query'?{paginate:'all'}:{})}]};
  const result=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',`import{runEnvelope}from${JSON.stringify(client)};console.log(JSON.stringify(await runEnvelope(${JSON.stringify(envelope)})));`],{cwd:root,env:{PATH:process.env.PATH,API_CONFIG:config,API_CONTEXT_OFF:'1',API_EVIDENCE:join(root,'evidence'),API_USAGE_LOG:'/dev/null'},timeout:10000,stdio:['ignore','pipe','pipe']});let text='',err='';child.stdout.on('data',c=>text+=c);child.stderr.on('data',c=>err+=c);child.on('error',reject);child.on('close',code=>code?reject(new Error(`fixture child failed: ${err.length} diagnostic bytes`)):resolve(JSON.parse(text)));});
  assert.equal(result.attempted,1,'the first clean request is counted, and no credential-bearing continuation is attempted');
  assert.equal(seen.length,1);
  if(continuation.startsWith('redirect')) assert.equal(result.results[0].error.code,'IMPORTED_AUTH_ABSENCE_REQUIRED');
  else assert.equal(result.results[0].discovery.pages.complete,false);
});

for (const name of ['constructor', 'toString']) for (const location of ['path', 'header'])
  test(`named ${location} template ${name} requires an explicitly supplied value`, async t => {
    const { createServer } = await import('node:http');
    const { spawn } = await import('node:child_process');
    const seen = [];
    const server = createServer((request, response) => {
      seen.push({ path:request.url, header:request.headers['x-fixture-label'] });
      response.writeHead(200, {'content-type':'application/json'}); response.end('{}');
    });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const root=mkdtempSync(join(tmpdir(),'import-template-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
    const config=join(root,'config.json');
    const client=new URL('../lib/client.mjs',import.meta.url).href;
    const item=req('named template');
    item.request.url=location==='path'?`/things/{{${name}}}`:'/health';
    if(location==='header')item.request.header=[{key:'X-Fixture-Label',value:`{{${name}}}`}];
    const imported=importPostman(collection([item]),{values:{[name]:'synthetic-explicit-value'}});
    assert.equal(imported.suite.requests.length,1);
    assert.ok(!JSON.stringify(imported).includes('synthetic-explicit-value'));
    const run = async supplied => {
      writeFileSync(config,JSON.stringify({default:'local',environments:{local:{baseUrl:`http://127.0.0.1:${server.address().port}`,variables:supplied?{[name]:'synthetic-explicit-value'}:{}}}}));
      return await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',`import{runEnvelope}from${JSON.stringify(client)};console.log(JSON.stringify(await runEnvelope(${JSON.stringify(imported.suite)})));`],{cwd:root,env:{PATH:process.env.PATH,API_CONFIG:config,API_CONTEXT_OFF:'1',API_EVIDENCE:join(root,'evidence'),API_USAGE_LOG:'/dev/null'},timeout:10000,stdio:['ignore','pipe','pipe']});let text='',err='';child.stdout.on('data',c=>text+=c);child.stderr.on('data',c=>err+=c);child.on('error',reject);child.on('close',code=>code?reject(new Error(`fixture child failed: ${err.length} diagnostic bytes`)):resolve(JSON.parse(text)));});
    };
    const absent=await run(false);
    assert.equal(absent.attempted,0,'prototype properties are not runtime bindings');
    assert.equal(seen.length,0);
    assert.equal(absent.results[0].error.code,'UNRESOLVED_PLACEHOLDER');
    const supplied=await run(true);
    assert.equal(supplied.ok,true);assert.equal(supplied.attempted,1);assert.equal(seen.length,1);
    assert.equal(location==='path'?seen[0].path:seen[0].header,location==='path'?'/things/synthetic-explicit-value':'synthetic-explicit-value');
  });
