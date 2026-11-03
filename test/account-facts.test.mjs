import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { resolveStack } from '../lib/stacks.mjs';
import { HOME_ENV_NAME } from '../lib/brand.mjs';
import { noteEntries } from '../lib/note-key.mjs';

const stamp={by:'agent',at:'2026-10-09'};
const old='synthetic-account-first-value',next='synthetic-account-second-value';
const load=()=>import('../lib/account-facts.mjs');
function allFiles(root){return readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isDirectory()?allFiles(join(root,e.name)):[join(root,e.name)]);}
function fixture(t,{auth='bearer:ACCOUNT_FIXTURE_TOKEN'}={}){
  const root=mkdtempSync(join(tmpdir(),'account-facts-')), previous={...process.env};
  for(const key of Object.keys(process.env))if(key.startsWith('API_'))delete process.env[key];
  process.env[HOME_ENV_NAME]=join(root,'machine'); process.env.ACCOUNT_FIXTURE_TOKEN=old;
  process.env.ACCOUNT_FIXTURE_USER='fixture-user';process.env.ACCOUNT_FIXTURE_PASSWORD=old;
  t.after(()=>{for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);rmSync(root,{recursive:true,force:true});});
  for(const name of ['one','two'])createFixtureStack(root,{name,baseUrl:'https://example.test',environments:{local:{baseUrl:'https://example.test',auth},other:{baseUrl:'https://example.test',auth}}});
  for(const name of ['one','two'])writeFileSync(fixtureContextFile(root,name),JSON.stringify({v:0,operations:{}}));
  const scope=(stack='one',environment='local')=>resolveStack(root,{stack,environment});
  return {root,scope,folder:join(root,'.sannr/evidence/one/account-facts'),store:fixtureContextFile(root,'one')};
}

test('CONTEXT-2b private facts use existing note history, private modes and ignored evidence; no shared promotion',async t=>{
 const f=fixture(t),{writeAccountFact,readAccountFacts}=await load(),before=readFileSync(f.store,'utf8');
 const result=writeAccountFact(f.root,{scope:f.scope(),text:'Trial account.',stamp});
 assert.equal(result.shared,false);assert.equal(readFileSync(f.store,'utf8'),before);assert.match(readFileSync(join(f.root,'.sannr/.gitignore'),'utf8'),/\/evidence\//);
 assert.equal(statSync(f.folder).mode&0o777,0o700);assert.equal(statSync(join(f.root,'machine')).mode&0o777,0o700);
 for(const path of allFiles(f.folder))assert.equal(statSync(path).mode&0o777,0o600,path);
 const receipt=readAccountFacts(f.root,{scope:f.scope()});assert.equal(receipt.total,1);assert.equal(receipt.records[0].text,'Trial account.');assert.equal(receipt.records[0].credential_state,'confirmed');assert.equal(receipt.records[0].at,stamp.at);
 assert.match(receipt.show_command,/show --stack one --env local --scope account/);
});
test('CONTEXT-2b account facts stay scoped by stack, environment and canonical credential reference',async t=>{
 const f=fixture(t),{writeAccountFact,readAccountFacts}=await load();writeAccountFact(f.root,{scope:f.scope(),text:'Trial account.',stamp});
 assert.equal(readAccountFacts(f.root,{scope:f.scope('two')}).total,0);assert.equal(readAccountFacts(f.root,{scope:f.scope('one','other')}).total,0);
 assert.equal(readAccountFacts(f.root,{scope:f.scope(),config:{...f.scope().config,auth:'bearer:OTHER_ACCOUNT_TOKEN'}}).total,0);
 const basic=fixture(t,{auth:'basic:ACCOUNT_FIXTURE_USER:ACCOUNT_FIXTURE_PASSWORD'});writeAccountFact(basic.root,{scope:basic.scope(),text:'Basic account.',stamp});
 assert.equal(readAccountFacts(basic.root,{scope:basic.scope()}).records[0].credential_reference,'basic:ACCOUNT_FIXTURE_USER:ACCOUNT_FIXTURE_PASSWORD');
});
test('CONTEXT-2b credential drift sticks across rotation back and only explicit repeat reconfirms that note',async t=>{
 const f=fixture(t),{writeAccountFact,readAccountFacts}=await load();
 const a=writeAccountFact(f.root,{scope:f.scope(),text:'Trial account.',stamp});writeAccountFact(f.root,{scope:f.scope(),text:'Organization access is restricted.',stamp,relation:{alongside:true}});
 process.env.ACCOUNT_FIXTURE_TOKEN=next;assert.ok(readAccountFacts(f.root,{scope:f.scope()}).records.every(r=>r.credential_state==='changed'));
 process.env.ACCOUNT_FIXTURE_TOKEN=old;assert.ok(readAccountFacts(f.root,{scope:f.scope()}).records.every(r=>r.credential_state==='changed'));
 const same=writeAccountFact(f.root,{scope:f.scope(),text:'Trial account.',stamp});assert.equal(same.note_id,a.note_id);assert.equal(same.unchanged,true);assert.equal(same.reconfirmed,true);
 const receipt=readAccountFacts(f.root,{scope:f.scope()});assert.equal(receipt.total,2);assert.equal(receipt.records.find(r=>r.id===a.note_id).credential_state,'confirmed');assert.equal(receipt.records.find(r=>r.id!==a.note_id).credential_state,'changed');
});
test('CONTEXT-2b sharing writes reference-only scope; another machine never auto-confirms shared notes',async t=>{
 const f=fixture(t),{writeAccountFact,readAccountFacts}=await load();writeAccountFact(f.root,{scope:f.scope(),text:'Shared trial account.',stamp,shared:true});
 const ctx=JSON.parse(readFileSync(f.store,'utf8'));assert.equal(Object.keys(ctx.account_facts).length,1);assert.equal(noteEntries(ctx).some(r=>r.key.kind==='account'),false);
 assert.match(JSON.stringify(ctx.account_facts),/bearer:ACCOUNT_FIXTURE_TOKEN/);assert.doesNotMatch(JSON.stringify(ctx.account_facts),/fingerprint|salt|hmac/);
 process.env[HOME_ENV_NAME]=join(f.root,'other-machine');assert.equal(readAccountFacts(f.root,{scope:f.scope()}).records[0].credential_state,'unconfirmed');assert.equal(existsSync(join(f.root,'other-machine')),false);
 const res=writeAccountFact(f.root,{scope:f.scope(),text:'Shared trial account.',stamp,shared:true});assert.equal(res.reconfirmed,true);assert.equal(readAccountFacts(f.root,{scope:f.scope()}).records[0].credential_state,'confirmed');
});
test('CONTEXT-2b no credential value or unsalted hash is stored or returned; exact value-shaped innocent text is refused',async t=>{
 const f=fixture(t),{writeAccountFact,readAccountFacts}=await load();writeAccountFact(f.root,{scope:f.scope(),text:'Trial account.',stamp});
 const bytes=allFiles(f.root).map(p=>readFileSync(p,'utf8')).join('')+JSON.stringify(readAccountFacts(f.root,{scope:f.scope()}));
 for(const secret of [old,createHash('sha256').update(old).digest('hex')])assert.equal(bytes.includes(secret),false);
 assert.throws(()=>writeAccountFact(f.root,{scope:f.scope(),text:`The reference is ${old}.`,stamp,relation:{alongside:true}}),{code:'SECRET_IN_NOTE'});
});
test('CONTEXT-2b private history requires explicit relationship and preserves superseded records',async t=>{
 const f=fixture(t),{writeAccountFact,readAccountFacts}=await load();const a=writeAccountFact(f.root,{scope:f.scope(),text:'Trial account.',stamp});
 assert.throws(()=>writeAccountFact(f.root,{scope:f.scope(),text:'Paid account.',stamp}),{code:'NOTE_RELATION_REQUIRED'});
 writeAccountFact(f.root,{scope:f.scope(),text:'Paid account.',stamp,relation:{supersedes:a.note_id}});
 assert.equal(readAccountFacts(f.root,{scope:f.scope()}).records[0].text,'Paid account.');const all=readAccountFacts(f.root,{scope:f.scope(),history:true});assert.equal(all.records.length,2);assert.equal(all.records.find(r=>r.id===a.note_id).superseded,true);
});
test('CONTEXT-2b missing auth refuses writes and unavailable credentials never confirm notes',async t=>{
 const f=fixture(t),{writeAccountFact,readAccountFacts}=await load();writeAccountFact(f.root,{scope:f.scope(),text:'Trial account.',stamp});delete process.env.ACCOUNT_FIXTURE_TOKEN;
 assert.equal(readAccountFacts(f.root,{scope:f.scope()}).records[0].credential_state,'missing');assert.throws(()=>writeAccountFact(f.root,{scope:f.scope(),text:'Trial account.',stamp}),{code:'ACCOUNT_CREDENTIAL_MISSING'});
 assert.throws(()=>writeAccountFact(f.root,{scope:{...f.scope(),config:{...f.scope().config,auth:undefined}},text:'Trial account.',stamp}),{code:'ACCOUNT_AUTH_REQUIRED'});
});
test('CONTEXT-2b symlinked machine salt and private folders are refused without touching targets',async t=>{
 const f=fixture(t),{writeAccountFact,readAccountFacts}=await load();const outside=join(f.root,'outside');mkdirSync(outside);symlinkSync(outside,join(f.root,'machine'));
 assert.throws(()=>writeAccountFact(f.root,{scope:f.scope(),text:'Trial account.',stamp}),{code:'ACCOUNT_UNSAFE_PATH'});assert.deepEqual(readdirSync(outside),[]);
 rmSync(join(f.root,'machine'));mkdirSync(join(f.root,'.sannr/evidence/one'),{recursive:true});symlinkSync(outside,f.folder);
 assert.throws(()=>writeAccountFact(f.root,{scope:f.scope(),text:'Trial account.',stamp}),{code:'ACCOUNT_UNSAFE_PATH'});
 assert.throws(()=>readAccountFacts(f.root,{scope:f.scope()}),{code:'ACCOUNT_UNSAFE_PATH'});assert.deepEqual(readdirSync(outside),[]);
});

test('CONTEXT-2b credential files rotate without host restart and reads may use the request credential snapshot',async t=>{
 const f=fixture(t),{writeAccountFact,readAccountFacts}=await load();delete process.env.ACCOUNT_FIXTURE_TOKEN;
 const env=join(f.root,'fixture.env');writeFileSync(env,`ACCOUNT_FIXTURE_TOKEN=${old}\n`);
 const scope={...f.scope(),config:{...f.scope().config,credentialEnvFiles:[env]}};
 writeAccountFact(f.root,{scope,text:'Trial account.',stamp});writeFileSync(env,`ACCOUNT_FIXTURE_TOKEN=${next}\n`);
 assert.equal(readAccountFacts(f.root,{scope,credentials:{ACCOUNT_FIXTURE_TOKEN:old}}).records[0].credential_state,'confirmed');
 assert.equal(readAccountFacts(f.root,{scope}).records[0].credential_state,'changed');
});
test('CONTEXT-2b malformed confirmation never creates a baseline and refuses destructive write recovery',async t=>{
 const f=fixture(t),{writeAccountFact,readAccountFacts}=await load();writeAccountFact(f.root,{scope:f.scope(),text:'Trial account.',stamp});
 const path=join(f.folder,readdirSync(f.folder).find(name=>name.endsWith('.confirmation.json')));writeFileSync(path,'not json');
 const read=readAccountFacts(f.root,{scope:f.scope()});assert.equal(read.records[0].credential_state,'unconfirmed');assert.ok(read.issues.includes('ACCOUNT_CONFIRMATION_UNAVAILABLE'));assert.equal(readFileSync(path,'utf8'),'not json');
 assert.throws(()=>writeAccountFact(f.root,{scope:f.scope(),text:'Trial account.',stamp}),{code:'ACCOUNT_STATE_INVALID'});
});
test('CONTEXT-2b shared account history cannot be dropped through an ordinary context write',async t=>{
 const f=fixture(t),{writeAccountFact}=await load();writeAccountFact(f.root,{scope:f.scope(),text:'Shared trial account.',stamp,shared:true});
 const {loadContext,saveContext}=await import('../lib/context.mjs'),{withStackScope}=await import('../lib/stack-scope.mjs');
 withStackScope(f.scope(),()=>{const ctx=loadContext(f.root);delete ctx.account_facts;assert.throws(()=>saveContext(f.root,ctx),{code:'NOTE_HISTORY_PROTECTED'});});
});
test('CONTEXT-2b explicit output cap retains total drift count, and metadata cannot echo a current credential',async t=>{
 const f=fixture(t),{writeAccountFact,readAccountFacts}=await load();
 writeAccountFact(f.root,{scope:f.scope(),text:'Trial account.',stamp:{by:'synthetic-author',at:stamp.at}});
 writeAccountFact(f.root,{scope:f.scope(),text:'Organization access is restricted.',stamp,relation:{alongside:true}});
 process.env.ACCOUNT_FIXTURE_TOKEN='synthetic-author';
 const read=readAccountFacts(f.root,{scope:f.scope(),maxFacts:1});assert.equal(read.records.length,1);assert.equal(read.credential_changed,2);assert.equal(read.omitted,1);assert.equal(JSON.stringify(read).includes('synthetic-author'),false);
});

test('CONTEXT-2b changed authored history is withheld from delivery and remains inspectable with history',async t=>{
 const f=fixture(t),{writeAccountFact,readAccountFacts}=await load();const result=writeAccountFact(f.root,{scope:f.scope(),text:'Trial account.',stamp});
 const file=join(f.root,result.file),ctx=JSON.parse(readFileSync(file,'utf8'));Object.values(ctx.account_facts)[0].notes[0]='Hand-edited claim.';writeFileSync(file,JSON.stringify(ctx));
 const normal=readAccountFacts(f.root,{scope:f.scope()});assert.equal(normal.records.length,0);assert.ok(normal.issues.includes('ACCOUNT_NOTE_HISTORY_INVALID'));
 const history=readAccountFacts(f.root,{scope:f.scope(),history:true});assert.equal(history.records[0].text,'Hand-edited claim.');assert.equal(history.records[0].credential_state,'unconfirmed');
});

test('CONTEXT-2b credential literals in provenance are refused before even creating private state',async t=>{
 const f=fixture(t),{writeAccountFact}=await load();const before=readFileSync(f.store,'utf8');
 assert.throws(()=>writeAccountFact(f.root,{scope:f.scope(),text:'Trial account.',stamp:{by:old,at:stamp.at},shared:true}),{code:'SECRET_IN_NOTE'});
 assert.equal(readFileSync(f.store,'utf8'),before);assert.equal(existsSync(f.folder),false);assert.equal(existsSync(join(f.root,'machine')),false);
});
test('CONTEXT-2b malformed or dangling private links are refused even if their targets are absent',async t=>{
 const f=fixture(t),{writeAccountFact,readAccountFacts}=await load();const result=writeAccountFact(f.root,{scope:f.scope(),text:'Trial account.',stamp});
 const file=join(f.root,result.file);rmSync(file);symlinkSync(join(f.root,'does-not-exist'),file);
 assert.throws(()=>readAccountFacts(f.root,{scope:f.scope()}),{code:'ACCOUNT_UNSAFE_PATH'});
});

test('CONTEXT-2b write receipts and refusal excerpts mask a value that later becomes the credential',async t=>{
 const f=fixture(t),{writeAccountFact}=await load();
 writeAccountFact(f.root,{scope:f.scope(),text:'Trial account.',stamp:{by:'synthetic-author',at:stamp.at}});
 process.env.ACCOUNT_FIXTURE_TOKEN='synthetic-author';const duplicate=writeAccountFact(f.root,{scope:f.scope(),text:'Trial account.',stamp});
 assert.equal(JSON.stringify(duplicate).includes('synthetic-author'),false);assert.match(JSON.stringify(duplicate),/credential withheld/);
 process.env.ACCOUNT_FIXTURE_TOKEN=old;
 writeAccountFact(f.root,{scope:f.scope(),text:'The special tier is synthetic-tier-name.',stamp,relation:{alongside:true}});
 process.env.ACCOUNT_FIXTURE_TOKEN='synthetic-tier-name';
 try { writeAccountFact(f.root,{scope:f.scope(),text:'Another account claim.',stamp});assert.fail('relationship must be explicit'); }
 catch(error){assert.equal(error.code,'NOTE_RELATION_REQUIRED');assert.equal(JSON.stringify(error.existing).includes('synthetic-tier-name'),false);}
});

test('CONTEXT-2b sharing requires an explicit boolean opt-in at the writer boundary',async t=>{
 const f=fixture(t),{writeAccountFact}=await load();const before=readFileSync(f.store,'utf8');
 for(const shared of ['false','true',1,{},null])assert.throws(()=>writeAccountFact(f.root,{scope:f.scope(),text:'This claim must remain private.',stamp,shared}),{code:'ACCOUNT_SHARING_INVALID'});
 assert.equal(readFileSync(f.store,'utf8'),before);assert.equal(existsSync(f.folder),false);
});
