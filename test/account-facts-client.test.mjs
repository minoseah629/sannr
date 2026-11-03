import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureStack } from './helpers/stack-fixture.mjs';
import { resolveStack } from '../lib/stacks.mjs';
import { HOME_ENV_NAME } from '../lib/brand.mjs';

async function fixture(t, { scheme = 'bearer:ACCOUNT_FIXTURE_TOKEN', budget = 16000, off = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'account-facts-client-'));
  mkdirSync(join(root, 'home'));
  const previousMachine = process.env[HOME_ENV_NAME];
  process.env[HOME_ENV_NAME] = join(root, 'machine');
  t.after(() => { if (previousMachine === undefined) delete process.env[HOME_ENV_NAME]; else process.env[HOME_ENV_NAME] = previousMachine; });
  const server = spawn(process.execPath, ['--input-type=module', '-e', `
    import {createServer} from 'node:http';
    const server=createServer((req,res)=>{ const respond=()=>{res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify(req.url==='/token'?{access_token:'synthetic-oauth-access',token_type:'Bearer',expires_in:3600}:req.url.includes('/rpc')?{jsonrpc:'2.0',id:'probe',result:{ok:true}}:{ok:true})); }; if(req.url.includes('/slow')){process.send({delayed:true});setTimeout(respond,80);}else respond(); });
    server.listen(0,'127.0.0.1',()=>process.send({origin:'http://127.0.0.1:'+server.address().port}));
    process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit());});
  `], {stdio:['ignore','ignore','pipe','ipc']});
  const children=[server];
  t.after(async()=>{for(const child of children)if(child.exitCode===null){const end=once(child,'exit');child.kill();await end;}rmSync(root,{recursive:true,force:true});});
  const [{origin}] = await once(server,'message');
  const aFile=join(root,'a.env'), bFile=join(root,'b.env');
  const writeCredential=(file,token)=>writeFileSync(file,`ACCOUNT_FIXTURE_TOKEN=${token}\nACCOUNT_FIXTURE_USER=synthetic-user\nACCOUNT_FIXTURE_PASS=${token}\nACCOUNT_FIXTURE_ID=synthetic-client\nACCOUNT_FIXTURE_SECRET=${token}\n`);
  writeCredential(aFile,'synthetic-account-a');writeCredential(bFile,'synthetic-account-b');
  const environmentConfig={auth:scheme,envFile:aFile,tokenUrl:origin+'/token'};
  createFixtureStack(root,{name:'one',environments:{local:{baseUrl:origin+'/a',...environmentConfig},
    staging:{baseUrl:origin+'/a',...environmentConfig,envFile:bFile}}});
  createFixtureStack(root,{name:'two',baseUrl:origin+'/a',environmentConfig:{...environmentConfig,envFile:bFile}});
  const library=await import('../lib/account-facts.mjs');
  function note(text,{stack='one',environment='local',shared=false}={}) {
    const scope=resolveStack(root,{stack,environment});
    return library.writeAccountFact(root,{scope,text,shared,relation:{alongside:true},stamp:{by:'agent',at:'2026-10-09T00:00:00.000Z'}});
  }
  const clientUrl=process.env.ACCOUNT_CLIENT_SOURCE ?? new URL('../lib/client.mjs',import.meta.url).href;
  const proc=spawn(process.execPath,['--input-type=module','-e',`import {apiRequest} from ${JSON.stringify(clientUrl)};
    process.on('message', async args => {try{process.send({result:await apiRequest(args)});}catch(error){process.send({error:error.stack});}});
    process.send({ready:true});`],{cwd:root,env:{PATH:process.env.PATH,HOME:join(root,'home'),[HOME_ENV_NAME]:join(root,'machine'),
      API_CONTEXT_DIR:root,API_FRICTION_OFF:'1',API_USAGE_LOG:join(root,'usage.jsonl'),API_BUDGET:String(budget),...(off?{API_CONTEXT_OFF:'1'}:{})},stdio:['ignore','ignore','pipe','ipc']});
  children.unshift(proc);
  let stderr='';proc.stderr.on('data',b=>stderr+=b);
  await once(proc,'message');
  const request=async args=>{const answer=once(proc,'message');proc.send({stack:'one',path:'/items',expect:[{status:200}],...args});
    const [{result,error}]=await answer;assert.equal(error,undefined,stderr);return result;};
  return {root,origin,note,request,waitDelayed:()=>once(server,'message'),rotate:(token='synthetic-account-next')=>writeCredential(aFile,token)};
}

const records = out => out.known?.account_facts?.records ?? [];

test('CONTEXT-2b account-only knowledge is labeled and isolated by stack, environment and primary target',async t=>{
  const f=await fixture(t);
  f.note('This credential belongs to a trial account.');
  f.note('The other stack has a separate account.',{stack:'two'});
  f.note('The staging credential has a separate limit.',{environment:'staging'});
  const one=await f.request({capture_context:false});
  assert.deepEqual(records(one).map(row=>row.text),['This credential belongs to a trial account.']);
  assert.equal(one.known.notes,undefined,'private account facts are not unlabeled universal notes');
  assert.equal(records(one)[0].at,'2026-10-09T00:00:00.000Z');
  assert.equal(records(one)[0].credential_state,'confirmed');
  assert.equal(records(one)[0].credential_reference,'bearer:ACCOUNT_FIXTURE_TOKEN');
  assert.deepEqual(records(await f.request({stack:'two'})).map(row=>row.text),['The other stack has a separate account.']);
  assert.deepEqual(records(await f.request({environment:'staging'})).map(row=>row.text),['The staging credential has a separate limit.']);
  assert.equal(records(await f.request({path:f.origin+'/sibling/items'})).length,0,'same origin and credential reference do not authorize sibling provider facts');
  assert.equal(records(await f.request({path:f.origin+'/a-unrelated/items'})).length,0,'base-path matching stays segment bounded');
});

test('CONTEXT-2b the same live client sees credential rotation without changing another environment and reconfirms only by a write',async t=>{
  const f=await fixture(t);
  f.note('The trial account cannot use organization endpoints.');
  f.note('Staging account fact.',{environment:'staging'});
  assert.equal(records(await f.request())[0]?.credential_state,'confirmed');
  f.rotate();
  assert.equal(records(await f.request())[0]?.credential_state,'changed');
  assert.equal(records(await f.request({environment:'staging'}))[0]?.credential_state,'confirmed');
  assert.equal(records(await f.request({capture_context:false}))[0]?.credential_state,'changed');
  f.note('The trial account cannot use organization endpoints.');
  assert.equal(records(await f.request())[0]?.credential_state,'confirmed');
});

test('CONTEXT-2b header, query, Basic and OAuth credential references deliver and detect drift without leaking values',async t=>{
  for(const scheme of ['header:X-Api-Key:ACCOUNT_FIXTURE_TOKEN','query:key:ACCOUNT_FIXTURE_TOKEN',
    'basic:ACCOUNT_FIXTURE_USER:ACCOUNT_FIXTURE_PASS','oauth:ACCOUNT_FIXTURE_ID:ACCOUNT_FIXTURE_SECRET'])await t.test(scheme,async t=>{
      const f=await fixture(t,{scheme});f.note('This credential belongs to a trial account.');
      const first=await f.request();assert.equal(first.status,200);assert.equal(records(first)[0]?.credential_state,'confirmed');
      assert.equal(records(first)[0]?.credential_reference,scheme.replace('X-Api-Key','x-api-key'));
      f.rotate();const second=await f.request();assert.equal(records(second)[0]?.credential_state,'changed');
      for(const value of ['synthetic-account-a','synthetic-account-next','synthetic-oauth-access'])assert.equal(JSON.stringify(second).includes(value),false);
    });
});

test('CONTEXT-2b account-fact caps and a small request budget preserve exact recovery and changed-credential warning',async t=>{
  const f=await fixture(t,{budget:650});
  for(let n=0;n<8;n++)f.note(`Trial account restriction ${n}: ${'Read the account permission configuration. '.repeat(8)}`);
  f.rotate();const out=await f.request({capture_context:false});
  const receipt=out.known?.account_facts;assert.ok(receipt,'fact-only context survives compaction');
  assert.equal(receipt.total,8);assert.equal(receipt.shown,receipt.records?.length??0);
  assert.equal(receipt.omitted,8-receipt.shown);assert.ok(receipt.omitted>0);
  assert.match(receipt.show_command,/show --stack one --env local --scope account/);
  assert.ok(records(out).some(row=>row.credential_state==='changed')||receipt.credential_changed>0,'omissions must not erase credential drift');
  assert.ok(Math.ceil(JSON.stringify(out).length/4)<=650 || out.budget_min,'budget is bounded or names mandatory minimum');
});

test('CONTEXT-2b API_CONTEXT_OFF suppresses private and shared account delivery',async t=>{
  const f=await fixture(t,{off:true});f.note('Private account guidance.');f.note('Shared account guidance.',{shared:true});
  assert.equal((await f.request()).known,null);
});


test('CONTEXT-2b protocol requests receive labeled account facts and preserve their recovery receipt under budget',async t=>{
  const f=await fixture(t,{budget:800});
  f.note('RPC access is restricted to the trial account.');
  const args={protocol:'jsonrpc',path:'/rpc',rpc:{method:'account.read',id:'probe'},capture_context:false};
  const out=await f.request(args);assert.equal(out.status,200);assert.equal(out.ok,true);
  assert.equal(records(out)[0]?.text,'RPC access is restricted to the trial account.');
  assert.equal(records(await f.request({...args,path:f.origin+'/sibling/rpc'})).length,0);
  for(let n=0;n<8;n++)f.note(`RPC account limit ${n}: ${'Use the trial project. '.repeat(15)}`);
  f.rotate();const small=await f.request(args);const receipt=small.known?.account_facts;
  assert.equal(receipt.total,9);assert.equal(receipt.omitted,9-receipt.shown);
  assert.match(receipt.show_command,/show --stack one --env local --scope account/);
  assert.ok(receipt.credential_changed>0);assert.ok(Math.ceil(JSON.stringify(small).length/4)<=800||small.budget_min);
});


test('CONTEXT-2b an in-flight credential rotation is compared with the credential actually dispatched',async t=>{
  const f=await fixture(t);f.note('This credential belongs to a trial account.');
  const waiting=f.waitDelayed();const pending=f.request({path:'/slow',capture_context:false});
  await waiting;f.rotate();
  assert.equal(records(await pending)[0]?.credential_state,'confirmed','response belongs to the original credential');
  assert.equal(records(await f.request())[0]?.credential_state,'changed','next dispatch sees rotated file');
});

test('CONTEXT-2b a refused request keeps bounded account recovery instead of unbounded private notes',async t=>{
  const f=await fixture(t,{budget:500});
  for(let n=0;n<8;n++)f.note(`Account limit ${n}: ${'Read account permission settings. '.repeat(20)}`);
  f.rotate();const out=await f.request({headers:{authorization:'Bearer literal-synthetic-value'}});
  assert.equal(out.mode,'refused');assert.equal(out.known.account_facts.total,8);
  assert.ok(out.known.account_facts.omitted>0);assert.ok(out.known.account_facts.credential_changed>0);
  assert.match(out.known.account_facts.show_command,/show --stack one --env local --scope account/);
  assert.ok(Math.ceil(JSON.stringify(out).length/4)<=500||out.budget_min);
});


test('CONTEXT-2b a missing configured credential leaves its saved limitation visible on HTTP and protocol refusals',async t=>{
  const f=await fixture(t);f.note('This credential is limited to the trial account.');f.rotate('');
  const http=await f.request();assert.equal(records(http)[0]?.credential_state,'missing');
  const rpc=await f.request({protocol:'jsonrpc',path:'/rpc',rpc:{method:'account.read',id:'probe'}});
  assert.equal(rpc.error?.code,'AUTH_ENV_MISSING');assert.equal(records(rpc)[0]?.credential_state,'missing');
});

test('CONTEXT-2b an unreadable account store is named without changing the request outcome or exposing its contents',async t=>{
  const f=await fixture(t);const note=f.note('This account has a trial restriction.');
  writeFileSync(join(f.root,note.file),'{not valid private data');
  for(const args of [{},{protocol:'jsonrpc',path:'/rpc',rpc:{method:'account.read',id:'probe'}}]){
    const out=await f.request(args);assert.equal(out.status,200);assert.equal(out.ok,true);
    assert.deepEqual(out.known.account_facts.issues,[{code:'ACCOUNT_FACTS_UNAVAILABLE'}]);
    assert.match(out.known.account_facts.show_command,/show --stack one --env local --scope account/);
    assert.equal(JSON.stringify(out).includes('not valid private data'),false);
  }
});
