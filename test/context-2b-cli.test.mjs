// CONTEXT-2b acceptance: real CLI, isolated synthetic repositories, and loopback
// service in its own process. No fixture credentials leave the local process tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { HOME_ENV_NAME, PROJECT_DIR_NAME } from '../lib/brand.mjs';
const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const PRIVATE_FACT = 'Trial account; organization writes are unavailable.';
const TOKEN_A = 'synthetic-account-credential-one';
const TOKEN_B = 'synthetic-account-credential-two';
const words = value => JSON.stringify(value);
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'context-2b-cli-'));
  const server = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:http';
    const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({ready:true}));});
    server.listen(0,'127.0.0.1',()=>process.send({url:'http://127.0.0.1:'+server.address().port}));
    process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit());});
  `], { stdio: ['ignore','ignore','pipe','ipc'] });
  const [{url}] = await once(server, 'message');
  t.after(async()=>{if(server.exitCode===null){const done=once(server,'exit');server.kill();await done;}rmSync(root,{recursive:true,force:true});});
  mkdirSync(join(root,'home'));
  const env={PATH:process.env.PATH,HOME:join(root,'home'),[HOME_ENV_NAME]:join(root,'machine'),API_CONTEXT_DIR:root,
    API_USAGE_LOG:join(root,'usage.jsonl'),API_FRICTION_OFF:'1',API_BUDGET:'10000',NO_COLOR:'1',
    ACCOUNT_FIXTURE_KEY:TOKEN_A,SECOND_ACCOUNT_KEY:'synthetic-other-account'};
  const git=(...args)=>execFileSync('git',args,{cwd:root,env,encoding:'utf8'});
  git('init','-q');git('config','user.email','fixture@example.test');git('config','user.name','Fixture');
  writeFileSync(join(root,'openapi.json'),JSON.stringify({openapi:'3.0.3',info:{title:'Account fixture',version:'1'},paths:{'/health':{get:{responses:{200:{description:'Declared success'}}}}}}));
  for(const name of ['billing','other'])createFixtureStack(root,{name,environment:'staging',baseUrl:url,contract:'openapi.json',environments:{
    staging:{baseUrl:url,auth:'bearer:ACCOUNT_FIXTURE_KEY'},sandbox:{baseUrl:url,auth:'bearer:SECOND_ACCOUNT_KEY'},
  }});
  async function cli(...args){
    const child=spawn(process.execPath,[CLI,...args],{cwd:root,env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    const [code]=await once(child,'close');let value;try{value=JSON.parse(stdout);}catch{}
    return {code,stdout,stderr,value};
  }
  async function json(...args){const r=await cli(...args);assert.equal(r.code,0,r.stdout+r.stderr);assert.ok(r.value,r.stdout+r.stderr);return r.value;}
  await json('init','--stack','billing','--json');await json('init','--stack','other','--json');
  git('add','.');git('commit','-qm','Synthetic account fixture');
  const note=(text=PRIVATE_FACT,...extra)=>json('note','--stack','billing','--env','staging','--scope','account',text,...extra,'--json');
  const show=(stack='billing',environment='staging')=>json('show','--stack',stack,'--env',environment,'--scope','account');
  async function request(stack='billing',environment='staging'){
    const input=join(root,'request.json');writeFileSync(input,JSON.stringify({stack,environment,protocol:'http',method:'GET',path:'/health',expect:[{status:200}]}));
    return json('protocol',input);
  }
  function committable(){return git('ls-files','--cached','--others','--exclude-standard','-z').split('\0').filter(Boolean).map(p=>({path:p,text:readFileSync(join(root,p),'utf8')}));}
  return {root,env,git,cli,json,note,show,request,committable};
}
function walk(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(join(dir,entry.name)):[join(dir,entry.name)]);}

test('CONTEXT-2b CLI account note stays private through connect, request and ordinary note writes',async t=>{
  const f=await fixture(t),saved=await f.note();
  assert.equal(saved.key.kind,'account');assert.equal(saved.key.credential_reference,'bearer:ACCOUNT_FIXTURE_KEY');assert.equal(saved.shared,false);
  const file=resolve(f.root,saved.file);assert.equal(statSync(file).mode&0o777,0o600,'private file mode');
  assert.ok(relative(f.root,file).startsWith(PROJECT_DIR_NAME+'/'),'private fact lives inside project private area');
  assert.equal(f.git('check-ignore',relative(f.root,file)).trim(),relative(f.root,file));
  const shown=await f.show();assert.equal(shown.records.length,1);assert.equal(shown.records[0].text,PRIVATE_FACT);assert.ok(shown.records[0].at);
  await f.json('connect','--no-skills','--json');
  const response=await f.request();assert.match(words(response.known),/Trial account/);
  await f.json('note','--stack','billing','GET /health','Documented: health is a read-only operation.','--json');
  for(const entry of f.committable())assert.ok(!entry.text.includes(PRIVATE_FACT),'private fact leaked into '+entry.path);
  assert.ok(!words(await f.json('show','--stack','billing')).includes(PRIVATE_FACT),'ordinary show must not reveal private facts');
  const human=await f.cli('show','--stack','billing','--env','staging','--scope','account','--human','--history');
  assert.equal(human.code,0,human.stdout+human.stderr);assert.match(human.stdout,/Account facts/);assert.match(human.stdout,/Trial account/);
});

test('CONTEXT-2b CLI --shared commits the reference and fact, never the value or fingerprint',async t=>{
  const f=await fixture(t),text='This shared project account cannot read organization endpoints.';
  const saved=await f.note(text,'--shared');assert.equal(saved.shared,true);
  const body=readFileSync(fixtureContextFile(f.root,'billing'),'utf8');assert.ok(body.includes(text));assert.ok(body.includes('ACCOUNT_FIXTURE_KEY'));
  assert.doesNotMatch(body,/fingerprint|salt|hmac/i);
  for(const entry of f.committable())for(const token of [TOKEN_A,TOKEN_B]){
    assert.ok(!entry.text.includes(token),'credential value in '+entry.path);
    assert.ok(!entry.text.includes(createHash('sha256').update(token).digest('hex')),'unsalted digest in '+entry.path);
  }
  for(const path of walk(join(f.root,PROJECT_DIR_NAME)))for(const token of [TOKEN_A,TOKEN_B]){
    const bytes=readFileSync(path,'utf8');assert.ok(!bytes.includes(token),'credential persisted in '+relative(f.root,path));
    assert.ok(!bytes.includes(createHash('sha256').update(token).digest('hex')),'unsalted digest persisted');
  }
  assert.equal((await f.show()).records[0].shared,true);
});

test('CONTEXT-2b CLI account facts are isolated by stack, environment and credential reference',async t=>{
  const f=await fixture(t);await f.note();
  assert.match(words((await f.request()).known),/Trial account/);
  for(const [stack,environment] of [['other','staging'],['billing','sandbox']]){
    assert.equal((await f.show(stack,environment)).records.length,0);
    assert.ok(!words((await f.request(stack,environment)).known).includes(PRIVATE_FACT));
  }
  const path=join(f.root,PROJECT_DIR_NAME,'stacks','billing','stack.json');
  const config=JSON.parse(readFileSync(path));config.environments.staging.auth='bearer:SECOND_ACCOUNT_KEY';writeFileSync(path,JSON.stringify(config));
  assert.equal((await f.show()).records.length,0,'same stack/environment with a different credential reference must not inherit account claims');
  assert.ok(!words((await f.request()).known).includes(PRIVATE_FACT));
});

test('CONTEXT-2b CLI rotation is visible without rewriting history; explicit exact repeat reconfirms',async t=>{
  const f=await fixture(t),first=await f.note();
  assert.equal((await f.show()).records[0].credential_state,'confirmed');
  f.env.ACCOUNT_FIXTURE_KEY=TOKEN_B;
  const changed=await f.show();assert.equal(changed.records[0].credential_state,'changed');assert.equal(changed.records[0].id,first.note_id);
  const human=await f.cli('show','--stack','billing','--env','staging','--scope','account','--human');assert.match(human.stdout,/credential changed since observed/);
  assert.match(words((await f.request()).known),/changed/);
  assert.equal((await f.show()).records[0].credential_state,'changed','reading or requesting cannot reconfirm a fact');
  const repeated=await f.note();assert.equal(repeated.note_id,first.note_id);assert.equal(repeated.reconfirmed,true);
  assert.equal((await f.show()).records.length,1);assert.equal((await f.show()).records[0].credential_state,'confirmed');
});

test('CONTEXT-2b CLI account note retains selected evidence identity and rejects another environment',async t=>{
  const f=await fixture(t),request=await f.request();
  const run=typeof request.evidence==='string'?request.evidence:request.evidence?.run_id??request.evidence?.runId??request.run_id;assert.ok(run,'request must identify the local evidence run');
  const saved=await f.note(PRIVATE_FACT,'--evidence',run);assert.equal(saved.evidence.length,1);assert.ok(words(saved.evidence).includes(run));
  const record=(await f.show()).records[0];assert.deepEqual(record.evidence,saved.evidence);
  const another=await f.cli('note','--stack','billing','--env','sandbox','--scope','account','Documented: sandbox has a separate account.','--evidence',run,'--json');
  assert.notEqual(another.code,0,'account evidence from another environment must be refused');
  assert.equal((await f.show('billing','sandbox')).records.length,0);
});

test('CONTEXT-2b CLI private notes still refuse credential-shaped text before writing',async t=>{
  const f=await fixture(t),token='sk_live_'+('q7'.repeat(18));
  const result=await f.cli('note','--stack','billing','--env','staging','--scope','account','Observed: credential '+token,'--json');
  assert.equal(result.code,2,result.stdout+result.stderr);assert.match(words(result.value),/SECRET_IN_NOTE/);
  assert.equal((await f.show()).records.length,0);
  for(const path of walk(join(f.root,PROJECT_DIR_NAME)))assert.ok(!readFileSync(path,'utf8').includes(token));
});

test('CONTEXT-2b shared account history survives ordinary writers without becoming unscoped guidance',async t=>{
  const f=await fixture(t),text='This shared account cannot access organization reports.';
  const saved=await f.note(text,'--shared');
  const accountHistory=()=>JSON.parse(readFileSync(fixtureContextFile(f.root,'billing'),'utf8')).account_facts;
  const original=accountHistory();
  await f.json('connect','--no-skills','--json');
  await f.json('init','--stack','billing','--agents','--json');
  await f.json('learn','--stack','billing','--env','staging','--json');
  await f.json('note','--stack','billing','GET /health','Documented: health is read-only.','--json');
  await f.request();
  assert.deepEqual(accountHistory(),original,'shared account history must survive unrelated writes unchanged');
  assert.equal((await f.show()).records[0].id,saved.note_id);
  for(const entry of f.committable().filter(entry=>/AGENTS\.md|CLAUDE\.md|README\.md/.test(entry.path)))
    assert.ok(!entry.text.includes(text),'account-specific guidance leaked into '+entry.path);
  assert.ok(!words(await f.json('show','--stack','billing')).includes(text));
  assert.ok(!words(await f.json('map','--json')).includes(text));
  await f.json('view','--out','account-view.html','--json');
  assert.ok(!readFileSync(join(f.root,'account-view.html'),'utf8').includes(text));
  const copy=await f.note(text);assert.equal(copy.shared,false,'omitting --shared explicitly creates private scope');
  const rows=(await f.show()).records;
  assert.equal(rows.length,2);assert.deepEqual(rows.map(row=>row.shared).sort(),[false,true]);
});
