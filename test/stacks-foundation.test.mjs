import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LAYOUT } from '../lib/layout.mjs';
import { CONTEXT_BASENAME, HOME_ENV_NAME } from '../lib/brand.mjs';
import { stackCatalog, resolveStack, createStack } from '../lib/stacks.mjs';
import { currentStackScope, withStackScope, activeStackScopeFor, contextFileFor, evidenceDirectoryFor } from '../lib/stack-scope.mjs';
import { resolveConfig } from '../lib/config.mjs';
function fixture(t) { const root=mkdtempSync(join(tmpdir(),'stacks-foundation-')); t.after(()=>rmSync(root,{recursive:true,force:true})); return root; }
function writeStack(root,name,document={}) {
  const folder=join(root,LAYOUT.collection,name); mkdirSync(folder,{recursive:true});
  const value={v:1,name,default_environment:'production',environments:{production:{baseUrl:`https://${name}.example.test/v2`,auth:`bearer:${name.toUpperCase()}_KEY`}},...document};
  writeFileSync(join(folder,'stack.json'),JSON.stringify(value)); return value;
}
const error = (fn, code) => assert.throws(fn,e=>e.code===code);

test('STACKS-1A foundation validates names, schema keys, references and project-bounded contracts',t=>{
 const root=fixture(t);
 for(const name of ['UPPER','a_b','../escape','suites','a'.repeat(64)]) error(()=>createStack(root,name,{baseUrl:'https://billing.example.test'}),'STACK_NAME_INVALID');
 writeStack(root,'billing',{typo:true}); assert.equal(stackCatalog(root).problems[0].code,'STACK_KEY_UNKNOWN');
 writeStack(root,'billing',{environments:{production:{baseUrl:'https://billing.example.test',auth:'literal-secret'}}}); error(()=>resolveStack(root,{path:'/users'}),'STACK_AUTH_INVALID');
 writeStack(root,'billing',{contract:'../../../../outside.json'}); error(()=>resolveStack(root,{path:'/users'}),'STACK_CONTRACT_OUTSIDE_PROJECT');
 writeStack(root,'billing',{environments:{production:{baseUrl:'https://user:password@billing.example.test'}}}); error(()=>resolveStack(root,{path:'/users'}),'STACK_URL_INVALID');
 writeStack(root,'billing',{environments:{production:{baseUrl:'https://billing.example.test',headers:{Authorization:'synthetic-value'}}}}); error(()=>resolveStack(root,{path:'/users'}),'STACK_AUTH_INVALID');
});

test('STACKS-1A foundation ignores reserved later fields with named doctor notes and reads holding stack',t=>{
 const root=fixture(t); writeStack(root,'billing',{cli:{binary:'fake'},mcp:[{server:'fake'}]});
 const c=stackCatalog(root); assert.deepEqual(c.problems,[]); assert.deepEqual(c.notes.map(n=>n.key).sort(),['cli','mcp']);
 writeStack(root,'unsorted',{environments:{},default_environment:undefined});
 assert.deepEqual(stackCatalog(root).stacks.find(s=>s.name==='unsorted').environmentNames,[]);
 error(()=>resolveStack(root,{stack:'unsorted',path:'/users'}),'ENVIRONMENT_NOT_FOUND');
});

test('STACKS-1A b foundation absolute URLs refuse overlap and enforce segment-bounded matching',t=>{
 const root=fixture(t); writeStack(root,'a'); writeStack(root,'b');
 assert.equal(resolveStack(root,{path:'https://b.example.test/v2/users'}).stack,'b');
 error(()=>resolveStack(root,{path:'https://b.example.test/v20/users'}),'ORIGIN_NOT_CONFIGURED');
 writeStack(root,'a',{environments:{production:{baseUrl:'https://b.example.test/v2'}}});
 assert.throws(()=>resolveStack(root,{path:'https://b.example.test/v2/users'}),e=>e.code==='STACK_AMBIGUOUS'&&e.details.available.join(',')==='a,b');
 assert.equal(resolveStack(root,{stack:'b',path:'https://b.example.test/v2/users'}).stack,'b');
 error(()=>resolveStack(root,{stack:'b',path:'https://a.example.test/v2/users'}),'ORIGIN_NOT_CONFIGURED');
});

test('STACKS-1A c foundation relative selection uses explicit, default or the only stack and never guesses',t=>{
 const root=fixture(t); writeStack(root,'a'); assert.equal(resolveStack(root,{path:'/users'}).stack,'a'); writeStack(root,'b');
 assert.throws(()=>resolveStack(root,{path:'/users'}),e=>e.code==='STACK_REQUIRED'&&e.details.available.length===2);
 writeFileSync(join(root,LAYOUT.directory,'defaults.json'),JSON.stringify({default_stack:'b'}));
 assert.equal(resolveStack(root,{path:'/users'}).stack,'b'); assert.equal(resolveStack(root,{stack:'a',path:'/users'}).stack,'a');
});

test('STACKS-1A d foundation environment selection refuses missing names and rereads changes',t=>{
 const root=fixture(t); const doc=writeStack(root,'a');
 assert.throws(()=>resolveStack(root,{stack:'a',path:'/users',environment:'staging'}),e=>e.code==='ENVIRONMENT_NOT_FOUND'&&e.details.available[0]==='production');
 doc.environments.staging={baseUrl:'https://staging.example.test/v3',auth:'bearer:STAGING_KEY'};
 writeStack(root,'a',doc); const scope=resolveStack(root,{stack:'a',path:'/users',environment:'staging'});
 assert.equal(scope.config.name,'staging'); assert.equal(scope.config.auth,'bearer:STAGING_KEY'); assert.equal(scope.config.baseUrl,'https://staging.example.test/v3');
});

test('STACKS-1A f foundation upstream is a reported compatibility alias and explicit stack wins',t=>{
 const root=fixture(t); writeStack(root,'a'); writeStack(root,'b');
 const alias=resolveStack(root,{upstream:'b',path:'/users'}); assert.equal(alias.stack,'b'); assert.equal(alias.alias.from,'upstream');
 assert.equal(resolveStack(root,{stack:'a',upstream:'b',path:'/users'}).stack,'a');
});

test('STACKS-1A g foundation selected scope binds contract, knowledge and evidence without ambient credential overrides',t=>{
 const root=fixture(t); writeStack(root,'a',{contract:'openapi.json'}); writeFileSync(join(root,LAYOUT.collection,'a','openapi.json'),'{}');
 const scope=resolveStack(root,{stack:'a',path:'/users'});
 assert.equal(scope.contextFile,`${LAYOUT.collection}/a/${CONTEXT_BASENAME}`); assert.equal(scope.evidenceDir,`${LAYOUT.evidence}/a`);
 assert.equal(scope.config.contract,join(root,LAYOUT.collection,'a','openapi.json')); assert.equal(scope.config.defaults.evidenceDir,scope.evidenceDir);
 withStackScope(scope,()=>{ assert.equal(resolveConfig(root),scope.config); assert.equal(currentStackScope(),scope); assert.equal(contextFileFor(root,'fallback'),scope.contextFile); assert.equal(contextFileFor(join(root,'other'),'fallback'),'fallback'); assert.equal(evidenceDirectoryFor(root,'fallback'),scope.evidenceDir); });
 assert.equal(currentStackScope(),null);
});

test('STACKS-1A foundation isolated async scopes cannot exchange configuration',async t=>{
 const root=fixture(t); writeStack(root,'a'); writeStack(root,'b');
 const scopes=['a','b'].map(stack=>resolveStack(root,{stack,path:'/users'}));
 const got=await Promise.all(scopes.map(scope=>withStackScope(scope,async()=>{await new Promise(r=>setTimeout(r,2)); return resolveConfig(root).stack;})));
 assert.deepEqual(got,['a','b']);
});

test('STACKS-1A foundation create validates before writing, copies only bounded contracts and never overwrites a stack',t=>{
 const root=fixture(t); const source=join(root,'source.json'); writeFileSync(source,'{"openapi":"3.0.3"}');
 const made=createStack(root,'billing',{baseUrl:'https://billing.example.test/v2',auth:'bearer:BILLING_KEY',contract:source,environment:'production',title:'Billing API'});
 assert.equal(made.stack,'billing'); assert.equal(made.document.contract,'source.json'); assert.equal(readFileSync(join(made.folder,'source.json'),'utf8'),readFileSync(source,'utf8'));
 assert.equal(resolveStack(root,{path:'/users'}).stack,'billing'); error(()=>createStack(root,'billing',{baseUrl:'https://other.example.test'}),'STACK_EXISTS');
 assert.equal(existsSync(join(root,LAYOUT.environments)),false);
});

test('STACKS-1A foundation refuses symbolic stack, configuration and contract paths',t=>{
 const root=fixture(t), outside=fixture(t); writeStack(outside,'a'); mkdirSync(join(root,LAYOUT.collection),{recursive:true});
 symlinkSync(join(outside,LAYOUT.collection,'a'),join(root,LAYOUT.collection,'a')); error(()=>resolveStack(root,{path:'/users'}),'STACK_UNSAFE_PATH');
 rmSync(join(root,LAYOUT.collection,'a')); writeStack(root,'a',{contract:'openapi.json'}); writeFileSync(join(outside,'outside.json'),'{}'); symlinkSync(join(outside,'outside.json'),join(root,LAYOUT.collection,'a','openapi.json'));
 error(()=>resolveStack(root,{path:'/users'}),'STACK_UNSAFE_PATH');
});

test('STACKS-1A i foundation leaves legacy repositories implicit and refuses mixed creation',t=>{
 const root=fixture(t); assert.equal(resolveStack(root,{path:'/users'}),null);
 mkdirSync(join(root,LAYOUT.collection),{recursive:true}); writeFileSync(join(root,LAYOUT.context),'{}');
 error(()=>createStack(root,'billing',{baseUrl:'https://billing.example.test'}),'STACKS_MIGRATION_REQUIRED');
 assert.equal(resolveStack(root,{path:'/users'}),null);
});

test('a single-store repository can preview migration, apply it, and retry stack add', t => {
 const root = fixture(t), baseUrl = 'http://127.0.0.1:9';
 mkdirSync(join(root, LAYOUT.config), { recursive: true });
 const config = JSON.stringify({ default: 'local', environments: { local: { baseUrl } } });
 writeFileSync(join(root, LAYOUT.environments), config);
 const cli = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
 const command = args => {
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], {
   cwd: root, encoding: 'utf8', timeout: 20_000,
   env: { PATH: process.env.PATH, HOME: process.env.HOME, [HOME_ENV_NAME]: join(root, 'machine'),
    API_USAGE_LOG: '', NO_COLOR: '1' },
  });
  assert.ifError(result.error);
  return result;
 };
 const add = ['stack', 'add', 'demo', '--base-url', baseUrl];
 const refused = command(add);
 assert.equal(refused.status, 1, refused.stdout + refused.stderr);
 const { error: refusal } = JSON.parse(refused.stderr);
 assert.equal(refusal.code, 'STACKS_MIGRATION_REQUIRED');
 assert.equal(existsSync(join(root, LAYOUT.collection, 'demo')), false);
 const steps = [['migrate', '--dry-run'], ['migrate'], add];
 for (const args of steps) {
  const result = command(args);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  if (args[0] === 'migrate') assert.equal(report.requests_executed, 0);
  if (args.includes('--dry-run')) {
   assert.equal(report.dry_run, true);
   assert.equal(readFileSync(join(root, LAYOUT.environments), 'utf8'), config);
   assert.equal(existsSync(join(root, LAYOUT.collection, 'api')), false);
  }
 }
 assert.equal(resolveStack(root, { stack: 'api', path: '/users' }).config.name, 'local');
 assert.equal(resolveStack(root, { stack: 'demo', path: '/users' }).config.baseUrl, baseUrl);
});

test('STACKS-1A foundation metadata scopes support contract-only stacks and preserve cross-repo configuration boundaries',async t=>{
 const root=fixture(t), other=fixture(t); writeFileSync(join(root,'api.json'),'{}');
 const made=createStack(root,'api',{contract:'api.json'});
 assert.deepEqual(made.document.environments,{}); assert.equal(made.config,undefined); assert.equal(made.scope.config.name,null);
 error(()=>resolveStack(root,{stack:'api',path:'/users'}),'ENVIRONMENT_NOT_FOUND');
 writeStack(other,'other');
 withStackScope(made.scope,()=>{assert.equal(resolveConfig(root).stack,'api'); assert.equal(resolveConfig(other).stack,'other');});
});

test('STACKS-1A foundation standalone config never guesses and API_ENV cannot fall back',t=>{
 const root=fixture(t); writeStack(root,'a'); writeStack(root,'b');
 assert.equal(resolveConfig(root).problems[0].code,'STACK_REQUIRED');
 const saved={...process.env};
 try {
  process.env.API_ENV='staging'; process.env.API_AUTH='bearer:WRONG_KEY'; process.env.API_BASE_URL='https://wrong.example.test'; process.env.API_CONTRACT='/wrong.json';
  error(()=>resolveStack(root,{stack:'a',path:'/users'}),'ENVIRONMENT_NOT_FOUND');
  const scoped=resolveStack(root,{stack:'a',path:'/users',environment:'production'});
  assert.equal(scoped.config.auth,'bearer:A_KEY'); assert.equal(scoped.config.baseUrl,'https://a.example.test/v2'); assert.equal(scoped.config.contract,undefined);
 } finally { for(const key of Object.keys(process.env)) if(!(key in saved)) delete process.env[key]; Object.assign(process.env,saved); }
});

test('STACKS-1A foundation contract copy refuses oversized inputs before creating files',t=>{
 const root=fixture(t), source=join(root,'large.json'); writeFileSync(source,Buffer.alloc(16*1024*1024+1,32));
 error(()=>createStack(root,'a',{baseUrl:'https://a.example.test',contract:source}),'STACK_CONTRACT_LIMIT');
 assert.equal(existsSync(join(root,LAYOUT.collection,'a')),false);
});

test('STACKS-1A foundation canonicalizes only the project alias ancestor of a contract source',t=>{
 const root=realpathSync(fixture(t)), outside=fixture(t), alias=join(outside,'project-alias');
 writeFileSync(join(root,'api.json'),'{"openapi":"3.0.3"}'); symlinkSync(root,alias,'dir');
 const made=createStack(root,'billing',{baseUrl:'https://billing.example.test',contract:join(alias,'api.json')});
 assert.equal(readFileSync(join(made.folder,'api.json'),'utf8'),'{"openapi":"3.0.3"}');
 writeFileSync(join(outside,'external.json'),'{}'); symlinkSync(join(outside,'external.json'),join(root,'linked.json'));
 error(()=>createStack(root,'unsafe',{baseUrl:'https://unsafe.example.test',contract:join(alias,'linked.json')}),'STACK_UNSAFE_PATH');
 assert.equal(existsSync(join(root,LAYOUT.collection,'unsafe')),false);
 error(()=>createStack(root,'outside',{baseUrl:'https://outside.example.test',contract:join(outside,'external.json')}),'STACK_CONTRACT_OUTSIDE_PROJECT');
});

test('STACKS-1A foundation scoped stores recognize the same real project through an alias',t=>{
 const root=realpathSync(fixture(t)), outside=fixture(t), alias=join(outside,'project-alias'); symlinkSync(root,alias,'dir');
 writeStack(root,'billing'); writeStack(root,'other'); const scope={...resolveStack(root,{stack:'billing',path:'/users'}),root:alias};
 withStackScope(scope,()=>{
  assert.equal(activeStackScopeFor(root),scope);
  assert.equal(activeStackScopeFor(outside),null);
  assert.equal(contextFileFor(root,'wrong'),scope.contextFile);
  assert.equal(evidenceDirectoryFor(root,'wrong'),scope.evidenceDir);
  assert.equal(contextFileFor(outside,'fallback'),'fallback');
  assert.equal(resolveConfig(root),scope.config);
 });
});
