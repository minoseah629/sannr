// R7 fixtures use declared example.test origins, disposable files and no traffic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { LAYOUT } from '../lib/layout.mjs';
import { CONTEXT_BASENAME } from '../lib/brand.mjs';
import { operationId } from '../lib/operation-context.mjs';
import { planStackMigration, applyStackMigration, moveStackOperation } from '../lib/stack-migration.mjs';
import { stackScope } from '../lib/stacks.mjs';
const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const write = (root,path,value,mode) => { mkdirSync(dirname(join(root,path)),{recursive:true}); writeFileSync(join(root,path),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{mode}); };
const read = (root,path) => JSON.parse(readFileSync(join(root,path),'utf8'));
const stackFile = name => `${LAYOUT.collection}/${name}/stack.json`;
const storeFile = name => `${LAYOUT.collection}/${name}/${CONTEXT_BASENAME}`;
function failReadback(path,fn,when=()=>true) {
 const original={openSync:fs.openSync,closeSync:fs.closeSync,readSync:fs.readSync},files=new Map();let injected=false;
 fs.openSync=(file,...args)=>{const fd=original.openSync(file,...args);files.set(fd,String(file));return fd;};
 fs.closeSync=fd=>{files.delete(fd);return original.closeSync(fd);};
 fs.readSync=(fd,buffer,...args)=>{const size=original.readSync(fd,buffer,...args);if(!injected&&files.get(fd)===path&&when(buffer.subarray(0,size).toString('utf8'))&&size){buffer[0]^=1;injected=true;}return size;};
 syncBuiltinESMExports();try{return fn();}finally{Object.assign(fs,original);syncBuiltinESMExports();assert.equal(injected,true,'The destination readback fault was exercised.');}
}
function fixture(t) { const root=realpathSync(mkdtempSync(join(tmpdir(),'stacks-migration-engine-'))); t.after(()=>rmSync(root,{recursive:true,force:true})); return root; }
function contract(root,path,title='Billing API',route='/users') { write(root,path,{openapi:'3.0.3',info:{title,version:'1'},paths:{[route]:{get:{responses:{200:{description:'OK'}}}}}}); return hash(readFileSync(join(root,path))); }
function store(root,operations={},records={}) { write(root,LAYOUT.context,{v:0,api:{name:'Billing API',contract:'contracts/billing.json',contract_digest:null},generated_at:'2026-10-07',operations,api_context:{v:1,operations:records}}); }
function record(root,{environment='production',provider='https://billing.example.test',operation='GET /users',run='run-billing',contractDigest=null}={}) { const identity={provider,environment,protocol:'http',operation,endpoint:`${provider}/users`,contractDigest}; const evidencePath=`${LAYOUT.evidence}/${run}.json`; const bytes=JSON.stringify({runId:run,request:{url:`${provider}/users?tenant=private-query-value`},response:{status:200,body:{value:'private-evidence-value'}}}); write(root,evidencePath,bytes,0o600); return [operationId(identity),{identity,observations:[{id:'obs-a',recorded_at:'2026-10-07T01:00:00.000Z',observed_at:'2026-10-07T01:00:00.000Z',basis:'observed',source:{kind:'client',tool:'api_request:http'},verification:'client-observation',outcome:'success',complete:true,evidence:[{path:evidencePath,digest:hash(bytes)}],notes:[],omissions:[]}],omitted_observations:0}]; }
function motivating(t) { const root=fixture(t),digest=contract(root,'contracts/billing.json'); write(root,LAYOUT.environments,{v:1,default:'production',environments:{production:{baseUrl:'https://billing.example.test',contract:'contracts/billing.json',auth:'bearer:BILLING_KEY'},npm:{baseUrl:'https://downloads.example.test',auth:'bearer:DOWNLOADS_KEY'}}}); const a=record(root,{contractDigest:digest}); const b=record(root,{environment:'npm',provider:'https://downloads.example.test',operation:'GET /downloads',run:'run-downloads'}); const note={verified_at:null,status_codes:[],fields:{},notes:['Review the download count before making a decision.'],notes_provenance:[{by:'agent',at:'2026-10-07'}],notes_superseded:[null]}; store(root,{'GET /users':{verified_at:null,fields:{},notes:[]},'GET /downloads':note},Object.fromEntries([a,b])); return {root,note}; }

test('R7 a dry run suggests the origin-and-contract split and writes nothing; an explicit split routes knowledge and evidence',t=>{ const {root,note}=motivating(t); const before=readFileSync(join(root,LAYOUT.context)); const dry=planStackMigration(root); assert.ok(dry.suggestions.some(s=>s.argument==='--split npm=npm')); assert.equal(existsSync(join(root,stackFile('billing'))),false); assert.deepEqual(readFileSync(join(root,LAYOUT.context)),before); assert.doesNotMatch(JSON.stringify(dry),/private-query-value|private-evidence-value/); const plan=planStackMigration(root,{splits:['npm=npm']}); assert.ok(plan.issues.some(i=>i.code==='MIGRATION_OPERATION_UNSORTED'&&i.operation==='GET /downloads')); const result=applyStackMigration(plan); assert.equal(result.requests_executed,0); assert.deepEqual(read(root,storeFile('unsorted')).operations['GET /downloads'],note); assert.deepEqual(Object.keys(read(root,storeFile('billing')).operations),['GET /users']); assert.deepEqual(Object.keys(read(root,stackFile('npm')).environments),['npm']); assert.equal(existsSync(join(root,LAYOUT.context)),false); assert.equal(existsSync(join(root,LAYOUT.config)),false); for(const [name,run] of [['billing','run-billing'],['npm','run-downloads']]) { const entries=Object.values(read(root,storeFile(name)).api_context.operations); assert.equal(entries[0].identity.stack,name); assert.ok(entries[0].observations[0].evidence[0].path.includes(`/evidence/${name}/`)); assert.match(readFileSync(join(root,`${LAYOUT.evidence}/${name}/${run}.json`),'utf8'),/private-evidence-value/); assert.equal(statSync(join(root,`${LAYOUT.evidence}/${name}/${run}.json`)).mode&0o777,0o600); assert.doesNotMatch(readFileSync(join(root,storeFile(name)),'utf8'),/private-query-value|private-evidence-value/); } const moved=moveStackOperation(root,{to:'npm',operation:'GET /downloads'}); assert.equal(moved.from,'unsorted'); assert.deepEqual(read(root,storeFile('npm')).operations['GET /downloads'],note); assert.equal(read(root,storeFile('unsorted')).operations['GET /downloads'],undefined); assert.equal(planStackMigration(root).state,'noop'); });

test('R7 a suggestions do not silently split environments',t=>{ const {root}=motivating(t); applyStackMigration(planStackMigration(root)); assert.deepEqual(Object.keys(read(root,stackFile('billing')).environments),['npm','production']); assert.equal(existsSync(join(root,stackFile('npm'))),false); });

test('R7 b shared-contract dev staging and prod remain one stack, with defaults moved',t=>{ const root=fixture(t); contract(root,'contracts/billing.json'); write(root,LAYOUT.environments,{v:1,default:'prod',defaults:{timeoutMs:1200},environments:Object.fromEntries(['dev','staging','prod'].map(name=>[name,{baseUrl:`https://${name}.example.test`,contract:'contracts/billing.json'}]))}); write(root,LAYOUT.defaults,{budget:900}); store(root,{'GET /users':{notes:[],fields:{}}}); applyStackMigration(planStackMigration(root)); const doc=read(root,stackFile('billing')); assert.deepEqual(Object.keys(doc.environments),['dev','prod','staging']); assert.equal(doc.default_environment,'prod'); assert.deepEqual(read(root,`${LAYOUT.directory}/defaults.json`),{budget:900,timeoutMs:1200,default_stack:'billing'}); assert.equal(existsSync(join(root,'contracts/billing.json')),false); assert.equal(existsSync(join(root,`${LAYOUT.collection}/billing/billing.json`)),true); });

test('R7 c top-level and environment-scoped hosts get independent references and contracts',t=>{ const root=fixture(t); contract(root,'contracts/a.json','A API','/a'); contract(root,'contracts/b.json','B API','/b'); write(root,LAYOUT.environments,{v:1,default:'prod',hosts:{alpha:{baseUrl:'https://alpha.example.test',auth:'bearer:ALPHA_KEY',contract:'contracts/a.json'}},environments:{prod:{baseUrl:'https://main.example.test',hosts:{beta:{baseUrl:'https://beta.example.test',auth:'bearer:BETA_KEY',contract:'contracts/b.json'}}}}}); store(root,{'GET /a':{notes:[],fields:{}},'GET /b':{notes:[],fields:{}}}); // No primary contract is bound in this fixture.
 const old=read(root,LAYOUT.context); delete old.api.contract; write(root,LAYOUT.context,old); applyStackMigration(planStackMigration(root)); assert.equal(read(root,stackFile('alpha')).environments.default.auth,'bearer:ALPHA_KEY'); assert.equal(read(root,stackFile('beta')).environments.prod.auth,'bearer:BETA_KEY'); assert.ok(read(root,storeFile('alpha')).operations['GET /a']); assert.ok(read(root,storeFile('beta')).operations['GET /b']); });

test('R7 duplicate global and default hosts compare effective env-file and contract references', t => {
 for (const references of ['env-file', 'contract', 'both']) {
  const root = fixture(t);
  const base = { baseUrl: 'https://alpha.example.test', auth: 'bearer:ALPHA_KEY' };
  const global = { ...base }, scoped = { ...base };
  if (references !== 'contract') { global.envFile = './secrets/alpha.env'; scoped.envFile = 'secrets/alpha.env'; }
  if (references !== 'env-file') {
   contract(root, 'contracts/alpha.json', 'Alpha API');
   global.contract = './contracts/alpha.json'; scoped.contract = 'contracts/alpha.json';
  }
  const config = { v: 1, default: 'default', hosts: { alpha: global },
   environments: { default: { baseUrl: 'https://main.example.test', hosts: { alpha: scoped } } } };
  write(root, LAYOUT.environments, config);
  const before = readFileSync(join(root, LAYOUT.environments));
  const plan = planStackMigration(root);
  assert.deepEqual(readFileSync(join(root, LAYOUT.environments)), before, 'planning leaves the input unchanged');
  applyStackMigration(plan);
  const migrated = read(root, stackFile('alpha'));
  assert.deepEqual(Object.keys(migrated.environments), ['default']);
  assert.equal(migrated.environments.default.auth, 'bearer:ALPHA_KEY');
  if (references !== 'contract') assert.equal(migrated.environments.default.envFile, '../../../secrets/alpha.env');
  if (references !== 'env-file') assert.equal(migrated.contract, 'alpha.json');
  assert.equal(planStackMigration(root).state, 'noop');
 }
 const root = fixture(t);
 write(root, LAYOUT.environments, { v: 1, default: 'default',
  hosts: { alpha: { baseUrl: 'https://alpha.example.test', envFile: './secrets/alpha.env' } },
  environments: { default: { baseUrl: 'https://main.example.test',
   hosts: { alpha: { baseUrl: 'https://alpha.example.test', envFile: 'secrets/different.env' } } } } });
 const before = readFileSync(join(root, LAYOUT.environments));
 assert.throws(() => planStackMigration(root), { code: 'MIGRATION_HOST_CONFLICT', details: { stack: 'alpha', environment: 'default' } });
 assert.deepEqual(readFileSync(join(root, LAYOUT.environments)), before);
 assert.equal(existsSync(join(root, stackFile('alpha'))), false, 'a real reference conflict writes no destination');
});

test('R7 copies shared contracts to each explicitly split stack and refuses ambiguous operation ownership',t=>{ const root=fixture(t); contract(root,'contracts/billing.json'); write(root,LAYOUT.environments,{v:1,default:'prod',environments:{prod:{baseUrl:'https://prod.example.test',contract:'contracts/billing.json'},dev:{baseUrl:'https://dev.example.test',contract:'contracts/billing.json'}}}); store(root,{'GET /users':{notes:['Keep the historical explanation.'],fields:{}}}); const plan=planStackMigration(root,{splits:['dev=dev']}); assert.ok(plan.issues.some(i=>i.code==='MIGRATION_OPERATION_AMBIGUOUS')); applyStackMigration(plan); for(const name of ['billing','dev']) assert.equal(existsSync(join(root,`${LAYOUT.collection}/${name}/billing.json`)),true); assert.ok(read(root,storeFile('unsorted')).operations['GET /users']); });

test('R7 conflicts and changed source files refuse before any destination is written',t=>{ const {root}=motivating(t); write(root,stackFile('billing'),{v:1,name:'billing',environments:{}}); assert.throws(()=>planStackMigration(root),{code:'MIGRATION_CONFLICT'}); assert.equal(existsSync(join(root,storeFile('billing'))),false); rmSync(join(root,`${LAYOUT.collection}/billing`),{recursive:true}); const plan=planStackMigration(root); write(root,LAYOUT.context,{...read(root,LAYOUT.context),generated_at:'2026-10-08'}); assert.throws(()=>applyStackMigration(plan),{code:'MIGRATION_SOURCE_CHANGED'}); assert.equal(existsSync(join(root,stackFile('billing'))),false); });

test('R7 unsafe paths and literal credentials are refused without touching sources',t=>{ const {root}=motivating(t); const config=read(root,LAYOUT.environments); config.environments.production.auth='Bearer planted-private-credential-value'; write(root,LAYOUT.environments,config); assert.throws(()=>planStackMigration(root),{code:'MIGRATION_AUTH_INVALID'}); config.environments.production.auth='bearer:BILLING_KEY'; write(root,LAYOUT.environments,config); const outside=fixture(t); symlinkSync(outside,join(root,`${LAYOUT.collection}/billing`)); assert.throws(()=>planStackMigration(root),{code:'MIGRATION_UNSAFE_PATH'}); assert.equal(existsSync(join(root,LAYOUT.context)),true); });

test('R7 unknown and origin-ambiguous evidence stays private in unsorted and is never inferred from its body',t=>{ const {root}=motivating(t); const bytes=JSON.stringify({runId:'run-misleading',request:{url:'https://unknown.example.test/x'},response:{body:{url:'https://billing.example.test/users',private:'planted-private-body'}}}); write(root,`${LAYOUT.evidence}/run-misleading.json`,bytes,0o600); const plan=planStackMigration(root); assert.ok(plan.issues.some(i=>i.code==='MIGRATION_EVIDENCE_UNSORTED'&&i.run==='run-misleading.json')); assert.doesNotMatch(JSON.stringify(plan),/planted-private-body/); applyStackMigration(plan); assert.equal(readFileSync(join(root,`${LAYOUT.evidence}/unsorted/run-misleading.json`),'utf8'),bytes); });

test('R7 names derive from API title, explicit names win, and invalid or conflicting splits refuse',t=>{ const {root}=motivating(t); assert.ok(planStackMigration(root,{name:'custom'}).stacks.some(s=>s.name==='custom')); assert.throws(()=>planStackMigration(root,{name:'suites'}),{code:'STACK_NAME_INVALID'}); assert.throws(()=>planStackMigration(root,{splits:['missing=other']}),{code:'MIGRATION_SPLIT_INVALID'}); assert.throws(()=>planStackMigration(root,{splits:['production=npm','npm=npm']}),{code:'MIGRATION_SPLIT_CONFLICT'}); });

test('R7 stack move refuses ambiguous source or occupied destination and preserves every authored field',t=>{ const {root,note}=motivating(t); applyStackMigration(planStackMigration(root,{splits:['npm=npm']})); const before=readFileSync(join(root,storeFile('unsorted'))); const target=read(root,storeFile('npm')); target.operations['GET /downloads']={notes:['A different fact.']}; write(root,storeFile('npm'),target); assert.throws(()=>moveStackOperation(root,{to:'npm',operation:'GET /downloads',from:'unsorted'}),{code:'MIGRATION_CONFLICT'}); assert.deepEqual(readFileSync(join(root,storeFile('unsorted'))),before); const primary=read(root,storeFile('billing')); primary.operations['GET /downloads']=note; write(root,storeFile('billing'),primary); assert.throws(()=>moveStackOperation(root,{to:'npm',operation:'GET /downloads'}),{code:'STACK_MOVE_AMBIGUOUS'}); });

test('R7 projected earlier-layout inputs preflight stack conflicts before any layout write',t=>{
 const root=fixture(t);contract(root,'contracts/billing.json');
 const config={v:1,default:'prod',environments:{prod:{baseUrl:'https://billing.example.test',contract:'contracts/billing.json'}}};
 const knowledge={v:0,api:{name:'Billing API',contract:'contracts/billing.json'},operations:{'GET /users':{notes:[],fields:{}}}};
 write(root,'api-environments.json',config);write(root,CONTEXT_BASENAME,knowledge);
 const virtualFiles=new Map([[LAYOUT.environments,{from:'api-environments.json',bytes:readFileSync(join(root,'api-environments.json'))}],[LAYOUT.context,{from:CONTEXT_BASENAME,bytes:readFileSync(join(root,CONTEXT_BASENAME))}]]);
 const before=readFileSync(join(root,CONTEXT_BASENAME));write(root,stackFile('billing'),{v:1,name:'billing',environments:{}});
 assert.throws(()=>planStackMigration(root,{virtualFiles}),{code:'MIGRATION_CONFLICT'});
 assert.deepEqual(readFileSync(join(root,CONTEXT_BASENAME)),before);assert.equal(existsSync(join(root,LAYOUT.context)),false);
 rmSync(join(root,`${LAYOUT.collection}/billing`),{recursive:true});
 const plan=planStackMigration(root,{virtualFiles});assert.equal(plan.preflight_only,true);assert.throws(()=>applyStackMigration(plan),{code:'MIGRATION_CANONICAL_INPUTS_REQUIRED'});
});

test('R7 top-level host observations normalize the environment while retaining original identity and source provenance',t=>{
 const root=fixture(t),digest=contract(root,'contracts/alpha.json','Alpha API');
 write(root,LAYOUT.environments,{v:1,hosts:{alpha:{baseUrl:'https://alpha.example.test',auth:'bearer:ALPHA_KEY',contract:'contracts/alpha.json'}}});
 const entry=record(root,{environment:'production',provider:'https://alpha.example.test',contractDigest:digest});
 write(root,LAYOUT.context,{v:0,api:{name:'Imported APIs'},operations:{'GET /users':{notes:[],fields:{}}},api_context:{v:1,operations:Object.fromEntries([entry])}});
 const plan=planStackMigration(root);assert.deepEqual(plan.stacks.map(row=>row.name),['alpha']);applyStackMigration(plan);
 const result=Object.values(read(root,storeFile('alpha')).api_context.operations)[0];
 assert.equal(result.identity.environment,'default');assert.equal(result.identity.stack,'alpha');assert.deepEqual(result.migration.identity,entry[1].identity);assert.equal(result.migration.from_operation_id,entry[0]);
 assert.deepEqual(result.observations[0].source,entry[1].observations[0].source);assert.equal(result.observations[0].id,'obs-a');
});

test('R7 unknown config files and non-run evidence are retained, and malformed histories refuse',t=>{
 const {root}=motivating(t);write(root,`${LAYOUT.config}/user-notes.md`,'User-owned notes.');write(root,`${LAYOUT.evidence}/custom-report.json`,{private:'private-report-value'});
 applyStackMigration(planStackMigration(root));assert.equal(readFileSync(join(root,`${LAYOUT.config}/user-notes.md`),'utf8'),'User-owned notes.');assert.equal(read(root,`${LAYOUT.evidence}/custom-report.json`).private,'private-report-value');
 const other=motivating(t).root,value=read(other,LAYOUT.context);Object.values(value.api_context.operations)[0].observations[0].verification='unsupported';write(other,LAYOUT.context,value);
 assert.throws(()=>planStackMigration(other),{code:'MIGRATION_CONTEXT_INVALID'});assert.equal(existsSync(join(other,stackFile('billing'))),false);
});

test('R7 a failed destination readback leaves every source intact and an identical plan can resume',t=>{
 const {root}=motivating(t),plan=planStackMigration(root,{splits:['npm=npm']});
 failReadback(join(root,stackFile('billing')),()=>assert.throws(()=>applyStackMigration(plan),{code:'MIGRATION_READBACK_FAILED'}));
 for(const path of [LAYOUT.context,LAYOUT.environments,'contracts/billing.json',`${LAYOUT.evidence}/run-billing.json`,`${LAYOUT.evidence}/run-downloads.json`])assert.equal(existsSync(join(root,path)),true,path);
 applyStackMigration(planStackMigration(root,{splits:['npm=npm']}));assert.equal(planStackMigration(root).state,'noop');
});

test('R7 stack move verifies destination before removing the authored source entry',t=>{
 const {root,note}=motivating(t);applyStackMigration(planStackMigration(root,{splits:['npm=npm']}));
 failReadback(join(root,storeFile('npm')),()=>assert.throws(()=>moveStackOperation(root,{from:'unsorted',to:'npm',operation:'GET /downloads'}),{code:'MIGRATION_READBACK_FAILED'}),text=>text.includes('"GET /downloads":'));
 assert.deepEqual(read(root,storeFile('unsorted')).operations['GET /downloads'],note);
});

test('R7 malformed environment fields fail before creating an unreadable stack',t=>{
 const {root}=motivating(t),config=read(root,LAYOUT.environments);config.environments.production.production='yes';write(root,LAYOUT.environments,config);
 assert.throws(()=>planStackMigration(root),{code:'MIGRATION_ENVIRONMENT_INVALID'});assert.equal(existsSync(join(root,stackFile('billing'))),false);
});

test('R7 observation assignment uses origin plus environment; origin-only evidence remains ambiguous',t=>{
 const root=fixture(t);contract(root,'contracts/billing.json');
 write(root,LAYOUT.environments,{v:1,default:'prod',environments:{prod:{baseUrl:'https://shared.example.test',contract:'contracts/billing.json'},dev:{baseUrl:'https://shared.example.test'}}});
 const entry=record(root,{provider:'https://shared.example.test',environment:'dev'});store(root,{},Object.fromEntries([entry]));
 const plan=planStackMigration(root,{splits:['dev=dev']});assert.ok(plan.issues.some(issue=>issue.code==='MIGRATION_EVIDENCE_UNSORTED'));applyStackMigration(plan);
 const migrated=Object.values(read(root,storeFile('dev')).api_context.operations)[0];assert.equal(migrated.identity.environment,'dev');assert.equal(migrated.identity.stack,'dev');
 assert.equal(existsSync(join(root,`${LAYOUT.evidence}/unsorted/run-billing.json`)),true);
});

test('R7 observation references rekey to the migrated source digest without renewing timestamps or claims',t=>{
 const {root}=motivating(t),old=read(root,LAYOUT.context),[id,entry]=Object.entries(old.api_context.operations)[0],source=entry.observations[0];
 entry.observations.push({...structuredClone(source),id:'obs-lesson',basis:'authored',source:{kind:'external',tool:'api_context_record'},verification:'external-claim',outcome:'unknown',complete:false,based_on:{operation_id:id,observation_id:source.id,observation_digest:hash(JSON.stringify(source))},notes:['An explanation tied to the captured response.']});
 write(root,LAYOUT.context,old);applyStackMigration(planStackMigration(root));
 const [migratedId,migrated]=Object.entries(read(root,storeFile('billing')).api_context.operations)[0],lesson=migrated.observations[1];
 assert.equal(lesson.based_on.operation_id,migratedId);assert.equal(lesson.based_on.observation_digest,hash(JSON.stringify(migrated.observations[0])));assert.equal(lesson.observed_at,source.observed_at);assert.equal(lesson.verification,'external-claim');
 assert.equal(migrated.migration.observation_digests[source.id],hash(JSON.stringify(source)));
});

test('R7 protocol run endpoints are URL-only inputs and response lookalikes do not affect assignment',t=>{
 const {root}=motivating(t),bytes=JSON.stringify({v:1,identity:{endpoint:'https://billing.example.test/graphql'},request:{graphql:{query:'query Fixture { user }'}},response:{body:{url:'https://downloads.example.test',private:'private-protocol-evidence'}}});
 write(root,`${LAYOUT.evidence}/run-protocol.json`,bytes,0o600);const plan=planStackMigration(root);assert.doesNotMatch(JSON.stringify(plan),/private-protocol-evidence|query Fixture/);applyStackMigration(plan);
 assert.equal(readFileSync(join(root,`${LAYOUT.evidence}/billing/run-protocol.json`),'utf8'),bytes);
});

test('R7 unknown API and context metadata is retained without rewriting authored path lookalikes',t=>{
 const {root}=motivating(t),value=read(root,LAYOUT.context);
 value.api.documentation={path:'contracts/billing.json',source:'authored-source'};
 value.api_context.audit_extension={path:`${LAYOUT.evidence}/run-billing.json`,by:'agent'};
 value.imported_test_claims={v:1,sources:{fixture:{claims:[{evidence:{run_id:'run-billing',path:`${LAYOUT.evidence}/run-billing.json`}}]}}};
 write(root,LAYOUT.context,value);const plan=planStackMigration(root);assert.ok(plan.issues.some(issue=>issue.code==='MIGRATION_CONTEXT_EXTENSION_RETAINED'&&issue.key==='audit_extension'));assert.ok(plan.issues.some(issue=>issue.code==='MIGRATION_REPO_EXTENSION_RETAINED'&&issue.key==='imported_test_claims'));
 applyStackMigration(plan);const migrated=read(root,storeFile('billing'));
 assert.deepEqual(migrated.api.documentation,value.api.documentation);assert.deepEqual(migrated.api_context.audit_extension,value.api_context.audit_extension);
 assert.equal(migrated.imported_test_claims.sources.fixture.claims[0].evidence.path,`${LAYOUT.evidence}/billing/run-billing.json`);
});

test('R7 same-origin environments inherit the primary contract but a different-origin contractless integration does not',t=>{
 const {root}=motivating(t),config=read(root,LAYOUT.environments);config.environments.staging={baseUrl:'https://billing.example.test'};write(root,LAYOUT.environments,config);
 applyStackMigration(planStackMigration(root,{splits:['npm=npm']}));const primary=read(root,stackFile('billing'));
 assert.equal(primary.contract,'billing.json');assert.equal(primary.environments.staging.contract,undefined);assert.equal(read(root,stackFile('npm')).contract,undefined);
});

test('R7 identical evidence destinations with unsafe modes refuse before removing sources',t=>{
 const {root}=motivating(t),source=`${LAYOUT.evidence}/run-billing.json`,target=`${LAYOUT.evidence}/billing/run-billing.json`;
 write(root,target,readFileSync(join(root,source),'utf8'),0o644);
 assert.throws(()=>planStackMigration(root),{code:'MIGRATION_EVIDENCE_MODE_UNSAFE'});assert.equal(existsSync(join(root,source)),true);assert.equal(existsSync(join(root,LAYOUT.context)),true);
});

test('R7 a defaults-only installation retires config without inventing an API stack',t=>{
 const root=fixture(t);write(root,LAYOUT.defaults,{budget:900});const plan=planStackMigration(root);assert.equal(plan.state,'planned');assert.deepEqual(plan.stacks,[]);applyStackMigration(plan);
 assert.deepEqual(read(root,`${LAYOUT.directory}/defaults.json`),{budget:900});assert.equal(existsSync(join(root,LAYOUT.config)),false);assert.equal(planStackMigration(root).state,'noop');
});

test('R7 unsplit contractless integrations remain contractless when read by the shared resolver',t=>{
 const {root}=motivating(t);applyStackMigration(planStackMigration(root));
 assert.equal(stackScope(root,{stack:'billing',environment:'production'}).config.contract,join(root,LAYOUT.collection,'billing','billing.json'));
 assert.equal(stackScope(root,{stack:'billing',environment:'npm'}).config.contract,undefined);
});

test('R7 the shared document validator rejects invalid inherited metadata before any migration write',t=>{
 const {root}=motivating(t),value=read(root,LAYOUT.context);value.api.name='A'.repeat(257);write(root,LAYOUT.context,value);
 assert.throws(()=>planStackMigration(root),{code:'STACK_CONFIG_INVALID'});
 assert.equal(existsSync(join(root,stackFile('a'.repeat(63)))),false);assert.equal(existsSync(join(root,LAYOUT.context)),true);
});

test('R7 standalone defaults obey the same known-key and stack-name constraints as combined defaults',t=>{
 const root=fixture(t);write(root,LAYOUT.defaults,{surprise:true});
 assert.throws(()=>planStackMigration(root),{code:'MIGRATION_CONFIG_UNKNOWN_KEY'});
 write(root,LAYOUT.defaults,{default_stack:'../outside'});
 assert.throws(()=>planStackMigration(root),{code:'STACK_NAME_INVALID'});
 assert.equal(existsSync(join(root,`${LAYOUT.directory}/defaults.json`)),false);assert.equal(existsSync(join(root,LAYOUT.defaults)),true);
});

// Re-filing must validate the same portable stack definition used by requests.
test('R7 stack move refuses an invalid destination definition before changing either store', t => {
 const { root } = motivating(t); applyStackMigration(planStackMigration(root, { splits: ['npm=npm'] }));
 const before = readFileSync(join(root, storeFile('unsorted')));
 const config = read(root, stackFile('npm')); config.unrecognized = true; write(root, stackFile('npm'), config);
 assert.throws(() => moveStackOperation(root, { to: 'npm', from: 'unsorted', operation: 'GET /downloads' }), { code: 'STACK_KEY_UNKNOWN' });
 assert.deepEqual(readFileSync(join(root, storeFile('unsorted'))), before);
 assert.equal(read(root, storeFile('npm')).operations['GET /downloads'], undefined);
});
