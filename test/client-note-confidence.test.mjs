import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { withStackScope } from '../lib/stack-scope.mjs';
import { loadContextSnapshot, saveContextNote } from '../lib/context.mjs';
import { resolveNoteEvidence } from '../lib/note-evidence.mjs';
import { loadHttpContract } from '../lib/http-operation-context.mjs';
import { HOME_ENV_NAME } from '../lib/brand.mjs';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'client-note-confidence-'));
  mkdirSync(join(root, 'home'));
  const server = spawn(process.execPath, ['--input-type=module', '-e', `
    import {createServer} from 'node:http'; let n=0;
    const server=createServer((req,res)=>{const first=++n===1;res.writeHead(req.url.includes('failure=true')?500:first?200:201,{'content-type':'application/json'});res.end(JSON.stringify({code:first?'OLD_CODE':'PRIVATE_NEW_CODE'}));});
    server.listen(0,'127.0.0.1',()=>process.send({origin:'http://127.0.0.1:'+server.address().port}));
    process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit());});
  `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const [{ origin }] = await once(server, 'message');
  t.after(async () => { if (server.exitCode === null) { const end=once(server,'exit'); server.kill(); await end; } rmSync(root,{recursive:true,force:true}); });
  writeFileSync(join(root,'openapi.json'), JSON.stringify({openapi:'3.0.3',info:{title:'Fixture',version:'1'},
    paths:{'/items':{get:{responses:{200:{description:'first'},201:{description:'later'}}}},'/other':{get:{responses:{200:{description:'other'}}}}}}));
  const scope=createFixtureStack(root,{name:'one',baseUrl:origin,contract:'openapi.json'});
  const env={PATH:process.env.PATH,HOME:join(root,'home'),[HOME_ENV_NAME]:join(root,'machine'),API_CONTEXT_DIR:root,
    API_FRICTION_OFF:'1',API_USAGE_LOG:join(root,'usage.jsonl'),API_BUDGET:'16000'};
  async function request(extra={}, budget='16000') {
    const client=new URL('../lib/client.mjs',import.meta.url).href;
    const p=spawn(process.execPath,['--input-type=module','-e',`import {apiRequest} from ${JSON.stringify(client)}; console.log(JSON.stringify(await apiRequest(${JSON.stringify({stack:'one',path:'/items',...extra})})));`],
      {cwd:root,env:{...env,API_BUDGET:budget},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);const [code]=await once(p,'close');assert.equal(code,0,stderr);return JSON.parse(stdout);
  }
  const seed=await request({expect:[{status:200}]});
  const contract=loadHttpContract(scope.config.contract);
  const evidence=resolveNoteEvidence([seed.evidence],{evidenceDir:join(root,scope.evidenceDir),operation:'GET /items',environment:'local',provider:origin,contractDigest:contract.digest}).references;
  const older=new Date(Date.now()-86400000).toISOString(), newer=new Date().toISOString();
  function note(text,{stack=false,linked=false,operations}={}) { return withStackScope(scope,()=>saveContextNote(root,loadContextSnapshot(root),{
    key:stack?{kind:'stack'}:{kind:'operation',op:'GET /items'},note:text,relation:{alongside:true},
    ...(operations?{operations}:{}),stamp:{by:'agent',at:linked?older:newer,...(linked?{evidence}:{})},
  })); }
  return {root,scope,request,note,context:()=>JSON.parse(readFileSync(fixtureContextFile(root,'one'),'utf8'))};
}

test('CONTEXT-2c actual client ranks linked evidence before newer prose and retains contradiction flags without deleting notes',async t=>{
  const f=await fixture(t);
  f.note('Newest operation prose.');
  const linked=f.note('Returns HTTP 200. Returns error code OLD_CODE.',{linked:true});
  f.note('Newest stack prose.',{stack:true});
  const stackLinked=f.note('Returns HTTP 200.',{stack:true,linked:true,operations:['GET /items']});
  f.note('Other operation only.',{stack:true,operations:['GET /other']});
  const before=f.context(); await f.request();
  // known describes evidence retained before this request, even when this
  // caller opts out of adding a new observation.
  const out=await f.request({capture_context:false});
  assert.deepEqual(out.known.notes,['Returns HTTP 200.','Newest stack prose.','Returns HTTP 200. Returns error code OLD_CODE.','Newest operation prose.']);
  const records=out.known.note_projection.records;
  assert.equal(records.find(row=>row.id===linked.note_id).evidence_class.class,'asserted');
  assert.deepEqual(records.find(row=>row.id===linked.note_id).contradictions,['status','error-code']);
  assert.deepEqual(records.find(row=>row.id===stackLinked.note_id).contradictions,['status']);
  assert.equal(records[0].scope,'stack'); assert.equal(records[2].scope,'operation');
  const after=f.context();assert.deepEqual(after.stack_facts,before.stack_facts);assert.deepEqual(after.operations,before.operations);
  assert.equal(JSON.stringify(after).includes('PRIVATE_NEW_CODE'),false);
});

test('CONTEXT-2c stack ranking precedes its cap and budgeted projection matches only delivered notes',async t=>{
  const f=await fixture(t);
  for(let n=0;n<6;n++)f.note(`Newer stack prose ${n}.`,{stack:true});
  const linked=f.note('Linked stack guidance.',{stack:true,linked:true});
  const out=await f.request();assert.equal(out.known.notes[0],'Linked stack guidance.');
  assert.equal(out.known.stack_facts.total,7);assert.equal(out.known.stack_facts.shown,5);assert.equal(out.known.stack_facts.omitted,2);
  assert.equal(out.known.note_projection.records.length,5);assert.equal(out.known.note_projection.records[0].id,linked.note_id);
  const small=await f.request({},'600');assert.ok(Math.ceil(JSON.stringify(small).length/4)<=600);
  if(small.known?.note_projection?.records)assert.ok(small.known.note_projection.records.length<=(small.known.notes?.length??0));
});

test('CONTEXT-2c actual client canonical grade names a later failed response despite a retained legacy verified stamp',async t=>{
  const f=await fixture(t);
  f.note('The legacy check predates this request.');
  const ctx=f.context();Object.assign(ctx.operations['GET /items'],{verified_at:new Date(Date.now()-1000).toISOString(),status_codes:[200]});
  writeFileSync(fixtureContextFile(f.root,'one'),JSON.stringify(ctx));
  await f.request({params:{failure:true}});
  const out=await f.request({capture_context:false});
  assert.equal(out.known.confidence,'verified','raw compatibility label is retained');
  assert.equal(out.known.evidence_class.class,'observed');
  assert.equal(out.known.evidence_class.current_success,false);
  assert.equal(out.known.evidence_class.reason,'latest-response-failed');
});
