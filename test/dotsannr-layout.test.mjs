import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PRODUCT, CONTEXT_BASENAME, HOME_ENV_NAME } from '../lib/brand.mjs';
const temp = t => { const root = mkdtempSync(join(tmpdir(), 'layout-specimen-')); t.after(() => rmSync(root, { recursive:true, force:true })); return root; };
const api = () => import('../lib/layout.mjs');

test('DOTSANNR-1 layout: generated committed guide and ignored evidence use the seam', async t => {
 const {LAYOUT, ensureLayout} = await api(); const root = temp(t); ensureLayout(root);
 assert.equal(LAYOUT.context, `${LAYOUT.collection}/${CONTEXT_BASENAME}`);
 assert.ok(existsSync(join(root, LAYOUT.collection)));
 const guide = readFileSync(join(root, LAYOUT.readme), 'utf8');
 assert.ok(guide.includes(`${LAYOUT.collection}/<name>/${CONTEXT_BASENAME}`)); assert.ok(guide.includes('credentials')); assert.ok(!guide.includes(root));
 assert.match(readFileSync(join(root, LAYOUT.gitignore), 'utf8'), /^\/evidence\//m);
 execFileSync('git', ['init','-q'], {cwd:root});
 writeFileSync(join(root, LAYOUT.evidence, 'sample.json'), '{}');
 assert.equal(execFileSync('git', ['check-ignore', LAYOUT.evidence+'/sample.json'], {cwd:root,encoding:'utf8'}).trim(), LAYOUT.evidence+'/sample.json');
});
test('a fresh connect writes a README with stacks paths before the first stack exists', async t => {
 const {LAYOUT, renderLayoutReadme} = await api(); const root = temp(t);
 execFileSync('git', ['init', '-q'], {cwd:root});
 const env = {PATH:process.env.PATH, HOME:process.env.HOME, [HOME_ENV_NAME]:join(root,'machine-state'), API_CONTEXT_DIR:root, NO_COLOR:'1', API_USAGE_LOG:''};
 const cli = new URL('../bin/cli.mjs', import.meta.url).pathname;
 const connect = () => execFileSync(process.execPath, [cli, 'connect', '--no-skills', '--no-pointers', '--json'], {cwd:root, env, encoding:'utf8'});
 const report = JSON.parse(connect());
 assert.equal(report.first_stack.action, 'none');
 const guide = readFileSync(join(root, LAYOUT.readme), 'utf8');
 for (const path of [`${LAYOUT.collection}/<name>/stack.json`, `${LAYOUT.collection}/<name>/${CONTEXT_BASENAME}`, `${LAYOUT.evidence}/<name>/`])
   assert.ok(guide.includes(`| \`${path}\` |`), `missing stacks path: ${path}`);
 for (const path of [LAYOUT.context, LAYOUT.environments]) {
   assert.ok(!guide.includes(`| \`${path}\` |`), `unexpected single-store path: ${path}`);
   assert.ok(!existsSync(join(root, path)), `connect created a single-store file: ${path}`);
 }
 // alpha.11 (9709db2) and alpha.12 (bf429d7) shipped this same renderer
 // and template. Reconnecting upgrades their single-store guide in place.
 writeFileSync(join(root, LAYOUT.readme), renderLayoutReadme({stacks:false}));
 connect();
 assert.equal(readFileSync(join(root, LAYOUT.readme), 'utf8'), guide);
 connect();
 assert.equal(readFileSync(join(root, LAYOUT.readme), 'utf8'), guide);
 execFileSync(process.execPath, [cli, 'stack', 'add', 'example', '--base-url', 'http://127.0.0.1:1', '--json'], {cwd:root, env, encoding:'utf8'});
 assert.ok(existsSync(join(root, LAYOUT.collection, 'example', 'stack.json')));
 connect();
 assert.equal(readFileSync(join(root, LAYOUT.readme), 'utf8'), guide);
});
test('generated layout guides retain the single-store table when legacy knowledge or environments exist', async t => {
 const {LAYOUT, ensureLayout, renderLayoutReadme} = await api();
 for (const path of [LAYOUT.context, LAYOUT.environments]) {
   const root = temp(t); ensureLayout(root);
   writeFileSync(join(root, path), '{}');
   ensureLayout(root);
   const guide = readFileSync(join(root, LAYOUT.readme), 'utf8');
   assert.ok(guide.includes(LAYOUT.context), path);
   assert.equal(guide, renderLayoutReadme({stacks:false}), path);
 }
});
test('DOTSANNR-1 layout: knowledge and defaults resolve inside the committed directory', async t => {
 const {LAYOUT, ensureLayout} = await api(); const {saveContext, loadContext, CONTEXT_FILE} = await import('../lib/context.mjs'); const {readConfigDefaults, resolveConfig}=await import('../lib/config.mjs'); const root=temp(t); ensureLayout(root);
 saveContext(root, {v:0, operations:{}}); assert.equal(CONTEXT_FILE, LAYOUT.context); assert.ok(loadContext(root)); assert.ok(!existsSync(join(root,CONTEXT_BASENAME)));
 writeFileSync(join(root,LAYOUT.defaults), JSON.stringify({staleDays:37})); assert.equal(readConfigDefaults(root).staleDays,37);
 writeFileSync(join(root,LAYOUT.environments), JSON.stringify({default:'local',environments:{local:{contract:'./openapi.json'}}})); assert.equal(resolveConfig(root).contract,join(root,'openapi.json'));
});
test('DOTSANNR-1 migration: legacy files move once and preserve project-relative config', async t => {
 const {LAYOUT,migrateLayout}=await api(); const {resolveConfig}=await import('../lib/config.mjs'); const root=temp(t);
 writeFileSync(join(root,CONTEXT_BASENAME),'{}'); writeFileSync(join(root,'api-request.md'),'legacy guide\n');
 writeFileSync(join(root,'api-environments.json'),JSON.stringify({default:'local',environments:{local:{contract:'./openapi.json'}}}));
 const result=migrateLayout(root); assert.ok(result.moved.length>=3); assert.equal(readFileSync(join(root,LAYOUT.context),'utf8'),'{}'); assert.equal(readFileSync(join(root,LAYOUT.skillGuide),'utf8'),'legacy guide\n'); assert.equal(resolveConfig(root).contract,join(root,'openapi.json')); assert.equal(migrateLayout(root).moved.length,0);
});
test('DOTSANNR-1 migration: destination conflict refuses before moving any legacy file', async t=>{
 const {LAYOUT,ensureLayout,migrateLayout}=await api();const root=temp(t);ensureLayout(root);writeFileSync(join(root,CONTEXT_BASENAME),'source');writeFileSync(join(root,'api-request.md'),'guide');writeFileSync(join(root,LAYOUT.context),'destination');
 assert.throws(()=>migrateLayout(root),e=>e.code==='MIGRATION_CONFLICT'&&e.message.includes(LAYOUT.context)); assert.equal(readFileSync(join(root,CONTEXT_BASENAME),'utf8'),'source');assert.ok(existsSync(join(root,'api-request.md')));
});
test('DOTSANNR-1 migration: symlink ancestor is refused without outside writes', async t=>{
 const {LAYOUT,ensureLayout}=await api(); const root=temp(t), outside=temp(t); symlinkSync(outside,join(root,LAYOUT.directory),'dir');assert.throws(()=>ensureLayout(root),e=>e.code==='LAYOUT_UNSAFE_PATH');assert.deepEqual((await import('node:fs')).readdirSync(outside),[]);
});
test('DOTSANNR-1 migration: product and collection seam rename relocates an existing directory',async t=>{
 const {LAYOUT,ensureLayout}=await api();const root=temp(t);ensureLayout(root);writeFileSync(join(root,LAYOUT.context),'{}');
 const script=`import {LAYOUT,migrateLayout} from ${JSON.stringify(new URL('../lib/layout.mjs',import.meta.url).href)};console.log(JSON.stringify({layout:LAYOUT,result:migrateLayout(process.argv[1])}));`;
 const out=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script,root],{encoding:'utf8',env:{...process.env,API_CONTEXT_PRODUCT_NAME:'renamed-tool',API_CONTEXT_COLLECTION_NAME:'renamed-collection'}}));
 assert.equal(out.layout.directory,'.renamed-tool'); assert.equal(out.layout.collection,'.renamed-tool/renamed-collection');assert.equal(readFileSync(join(root,out.layout.context),'utf8'),'{}');assert.ok(!existsSync(join(root,LAYOUT.context)));assert.ok(!readFileSync(join(root,out.layout.readme),'utf8').includes(PRODUCT));
});
test('DOTSANNR-1 layout: reserved collection name refuses before creating an ignored knowledge store', t=>{
 const root=temp(t);
 const script=`import {ensureLayout} from ${JSON.stringify(new URL('../lib/layout.mjs',import.meta.url).href)};ensureLayout(process.argv[1]);`;
 assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',script,root],{encoding:'utf8',stdio:'pipe',env:{...process.env,API_CONTEXT_COLLECTION_NAME:'evidence'}}),error=>error.stderr.includes('LAYOUT_COLLECTION_CONFLICT'));
});
test('DOTSANNR-1 layout: a later ignore negation cannot expose captured evidence',async t=>{
 const {LAYOUT,ensureLayout}=await api();const root=temp(t);ensureLayout(root);
 writeFileSync(join(root,LAYOUT.gitignore),'/evidence/\n!/evidence/\n');ensureLayout(root);
 execFileSync('git',['init','-q'],{cwd:root});writeFileSync(join(root,LAYOUT.evidence,'sample.json'),'{}');
 assert.equal(execFileSync('git',['check-ignore',LAYOUT.evidence+'/sample.json'],{cwd:root,encoding:'utf8',stdio:'pipe'}).trim(),LAYOUT.evidence+'/sample.json');
});
test('DOTSANNR-1 layout: an unmigrated knowledge file refuses before creating parallel memory',async t=>{
 const {LAYOUT,ensureLayout}=await api();const root=temp(t);writeFileSync(join(root,CONTEXT_BASENAME),'{}');
 assert.throws(()=>ensureLayout(root),e=>e.code==='LAYOUT_MIGRATION_REQUIRED'&&e.message.includes(CONTEXT_BASENAME));assert.ok(!existsSync(join(root,LAYOUT.directory)));
});
test('DOTSANNR-1 migration: a giant ownership marker is a bounded named refusal',async t=>{
 const {migrateLayout}=await api();const root=temp(t);mkdirSync(join(root,'.old-tool'));writeFileSync(join(root,'.old-tool','layout.json'),' '.repeat(8192));
 assert.throws(()=>migrateLayout(root),e=>e.code==='LAYOUT_MARKER_INVALID');
});
test('DOTSANNR-1 migration: a collection rename rewrites catalog and snapshot source references',async t=>{
 const {LAYOUT,ensureLayout}=await api();const root=temp(t);ensureLayout(root);writeFileSync(join(root,LAYOUT.context),'{}');
 writeFileSync(join(root,LAYOUT.graphManifest),JSON.stringify({v:1,repository:{id:'fixture',name:'Fixture'},catalog:LAYOUT.graphSnapshot,context:{snapshot:LAYOUT.graphSnapshot}}));
 writeFileSync(join(root,LAYOUT.graphSnapshot),JSON.stringify({source:{path:LAYOUT.context}}));
 const script=`import {LAYOUT,migrateLayout} from ${JSON.stringify(new URL('../lib/layout.mjs',import.meta.url).href)};migrateLayout(process.argv[1]);console.log(JSON.stringify(LAYOUT));`;
 const renamed=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script,root],{encoding:'utf8',env:{...process.env,API_CONTEXT_PRODUCT_NAME:'renamed-tool',API_CONTEXT_COLLECTION_NAME:'renamed-collection'}}));
 const manifest=JSON.parse(readFileSync(join(root,renamed.graphManifest),'utf8'));
 assert.equal(manifest.catalog,renamed.graphSnapshot);assert.equal(manifest.context.snapshot,renamed.graphSnapshot);
 assert.equal(JSON.parse(readFileSync(join(root,renamed.graphSnapshot),'utf8')).source.path,renamed.context);
});
test('DOTSANNR-1 migration: a swapped destination ancestor cannot redirect a later move',async t=>{
 const {LAYOUT,migrateLayout}=await api();const root=temp(t),outside=temp(t);
 writeFileSync(join(root,CONTEXT_BASENAME),'{}');writeFileSync(join(root,'api-request.md'),'guide');
 const fs=(await import('node:fs')).default;const {syncBuiltinESMExports}=await import('node:module');const original=fs.linkSync;
 fs.linkSync=(from,to)=>{const result=original(from,to);if(to===join(root,LAYOUT.context))symlinkSync(outside,join(root,LAYOUT.skills),'dir');return result;};syncBuiltinESMExports();
 try {assert.throws(()=>migrateLayout(root),e=>e.code==='LAYOUT_UNSAFE_PATH');assert.deepEqual(fs.readdirSync(outside),[]);assert.ok(existsSync(join(root,'api-request.md')));}
 finally {fs.linkSync=original;syncBuiltinESMExports();}
});
test('DOTSANNR-1 layout: a fresh view writer creates the ignored local half before output',async t=>{
 const {LAYOUT}=await api();const {writeViewFile}=await import('../lib/view-records.mjs');const root=temp(t);
 const output=join(root,LAYOUT.evidence,'view','index.html');writeViewFile(root,output,'<!doctype html><title>Snapshot</title>');
 assert.ok(existsSync(join(root,LAYOUT.readme)));assert.match(readFileSync(join(root,LAYOUT.gitignore),'utf8'),/^\/evidence\//m);
 execFileSync('git',['init','-q'],{cwd:root});assert.equal(execFileSync('git',['check-ignore',output],{cwd:root,encoding:'utf8',stdio:'pipe'}).trim(),output);
});

test('feedback answers and future receipts are ignored immediately after connect, before any send', async t => {
 const {LAYOUT}=await api(); const parent=temp(t), root=join(parent,'repo'), home=join(parent,'home');
 mkdirSync(root);mkdirSync(home);execFileSync('git',['init','-q'],{cwd:root});
 const env={PATH:process.env.PATH,HOME:home,[HOME_ENV_NAME]:join(parent,'machine-state'),API_CONTEXT_DIR:root,NO_COLOR:'1'};
 const cli=new URL('../bin/cli.mjs',import.meta.url).pathname;
 const connect=()=>execFileSync(process.execPath,[cli,'connect','--no-skills','--no-pointers'],{cwd:root,env,encoding:'utf8'});
 connect();
 const ignore=join(root,LAYOUT.gitignore), initial=readFileSync(ignore,'utf8');
 const paths=[`${LAYOUT.directory}/feedback/answers.json`,`${LAYOUT.directory}/feedback/sent/fixture.json`,`${LAYOUT.directory}/feedback/drafts/note.txt`];
 mkdirSync(join(root,LAYOUT.directory,'feedback','sent'),{recursive:true});
 mkdirSync(join(root,LAYOUT.directory,'feedback','drafts'),{recursive:true});
 for(const path of paths)writeFileSync(join(root,path),'{}');
 assert.deepEqual(execFileSync('git',['check-ignore','--',...paths],{cwd:root,encoding:'utf8',stdio:'pipe'}).trim().split('\n'),paths);
 connect();assert.equal(readFileSync(ignore,'utf8'),initial,'connect should not grow ignore rules on every run');
 writeFileSync(ignore,initial+'!/feedback/\n');connect();
 assert.deepEqual(execFileSync('git',['check-ignore','--',...paths],{cwd:root,encoding:'utf8',stdio:'pipe'}).trim().split('\n'),paths);
});

test('feedback is reserved as a collection name so API knowledge cannot be silently ignored',t=>{
 const root=temp(t);
 const script=`import {ensureLayout} from ${JSON.stringify(new URL('../lib/layout.mjs',import.meta.url).href)};ensureLayout(process.argv[1]);`;
 assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',script,root],{encoding:'utf8',stdio:'pipe',env:{...process.env,API_CONTEXT_COLLECTION_NAME:'feedback'}}),error=>error.stderr.includes('LAYOUT_COLLECTION_CONFLICT'));
});
