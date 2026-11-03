import { withFixtureProjection, fixtureEvidencePath } from './helpers/stack-fixture.mjs';
import { LAYOUT } from "../lib/layout.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,realpathSync} from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {captureOperationContext as captureRaw} from '../lib/operation-context.mjs';
import {recordGraphContext as recordRaw} from '../lib/graph-record.mjs';
import {graphContext} from '../lib/agent-graph-context.mjs';
import {createGraphSnapshot} from '../lib/dependency-graph.mjs';
import {exportGraphSnapshot} from '../lib/graph-export.mjs';

const captureOperationContext = (root,...args) => withFixtureProjection(root, () => captureRaw(root,...args));
const sha=value=>`sha256:${createHash('sha256').update(value).digest('hex')}`;
const identity={provider:'https://documents.example.test',environment:'qa',protocol:'http',operation:'GET /documents/{id}',endpoint:'https://documents.example.test/documents/example',contractDigest:sha('qa contract')};
const at='2026-07-01T01:02:03.000Z';
function fixture(t){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'agent-lifecycle-qa-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const manifest={v:1,repository:{id:'qa/consumer',name:'QA consumer'},dependencies:[{from:'repo',to:'qa/documents#api',kind:'calls'}],catalog:'catalog',context:{providers:[{node:'qa/documents#api',provider:identity.provider,environment:'qa',protocol:'http'}]}};
 writeFileSync(join(root,LAYOUT.graphManifest),JSON.stringify(manifest));mkdirSync(join(root,'catalog'));mkdirSync(join(root,fixtureEvidencePath()),{recursive:true});
 return {root,manifest};
}
const recordGraphContext = (root,...args) => withFixtureProjection(root, () => recordRaw(root,...args));
const raw=root=>readFileSync(join(root,LAYOUT.context),'utf8');
const query={action:'context',include_foreign_claims:true,node:'qa/documents#api',operation:identity.operation,environment:'qa'};
function observation(root,extra={}){return captureOperationContext(root,{identity,basis:'observed',source:{tool:'api_request'},outcome:'partial',complete:false,observed_at:at,response:{items:[]},omissions:['Only a bounded first response was available.'],...extra},{internal:true})}
function claim(id,note,extra={}){
 return {id:sha(id),node:'qa/documents#api',operation:identity.operation,protocol:'http',environment:'qa',contractDigest:identity.contractDigest,basis:'authored',verification:'external-claim',notes:[note],observed_at:at,recorded_at:at,source:{kind:'protocol-context',path:LAYOUT.context,record_id:id,digest:sha('container'),author:'qa-author',claim_kind:'external'},evidence:[],freshness:{state:'unknown',reason:'Saved claim only.'},omissions:['No deployment applicability has been established.'],...extra};
}
function publish(root,publisher,records){const snapshot=createGraphSnapshot({v:1,repository:{id:publisher,name:publisher},dependencies:[{from:'repo',to:'qa/documents#api',kind:'calls'}]},{knowledge:records,at});writeFileSync(join(root,'catalog',publisher.replaceAll('/','-')+'.json'),JSON.stringify(snapshot));return snapshot}

test('independent QA: recording from partial evidence retains limitations and never promotes completion',t=>{
 const {root}=fixture(t);const receipt=observation(root),before=JSON.parse(raw(root)).api_context.operations[receipt.operation_id].observations[0];
 const learned=recordGraphContext(root,{observation_id:receipt.observation_id,note:'The saved partial response included an empty items array; completeness is unknown.'});
 const [source,authored]=JSON.parse(raw(root)).api_context.operations[receipt.operation_id].observations;
 assert.deepEqual(source,before);assert.equal(authored.complete,false);assert.equal(authored.outcome,'unknown');assert.equal(authored.verification,'external-claim');assert.equal(authored.observed_at,at);
 assert.ok(authored.omissions.includes('Only a bounded first response was available.'));assert.match(authored.omissions.join(' '),/outcome was partial; completion was false/);assert.equal(learned.evidence.state,'absent');
 const exported=exportGraphSnapshot(root).knowledge.find(r=>r.basis==='authored');assert.equal(exported.based_on.observation_id,receipt.observation_id);assert.equal(exported.verification,'external-claim');
});

test('independent QA: one changed artifact in a multi-evidence observation rejects the complete write atomically',t=>{
 const {root}=fixture(t);for(const name of ['first','second'])writeFileSync(join(root,fixtureEvidencePath(),name+'.json'),JSON.stringify({private:name}));
 const receipt=observation(root,{evidence:[{path:`${fixtureEvidencePath()}/first.json`},{path:`${fixtureEvidencePath()}/second.json`}]}),before=raw(root);
 writeFileSync(join(root,fixtureEvidencePath(),'second.json'),'{"private":"changed"}');
 assert.throws(()=>recordGraphContext(root,{observation_id:receipt.observation_id,note:'A separately authored observation.'}),{code:'CONTEXT_EVIDENCE_CHANGED'});assert.equal(raw(root),before);
});

test('independent QA: a provider route move cannot borrow an old observation handle',t=>{
 const {root,manifest}=fixture(t),receipt=observation(root),before=raw(root);
 manifest.context.providers[0].provider='https://documents.example.test/v2';writeFileSync(join(root,LAYOUT.graphManifest),JSON.stringify(manifest));
 assert.throws(()=>recordGraphContext(root,{observation_id:receipt.observation_id,note:'A note from the previous exact provider.'}),{code:'GRAPH_RECORD_SCOPE_MISSING'});assert.equal(raw(root),before);
});

test('independent QA: all concise budget boundaries remain bounded with multibyte notes and retain intact smaller facts',async t=>{
 const {root}=fixture(t);publish(root,'qa/remote',[claim('large','観'.repeat(990)),claim('small','This dated sample is an authored claim, with current applicability unknown.')]);
 for(const max_bytes of [2000,2300,2600,3000,3500,4000,4500,5000,6000,64000]){
  const result=await graphContext(root,{...query,max_bytes});assert.equal(result.ok,true,JSON.stringify(result));assert.ok(Buffer.byteLength(JSON.stringify(result))<=max_bytes,`${max_bytes}: ${Buffer.byteLength(JSON.stringify(result))}`);
  for(const known of result.foreign_claims){assert.ok(['観'.repeat(990),'This dated sample is an authored claim, with current applicability unknown.'].includes(known.notes[0]));assert.equal(known.verification,'external-claim');assert.equal(known.observed_at,at);assert.deepEqual(known.omissions,['No deployment applicability has been established.']);}
  if(max_bytes===3000)assert.ok(result.foreign_claims.some(r=>r.notes[0].startsWith('This dated')),JSON.stringify(result));
 }
});

test('independent QA: detail references change with evidence and original learning time, with no silent record substitution',async t=>{
 const {root}=fixture(t),original=claim('note','Only the original response supports this dated statement.',{evidence:[{path:'evidence/original.json',digest:sha('one'),state:'unavailable'}]});publish(root,'qa/remote',[original]);
 const first=(await graphContext(root,query)).foreign_claims[0].detail_ref;
 publish(root,'qa/remote',[{...original,evidence:[{...original.evidence[0],digest:sha('two')}]}]);assert.equal((await graphContext(root,{action:'inspect',ref:first})).issues[0].code,'GRAPH_RECORD_NOT_FOUND');
 publish(root,'qa/remote',[{...original,observed_at:'2026-07-02T01:02:03.000Z'}]);assert.equal((await graphContext(root,{action:'inspect',ref:first})).issues[0].code,'GRAPH_RECORD_NOT_FOUND');
});

test('independent QA: linked lesson remains scoped to its original contract when the current checked-in contract changes',async t=>{
 const {root}=fixture(t),receipt=observation(root);writeFileSync(join(root,'openapi.json'),'{"info":{"version":"different"}}');
 recordGraphContext(root,{observation_id:receipt.observation_id,note:'This explanation is based on the earlier saved partial response.'});
 const result=await graphContext(root,{...query,include_foreign_claims:false}),learned=result.knowledge.find(r=>r.basis==='authored');assert.ok(learned,JSON.stringify(result));assert.equal(learned.publisher,'qa/consumer');assert.equal(learned.verification,'external-claim');assert.equal(result.omitted_foreign_claims??0,0);assert.equal(learned.contractDigest,identity.contractDigest);assert.equal(learned.observed_at,at);assert.equal(learned.based_on.observation_id,receipt.observation_id);assert.match(learned.omissions.join(' '),/current applicability was not reassessed/);assert.equal(result.requests_executed,0);
});
