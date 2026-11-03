import { LAYOUT } from "../lib/layout.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,existsSync,realpathSync,rmSync,statSync} from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recordGraphContext} from '../lib/graph-record.mjs';
import {graphContext} from '../lib/agent-graph-context.mjs';
import {materializeRecordedSnapshot} from '../lib/graph-snapshot-write.mjs';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
function fixture(t,snapshot='share/context.json'){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'snapshot-independent-qa-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const manifest={v:1,repository:{id:'independent/web',name:'Independent QA'},dependencies:[{from:'repo',to:'independent/records#api',kind:'calls'}],context:{snapshot,providers:[{node:'independent/records#api',provider:'https://records.example.test',environment:'qa',protocol:'http'}]}};
 writeFileSync(join(root,LAYOUT.graphManifest),JSON.stringify(manifest));return {root,manifest};
}
const args={node:'independent/records#api',operation:'GET /records',environment:'qa',protocol:'http',note:'An external report describes a response sample; current applicability is unknown.'};

test('independent snapshot QA: a destination pointing at live context cannot replace it with an export',t=>{
 const {root}=fixture(t,LAYOUT.context);const result=recordGraphContext(root,args);
 assert.equal(result.state,'captured');assert.equal(result.snapshot.state,'failed');assert.equal(result.snapshot.lesson_saved,true);assert.equal(result.published,false);
 const context=read(join(root,LAYOUT.context));assert.ok(context.api_context);assert.equal(context.kind,undefined);
 const claims=Object.values(context.api_context.operations).flatMap(r=>r.observations);assert.equal(claims.length,1);assert.deepEqual(claims[0].notes,[args.note]);
});

test('independent snapshot QA: a destination pointing at the manifest preserves configuration and saved lesson',t=>{
 const {root}=fixture(t,LAYOUT.graphManifest),before=readFileSync(join(root,LAYOUT.graphManifest));
 const result=recordGraphContext(root,args);assert.equal(result.snapshot.state,'failed');assert.deepEqual(readFileSync(join(root,LAYOUT.graphManifest)),before);
 assert.equal(Object.values(read(join(root,LAYOUT.context)).api_context.operations).flatMap(r=>r.observations).length,1);
});

test('independent snapshot QA: nested evidence keeps digest references but is never implicitly copied into the sharing directory',async t=>{
 const {root}=fixture(t);mkdirSync(join(root,'evidence','program','run-1'),{recursive:true});const evidence='evidence/program/run-1/response.json';writeFileSync(join(root,evidence),'{"private":"nested-fixture-payload"}');
 const result=recordGraphContext(root,{...args,evidence:[{path:evidence}],observed_at:'2025-01-01T00:00:00.000Z'});
 assert.equal(result.snapshot.state,'written');assert.equal(result.snapshot.evidence_payloads_copied,false);if(process.platform!=='win32')assert.equal(statSync(join(root,'share/context.json')).mode&0o777,0o600);
 const snapshot=read(join(root,'share/context.json')),claim=snapshot.knowledge.find(r=>r.basis==='authored');assert.equal(claim.evidence[0].path,evidence);assert.match(claim.evidence[0].digest,/^sha256:[a-f0-9]{64}$/);assert.equal(claim.evidence[0].state,'unavailable');assert.equal(claim.observed_at,'2025-01-01T00:00:00.000Z');assert.equal(claim.verification,'external-claim');assert.doesNotMatch(JSON.stringify(snapshot),/nested-fixture-payload/);assert.equal(existsSync(join(root,'share','evidence')),false);
 const before=readFileSync(join(root,'share/context.json'));await graphContext(root,{action:'context',node:'independent/records#api'});assert.deepEqual(readFileSync(join(root,'share/context.json')),before,'read-only context query must not trigger snapshot publication');
});

test('independent snapshot QA: a configuration change while acquiring the publication lock fails safely without another lesson write',t=>{
 const {root,manifest}=fixture(t);const result=recordGraphContext(root,args);const beforeContext=readFileSync(join(root,LAYOUT.context)),beforeSnapshot=readFileSync(join(root,'share/context.json'));let calls=0;
 const failed=materializeRecordedSnapshot(root,()=>++calls===1?manifest:{...manifest,context:{...manifest.context,snapshot:'share/changed.json'}},result);
 assert.equal(failed.state,'failed');assert.equal(failed.code,'GRAPH_SNAPSHOT_CONFIGURATION_CHANGED');assert.equal(failed.lesson_saved,true);assert.equal(failed.published,false);
 assert.deepEqual(readFileSync(join(root,LAYOUT.context)),beforeContext);assert.deepEqual(readFileSync(join(root,'share/context.json')),beforeSnapshot);assert.equal(existsSync(join(root,'share/changed.json')),false);
});
