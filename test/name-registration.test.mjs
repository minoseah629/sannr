// NAME-1, 2026-10-06: synthetic migration specimens. These tests never launch
// an old command or contact an API. Dead launch paths deliberately stay dead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PRODUCT, MCP_SERVER_KEY, SKILL_NAMES } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { mcpTargets, projectEntry, planTarget, codexServerBlock, writeText,
  migrateSkillPlans, planSkills, SKILL_SOURCES, planRuntimeRepair } from '../lib/connect.mjs';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT,'bin','cli.mjs');
const legacyKey = 'api-request';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(),'name1-registration-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const entry = projectEntry(root, { file:join(root,LAYOUT.environments), name:'local', contract:join(root,'openapi.json') },
    { env:{}, nodePath:"node", launch:null });
  return { root, entry, targets:mcpTargets(root).filter(row=>['claude-code','codex'].includes(row.id)) };
}
function wire(target, entry, { key=legacyKey }={}) {
  return target.format==='toml' ? codexServerBlock(entry,key).replace(`# ${key}:managed-mcp-end`, `${Object.entries(entry).filter(([name])=>!['command','args','env'].includes(name)).map(([name,value])=>`${name} = ${JSON.stringify(value)}\n`).join('')}# ${key}:managed-mcp-end`)+'\n'
    : JSON.stringify({ metadata:'preserve this',mcpServers:{ unrelated:{command:'other',args:[]}, [key]:entry }},null,2)+'\n';
}
function keys(text,target) {
  return target.format==='toml' ? [...text.matchAll(/^\[mcp_servers\.([^\]]+)\]$/gm)].map(match=>match[1])
    : Object.keys(JSON.parse(text).mcpServers).filter(key=>key!=='unrelated');
}
test('NAME-1 a: fresh plans register only the product key in both hosts', t=>{
  const {entry,targets}=fixture(t);
  assert.equal(MCP_SERVER_KEY,PRODUCT);
  for(const target of targets) assert.deepEqual(keys(planTarget(null,target,entry).text,target),[PRODUCT]);
});
test('NAME-1 b: current-shape legacy registrations and Codex markers migrate without duplicate servers',t=>{
  const {entry,targets}=fixture(t);
  for(const target of targets) {
    const before=wire(target,entry), plan=planTarget(before,target,entry);
    assert.equal(plan.action,'update',target.id);
    assert.equal(plan.registeredKey,legacyKey);
    assert.deepEqual(keys(plan.text,target),[PRODUCT]);
    assert.doesNotMatch(plan.text,/# api-request:managed-mcp/);
    assert.equal(planTarget(plan.text,target,entry).action,'unchanged');
    const both=target.format==='toml' ? before+'\n'+wire(target,entry,{key:PRODUCT})
      : JSON.stringify({mcpServers:{[legacyKey]:entry,[PRODUCT]:entry}});
    const deduplicated=planTarget(both,target,entry);
    assert.notEqual(deduplicated.action,'conflict',deduplicated.reason);
    assert.deepEqual(keys(deduplicated.text,target),[PRODUCT]);
  }
});
test('NAME-1 c: migrated repositories replace dead pre-layout Node registrations in both hosts',t=>{
  const {root,entry,targets}=fixture(t);
  writeText(join(root,LAYOUT.marker),JSON.stringify({kind:'repo-api-layout',v:1,product:PRODUCT,collection:'stacks'}));
  // Frozen output from the actual pre-layout alpha.1 renderer, not today's
  // renderer with an invented earlier shape. Only the synthetic repo path varies.
  const frozen = JSON.parse(readFileSync(join(ROOT,'test','fixtures','name1-pre-layout-registration.json'),'utf8').replaceAll('{{ROOT}}',root));
  const old=frozen.entry;
  for(const target of targets) {
    const plan=planTarget(target.format==='toml' ? frozen.codex : wire(target,old),target,entry);
    assert.equal(plan.action,'update',`${target.id}: ${plan.reason}`);
    assert.deepEqual(keys(plan.text,target),[PRODUCT]);
    assert.doesNotMatch(plan.text,/Cellar|missing\/old-install/);
  }
});
test('NAME-1 d: locally customized legacy registrations conflict by name and stay byte-identical',t=>{
  const {root,entry,targets}=fixture(t);
  for(const target of targets) for(const old of [
    {...entry,args:[...entry.args,'--custom-flag']},
    {...entry,env:{...entry.env,TEAM_SETTING:'custom'}},
    {...entry,command:'/usr/local/bin/custom-node'},
    {...entry,cwd:root},
  ]) {
    const before=wire(target,old);
    writeText(target.file,before);
    const plan=planTarget(before,target,entry);
    assert.equal(plan.action,'conflict',`${target.id}: ${JSON.stringify(old)}`);
    assert.match(plan.reason,/api-request/);
    assert.equal(plan.text,undefined);
    assert.equal(readFileSync(target.file,'utf8'),before);
  }
  const target=targets.find(row=>row.id==='codex');
  const customized=wire(target,entry).replace('tool_timeout_sec = 330','tool_timeout_sec = 40');
  assert.equal(planTarget(customized,target,entry).action,'conflict');
});
const shipped = JSON.parse(readFileSync(join(ROOT,'test','fixtures','name1-shipped-skills.json'),'utf8'));
test('NAME-1 e: connect migrates exact shipped legacy-name skills and reports edited ones as conflicts',t=>{
  for(const specimen of shipped.filter(row=>row.role==='request')) for(const body of new Set(specimen.bodies)) {
    const {root}=fixture(t);
    for(const host of ['.claude','.agents']) {
      const old=join(root,host,'skills',legacyKey,'SKILL.md'); writeText(old,body);
      const plan=planSkills(root,{sources:[SKILL_SOURCES[0]]}).find(row=>row.host===(host==='.claude'?'claude-code':'codex'));
      assert.equal(plan.action,'updated',`${specimen.version}/${host}: ${plan.reason}`);
      assert.equal(plan.migratedFrom,old);
      assert.match(plan.body,new RegExp(`name: ${SKILL_NAMES.request}`));
      writeText(old,body+'\nTeam rule: retain the source owner.\n');
      const edited=planSkills(root,{sources:[SKILL_SOURCES[0]]}).find(row=>row.host===(host==='.claude'?'claude-code':'codex'));
      assert.equal(edited.action,'conflict');
      assert.ok(edited.reason.includes(old));
      assert.equal(readFileSync(old,'utf8'),body+'\nTeam rule: retain the source owner.\n');
    }
  }
});
test('NAME-1 e: migrate shares shipped skill ownership and never accepts appended instructions',t=>{
  for(const specimen of shipped) for(const body of new Set(specimen.bodies)) {
    const {root}=fixture(t);
    const name=specimen.role==='request' ? legacyKey : SKILL_NAMES[specimen.role];
    const old=join(root,'.claude','skills',name,'SKILL.md'); writeText(old,body);
    const row=migrateSkillPlans(root).find(row=>row.from===old);
    assert.ok(row,`${specimen.version}/${specimen.role}`);
    assert.notEqual(row.action,'conflict',`${specimen.version}/${specimen.role}: ${row.reason}`);
    assert.equal(row.to,join(root,'.claude','skills',SKILL_NAMES[specimen.role],'SKILL.md'));
    writeText(old,body+'\nTeam rule: require a source owner.\n');
    assert.equal(migrateSkillPlans(root).find(row=>row.from===old).action,'conflict');
  }
});
test('NAME-1: doctor runtime repair replaces owned legacy wiring only after layout migration',t=>{
  const {root,entry,targets}=fixture(t);
  for(const target of targets) {
    const before=wire(target,entry);
    assert.equal(planRuntimeRepair(before,target,entry).action,'refused');
    writeText(join(root,LAYOUT.marker),JSON.stringify({kind:'repo-api-layout',v:1,product:PRODUCT,collection:'stacks'}));
    const repair=planRuntimeRepair(before,target,entry);
    assert.equal(repair.action,'repair',target.id);
    assert.deepEqual(keys(repair.text,target),[PRODUCT]);
    rmSync(join(root,LAYOUT.marker));
  }
});
test('NAME-1 e: connect removes migrated legacy skills, reports every touched file and preserves edited conflicts',t=>{
  for(const edited of [false,true]) {
    const {root}=fixture(t);
    const home=join(root,'fixture-home'); mkdirSync(home);
    spawnSync('git',['init','-q'],{cwd:root});
    writeText(join(root,LAYOUT.environments),JSON.stringify({v:1,default:'local',environments:{local:{baseUrl:'https://api.example.test'}}}));
    writeText(join(root,'openapi.json'),JSON.stringify({openapi:'3.0.0',info:{title:'Example API',version:'1'},paths:{'/x':{get:{responses:{'200':{description:'ok'}}}}}}));
    const body=shipped.find(row=>row.version==='0.1.0-alpha.1'&&row.role==='request').bodies[0];
    const oldPaths=['.claude','.agents'].map(host=>join(root,host,'skills',legacyKey,'SKILL.md'));
    for(const path of oldPaths) writeText(path,body+(edited?'\nTeam rule: require a source owner.\n':''));
    const result=spawnSync(process.execPath,[CLI,'connect','--json'],{cwd:root,encoding:'utf8',
      env:{...process.env,HOME:home,[`${PRODUCT.toUpperCase()}_HOME`]:join(home,`.${PRODUCT}`),API_CONFIG:join(root,LAYOUT.environments),API_CONTEXT_DIR:root}});
    const report=JSON.parse(result.stdout);
    assert.equal(result.status,edited?1:0,result.stderr);
    if(edited) {
      assert.deepEqual(report.touched_files,[]);
      assert.ok(report.skills.filter(row=>row.action==='conflict').length>=2);
      for(const path of oldPaths) assert.equal(readFileSync(path,'utf8'),body+'\nTeam rule: require a source owner.\n');
      assert.equal(report.mcp.every(row=>row.action.startsWith('would ')),true);
    } else {
      for(const path of oldPaths) {
        assert.throws(()=>readFileSync(path),{code:'ENOENT'});
        assert.ok(report.touched_files.some(row=>row.path===path.slice(root.length+1)&&row.action==='removed'));
      }
      for(const host of ['.claude','.agents']) assert.match(readFileSync(join(root,host,'skills',SKILL_NAMES.request,'SKILL.md'),'utf8'),new RegExp(`name: ${SKILL_NAMES.request}`));
      const again=spawnSync(process.execPath,[CLI,'connect','--json'],{cwd:root,encoding:'utf8',
        env:{...process.env,HOME:home,[`${PRODUCT.toUpperCase()}_HOME`]:join(home,`.${PRODUCT}`),API_CONFIG:join(root,LAYOUT.environments),API_CONTEXT_DIR:root}});
      assert.equal(again.status,0,again.stderr);
      assert.ok(JSON.parse(again.stdout).skills.every(row=>row.action==='unchanged'));
    }
  }
});
test('NAME-1 e: legacy skill plus edited current skill is a named conflict without proposed deletion',t=>{
  const {root}=fixture(t), body=shipped.find(row=>row.role==='request').bodies[0];
  const old=join(root,'.claude','skills',legacyKey,'SKILL.md'); writeText(old,body);
  const current=join(root,'.claude','skills',SKILL_NAMES.request,'SKILL.md'); writeText(current,'Team-owned current skill\n');
  const plan=planSkills(root,{sources:[SKILL_SOURCES[0]]}).find(row=>row.host==='claude-code');
  assert.equal(plan.action,'conflict'); assert.ok(plan.reason.includes(current));
  assert.equal(plan.migratedFrom,undefined);
  assert.equal(readFileSync(old,'utf8'),body);
  assert.equal(readFileSync(current,'utf8'),'Team-owned current skill\n');
});
