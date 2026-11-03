import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { HOME_ENV_NAME } from '../lib/brand.mjs';
const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'context-2cd-cli-'));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {createServer} from 'node:http';
    const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.statusCode=req.url==='/changed'?201:200;res.end(JSON.stringify({ready:true}));});
    server.listen(0,'127.0.0.1',()=>process.send({url:'http://127.0.0.1:'+server.address().port}));
    process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit());});
  `], { stdio: ['ignore','ignore','pipe','ipc'] });
  const [{ url }] = await once(child,'message');
  t.after(async()=>{if(child.exitCode===null){const stopped=once(child,'exit');child.kill();await stopped;}rmSync(root,{recursive:true,force:true});});
  mkdirSync(join(root,'home'));
  const env={PATH:process.env.PATH,HOME:join(root,'home'),[HOME_ENV_NAME]:join(root,'machine'),API_CONTEXT_DIR:root,
    API_USAGE_LOG:join(root,'usage.jsonl'),API_FRICTION_OFF:'1',API_BUDGET:'10000',NO_COLOR:'1'};
  execFileSync('git',['init','-q'],{cwd:root,env});
  execFileSync('git',['config','user.email','fixture@example.test'],{cwd:root,env});
  execFileSync('git',['config','user.name','Fixture'],{cwd:root,env});
  const paths=Object.fromEntries(['/verified','/written','/observed','/asserted','/changed'].map(p=>[p,{get:{responses:{200:{description:'Declared success'}}}}]));
  writeFileSync(join(root,'openapi.json'),JSON.stringify({openapi:'3.0.3',info:{title:'Synthetic',version:'1'},paths}));
  for(const name of ['alpha','other'])createFixtureStack(root,{name,baseUrl:url,contract:'openapi.json'});
  async function cli(...args){
    const c=spawn(process.execPath,[CLI,...args],{cwd:root,env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';c.stdout.on('data',b=>stdout+=b);c.stderr.on('data',b=>stderr+=b);const [code]=await once(c,'close');
    let value;try{value=JSON.parse(stdout);}catch{}
    return {code,stdout,stderr,value};
  }
  async function json(...args){const r=await cli(...args);assert.equal(r.code,0,r.stdout+r.stderr);return r.value;}
  await json('init','--stack','alpha','--json');
  await json('init','--stack','other','--json');
  execFileSync('git',['add','.'],{cwd:root,env});execFileSync('git',['commit','-qm','Synthetic fixture'],{cwd:root,env});
  async function request(path,expect){const input=join(root,'request.json');writeFileSync(input,JSON.stringify({stack:'alpha',protocol:'http',method:'GET',path,...(expect?{expect}: {})}));const r=await cli('protocol',input);assert.ok(r.value,r.stdout+r.stderr);return r.value;}
  return {root,cli,json,request,context:()=>JSON.parse(readFileSync(fixtureContextFile(root,'alpha')))};
}
test('CONTEXT-2c CLI stacks and show agree on four exclusive evidence counts',async t=>{
  const f=await fixture(t);
  await f.json('learn','--stack','alpha','--limit=1','--json');
  await f.request('/observed'); await f.request('/asserted',[{status:200}]);
  const list=await f.json('stacks','--json');
  const expected={written:2,observed:1,asserted:1,verified:1};
  assert.deepEqual(list.stacks.find(s=>s.name==='alpha').counts.evidence_classes,expected);
  const shown=await f.json('show','--stack','alpha');assert.deepEqual(shown.counts.evidence_classes,expected);
  const detail=await f.json('show','--stack','alpha','GET /asserted');assert.equal(detail.evidence_class.class,'asserted');
  const human=await f.cli('show','--stack','alpha','--human');assert.match(human.stdout,/2 written.*1 observed.*1 asserted.*1 verified/);
  assert.deepEqual(list.stacks.find(s=>s.name==='other').counts.evidence_classes,{written:5,observed:0,asserted:0,verified:0});
});
test('CONTEXT-2d CLI accepts an evidence-bound draft explicitly and retries idempotently',async t=>{
  const f=await fixture(t),response=await f.request('/changed');
  const draft=response.draft_notes?.find(d=>d.reason==='undeclared-status');assert.ok(draft,'request must propose undeclared status');
  assert.equal(f.context().operations['GET /changed'].notes?.length??0,0,'draft must not write a note');
  const accepted=await f.json('note','--stack','alpha','--accept-draft',draft.id,'--json');
  assert.equal(accepted.accepted_draft,draft.id);assert.equal(accepted.evidence.length,1);
  const retry=await f.json('note','--stack','alpha','--accept-draft',draft.id,'--json');assert.equal(retry.note_id,accepted.note_id);
  assert.equal(f.context().operations['GET /changed'].notes.length,1);
});
test('CONTEXT-2d CLI refuses wrong-stack, changed evidence and secret edited wording without saving',async t=>{
  const f=await fixture(t),response=await f.request('/changed');
  const draft=response.draft_notes?.[0];assert.ok(draft,'need proposed draft');
  const wrong=await f.cli('note','--stack','other','--accept-draft',draft.id,'--json');assert.notEqual(wrong.code,0);
  const secret=await f.cli('note','--stack','alpha','--accept-draft',draft.id,'client_secret=ek_fixtureReturnedSecret123456789','--json');assert.equal(secret.code,2);
  writeFileSync(join(f.root,'.sannr/evidence/alpha',response.evidence+'.json'),'{}');
  const changed=await f.cli('note','--stack','alpha','--accept-draft',draft.id,'--json');assert.notEqual(changed.code,0);
  assert.equal(f.context().operations['GET /changed'].notes?.length??0,0);
});
test('CONTEXT-2d CLI edited acceptance keeps ordinary explicit relationship policy',async t=>{
  const f=await fixture(t);await f.json('note','--stack','alpha','GET /changed','Written: original documentation claim.','--json');
  const response=await f.request('/changed'),draft=response.draft_notes?.[0];assert.ok(draft);
  const refused=await f.cli('note','--stack','alpha','--accept-draft',draft.id,'Observed: response differs from the contract.','--json');
  assert.equal(refused.code,3);assert.match(refused.stdout,/NOTE_RELATION_REQUIRED/);
  const accepted=await f.json('note','--stack','alpha','--accept-draft',draft.id,'Observed: response differs from the contract.','--alongside','--json');
  assert.equal(accepted.accepted_draft,draft.id);assert.equal(f.context().operations['GET /changed'].notes.length,2);
});

test('CONTEXT-2c show labels stack-fact contradictions with the operation, retaining raw history metadata',async t=>{
  const f=await fixture(t);
  await f.json('note','--stack','alpha','--scope','stack','Written: returns 200.','--json');
  await f.json('note','--stack','alpha','GET /changed','Written: status is 200.','--json');
  await f.request('/changed');
  const shown=await f.json('show','--stack','alpha','GET /changed');
  assert.equal(shown.note_history.operation,'GET /changed');
  assert.deepEqual(shown.stack_facts.note_projection.records[0].contradictions,['status']);
  assert.deepEqual(shown.stack_facts.note_projection.records[0].contradicted_operations,['GET /changed']);
  assert.equal(f.context().stack_facts.notes.length,1);
  const human=await f.cli('show','--stack','alpha','GET /changed','--human');
  assert.match(human.stdout,/conflicts with latest observation.*GET \/changed/);
});

test('CONTEXT-2c setup receipt uses the same four evidence classes',async t=>{
  const f=await fixture(t);await f.request('/observed');
  const result=await f.cli('connect','--stack','alpha','--dry-run','--json');
  assert.ok(result.value?.setup,result.stdout+result.stderr);
  assert.deepEqual(result.value.setup.context.evidence_classes,{written:4,observed:1,asserted:0,verified:0});
});
