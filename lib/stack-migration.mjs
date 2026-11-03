// R7: deterministic, local-only stack migration. Plans expose names and paths;
// execution snapshots, credentials references and private evidence bytes remain
// in process-local storage. No response payload participates in classification.
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { CONTEXT_BASENAME, POINTER_CLI_NAME } from './brand.mjs';
import { LAYOUT, LEGACY_LAYOUT } from './layout.mjs';
import { operationsFrom, parseYaml } from './context.mjs';
import { operationIdentity, storedOperationEntries } from './operation-context.mjs';
import { parseAuthReference } from './auth-reference.mjs';
import { scanMetadataSecrets } from './verdicts.mjs';
import { CREDENTIAL_SHAPED_HEADER, SECRET_HEADERS } from './curl.mjs';
import { safeOutputPath } from './output-path.mjs';
import { validateStackDocument } from './stacks.mjs';

const executions = new WeakMap();
const MAX_JSON = 16 * 1024 * 1024, MAX_EVIDENCE = 64 * 1024 * 1024;
const STACK_FILE = 'stack.json';
const DEFAULTS = posix.join(LAYOUT.directory,'defaults.json');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const json = value => Buffer.from(`${JSON.stringify(value,null,2)}\n`);
const portable = value => value.split(sep).join('/');
const fail = (code,message,details={}) => { throw Object.assign(new Error(message),{code,details}); };
const inside = (root,path) => { const part=relative(root,path); return part==='' || part!=='..'&&!part.startsWith(`..${sep}`)&&!isAbsolute(part); };
function requireName(name) { if(typeof name!=='string'||!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)||name==='suites') fail('STACK_NAME_INVALID','Stack names must use 1–63 lowercase letters, digits or hyphens; suites is reserved.'); return name; }
const slug = title => { const value=String(title??'').replace(/\s+api\s*$/i,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,63).replace(/-$/,''); return value&&value!=='suites'?value:'api'; };
function present(path) { try { lstatSync(path); return true; } catch(error) { if(error.code==='ENOENT') return false; throw error; } }
function safe(root,path,directory=false) { const absolute=resolve(root,path); if(!inside(root,absolute)) fail('MIGRATION_UNSAFE_PATH','A migration path resolves outside the project.',{path:portable(path)}); safeOutputPath(absolute,{directory,code:'MIGRATION_UNSAFE_PATH'}); return absolute; }
function sourcePath(root,input) {
  const source=resolve(root,input);if(inside(root,source))return portable(relative(root,source));
  for(let ancestor=dirname(source);;ancestor=dirname(ancestor)) {
    try{if(realpathSync(ancestor)===root)return portable(relative(ancestor,source));}catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}
    if(dirname(ancestor)===ancestor)break;
  }
  fail('STACK_CONTRACT_OUTSIDE_PROJECT','A bound contract must stay inside the project.');
}
function read(root,path,max=MAX_JSON) {
  const absolute=safe(root,path); let fd;
  try {
    fd=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1) fail('MIGRATION_UNSAFE_PATH','Migration input must be a regular single-link file.',{path});
    if(stat.size>max) fail('MIGRATION_INPUT_LIMIT','Migration input exceeds its supported limit.',{path});
    const bytes=Buffer.alloc(Math.min(stat.size+1,max+1)); let size=0;
    while(size<bytes.length) { const count=readSync(fd,bytes,size,bytes.length-size,null); if(!count) break; size+=count; }
    if(size!==stat.size) fail('MIGRATION_SOURCE_CHANGED','Migration input changed while reading.',{path});
    safe(root,path); const atPath=lstatSync(absolute);
    if(atPath.ino!==stat.ino||atPath.dev!==stat.dev||atPath.size!==stat.size) fail('MIGRATION_SOURCE_CHANGED','Migration input changed while reading.',{path});
    return {path,bytes:bytes.subarray(0,size),size,digest:digest(bytes.subarray(0,size)),mode:stat.mode&0o777,max};
  } finally { if(fd!==undefined) closeSync(fd); }
}
function parsed(file) { try { const value=JSON.parse(file.bytes.toString('utf8')); if(!object(value)) throw Error(); return value; } catch { fail('MIGRATION_JSON_INVALID','Migration input must contain a JSON object.',{path:file.path}); } }
function validateDefaults(defaults) {
  const allowed=new Set(['default_stack','budget','timeoutMs','concurrency','evidenceDir','staleDays']);
  for(const key of Object.keys(defaults))if(!allowed.has(key))fail('MIGRATION_CONFIG_UNKNOWN_KEY',`Unknown client default '${key}'.`,{key});
  if(defaults.default_stack!==undefined)requireName(defaults.default_stack);
  try{scanMetadataSecrets(defaults,'MIGRATION_SECRET_LITERAL');}catch{fail('MIGRATION_SECRET_LITERAL','Client defaults contain a secret-shaped literal.');}
}
function urlOrigin(value) { try { const url=new URL(value); return ['http:','https:','ws:','wss:'].includes(url.protocol)&&!url.username&&!url.password?url.origin:null; } catch { return null; } }
function environment(value,label) {
  if(!object(value)||typeof value.baseUrl!=='string') fail('MIGRATION_ENVIRONMENT_INVALID','An environment requires a declared base URL.',{environment:label});
  let url; try {url=new URL(value.baseUrl);} catch { fail('MIGRATION_ENVIRONMENT_INVALID','An environment base URL is invalid.',{environment:label}); }
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash) fail('MIGRATION_ENVIRONMENT_INVALID','An environment base URL must omit credentials, query and fragment.',{environment:label});
  if(value.auth!==undefined&&value.auth!==''&&!parseAuthReference(value.auth)) fail('MIGRATION_AUTH_INVALID','An authentication setting must be a credential reference.',{environment:label});
  const allowed=new Set(['baseUrl','auth','envFile','production','contract','contractPathPrefix','headers','variables','concurrency','tokenUrl','scope','hosts']);
  for(const key of Object.keys(value)) if(!allowed.has(key)) fail('MIGRATION_CONFIG_UNKNOWN_KEY',`Unknown environment key '${key}'.`,{environment:label,key});
  for(const [header,item] of Object.entries(value.headers??{})) if(SECRET_HEADERS.test(header)||CREDENTIAL_SHAPED_HEADER.test(header)||typeof item!=='string') fail('MIGRATION_AUTH_INVALID','Credential headers must use authentication references.',{environment:label});
  const {hosts,...active}=value;
  if(value.contract!==undefined&&(typeof value.contract!=='string'||!value.contract))fail('MIGRATION_ENVIRONMENT_INVALID','A contract reference must be a nonempty path.',{environment:label});
  if(value.envFile!==undefined&&(typeof value.envFile!=='string'||!value.envFile))fail('MIGRATION_ENVIRONMENT_INVALID','An env-file reference must be a nonempty path.',{environment:label});
  if(value.production!==undefined&&typeof value.production!=='boolean')fail('MIGRATION_ENVIRONMENT_INVALID','The production setting must be boolean.',{environment:label});
  if(value.concurrency!==undefined&&(!Number.isFinite(value.concurrency)||value.concurrency<1))fail('MIGRATION_ENVIRONMENT_INVALID','Concurrency must be a positive number.',{environment:label});
  if(value.contractPathPrefix!==undefined&&(typeof value.contractPathPrefix!=='string'||!value.contractPathPrefix.startsWith('/')||/[?#]/.test(value.contractPathPrefix)))fail('MIGRATION_ENVIRONMENT_INVALID','A contract prefix must be an absolute path without query or fragment.',{environment:label});
  for(const key of ['headers','variables','hosts'])if(value[key]!==undefined&&!object(value[key]))fail('MIGRATION_ENVIRONMENT_INVALID',`Environment '${key}' must be an object.`,{environment:label});
  if(value.tokenUrl!==undefined){let token;try{token=new URL(value.tokenUrl);}catch{fail('MIGRATION_ENVIRONMENT_INVALID','An OAuth token URL is invalid.',{environment:label});}if(typeof value.tokenUrl!=='string'||!['http:','https:'].includes(token.protocol)||token.username||token.password||token.search||token.hash)fail('MIGRATION_ENVIRONMENT_INVALID','An OAuth token URL must omit credentials, query and fragment.',{environment:label});}
  if(value.scope!==undefined&&typeof value.scope!=='string')fail('MIGRATION_ENVIRONMENT_INVALID','OAuth scope must be a string.',{environment:label});
  try { scanMetadataSecrets(active,'MIGRATION_SECRET_LITERAL'); } catch { fail('MIGRATION_SECRET_LITERAL','Migration configuration contains a secret-shaped literal.',{environment:label}); }
  return structuredClone(active);
}
function splitsOf(input,environments) {
  const result=new Map(),used=new Set();
  const entries=Array.isArray(input)?input.map(item=>typeof item==='string'?item.split('='):[]):object(input)?Object.entries(input):input===undefined?[]:null;
  if(!entries) fail('MIGRATION_SPLIT_INVALID','Splits must name an environment and a destination stack.');
  for(const pair of entries) {
    if(pair.length!==2||!Object.hasOwn(environments,pair[0])||result.has(pair[0])) fail('MIGRATION_SPLIT_INVALID','A split must name one existing environment once.');
    requireName(pair[1]); if(used.has(pair[1])) fail('MIGRATION_SPLIT_CONFLICT','Each split must have its own destination stack.',{stack:pair[1]});
    result.set(pair[0],pair[1]); used.add(pair[1]);
  }
  return result;
}
function emptyStore(name,source) { return {v:0,api:{name},...(source?.generated_at?{generated_at:source.generated_at}:{}),operations:{},api_context:{v:1,operations:{}}}; }
function normalizedIdentity(identity,stack,environmentName=identity.environment) {
  const normalized=operationIdentity({...identity,environment:environmentName});
  const {v,stack:ignored,...rest}=normalized;
  return {v,stack,...rest};
}
function replacements(value,paths,ids=new Map()) {
  const result=structuredClone(value);
  const rewrite=(container,key)=>{const input=container?.[key];if(typeof input==='string'&&paths.has(input.replace(/^\.\//,'')))container[key]=paths.get(input.replace(/^\.\//,''));};
  // Only schema-owned references change. An authored/custom metadata object
  // whose key happens to be "path" or "file" is kept byte-for-byte as data.
  rewrite(result.api,'contract');
  for(const entry of Object.values(result.operations??{}))rewrite(entry,'source_file');
  for(const entry of Object.values(result.api_context?.operations??{}))for(const observation of entry.observations??[]) {
    for(const ref of observation.evidence??[])rewrite(ref,'path');
    if(ids.has(observation.based_on?.operation_id))observation.based_on.operation_id=ids.get(observation.based_on.operation_id);
  }
  for(const source of Object.values(result.imported_test_claims?.sources??{}))for(const claim of source.claims??[])rewrite(claim.evidence,'path');
  return result;
}
// Decode only object keys and the request's URL. All other scalar values are
// skipped lexically; response/header values are never materialized or returned.
function runTarget(bytes) {
  const source=bytes.toString('utf8'); let index=0,nodes=0;
  const whitespace=()=>{while(/\s/.test(source[index]??'')&&index<source.length)index++;};
  const string=decode=>{ whitespace(); if(source[index]!=='"')throw Error(); const start=index++; while(index<source.length) { const ch=source[index++]; if(ch==='\\') { index++; continue; } if(ch==='"') return decode?JSON.parse(source.slice(start,index)):null; if(ch<' ')throw Error(); } throw Error(); };
  function skip(depth=0) { if(depth>128||++nodes>1000000)throw Error(); whitespace(); const ch=source[index]; if(ch==='"'){string(false);return;} if(ch==='{'||ch==='['){const end=ch==='{'?'}':']';index++;whitespace();if(source[index]===end){index++;return;}for(;;){if(ch==='{'){string(false);whitespace();if(source[index++]!==':')throw Error();}skip(depth+1);whitespace();if(source[index]===end){index++;return;}if(source[index++]!==',')throw Error();}} else {const match=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(index));if(!match)throw Error();index+=match[0].length;} }
  function objectUrl(kind='root') { whitespace();if(source[index++]!=='{')throw Error();const seen=new Set();let target;whitespace();if(source[index]==='}'){index++;return;}for(;;){const key=string(true);whitespace();if(source[index++]!==':')throw Error();if(kind==='root'&&['request','identity'].includes(key)){if(seen.has(key))throw Error();seen.add(key);const candidate=objectUrl(key);if(candidate!==undefined){if(target!==undefined&&urlOrigin(target)!==urlOrigin(candidate))throw Error();target=candidate;}}else if(kind==='request'&&key==='url'||kind==='identity'&&key==='endpoint'){if(seen.has(key))throw Error();seen.add(key);target=string(true);}else skip();whitespace();if(source[index]==='}'){index++;return target;}if(source[index++]!==',')throw Error();} }
  try {const target=objectUrl();whitespace();return index===source.length&&typeof target==='string'?target:null;} catch {return null;}
}
function snapshots(root, virtualFiles) {
  const files=new Map();
  const virtual=virtualFiles instanceof Map?virtualFiles:new Map(Object.entries(virtualFiles??{}));
  return {files,virtual,has:path=>virtual.has(path)||present(join(root,path)),add(path,max=MAX_JSON) {
    if(virtual.has(path)) {
      const input=virtual.get(path),from=input.from??input.source;
      if(typeof from!=='string'||!Buffer.isBuffer(input.bytes)&&typeof input.bytes!=='string')fail('MIGRATION_VIRTUAL_INPUT_INVALID','A projected migration file needs source and bytes.',{path});
      if(!files.has(from))files.set(from,read(root,from,max));
      const bytes=Buffer.from(input.bytes);if(bytes.length>max)fail('MIGRATION_INPUT_LIMIT','A projected migration file exceeds its supported limit.',{path});
      return {...files.get(from),path,readPath:from,bytes,digest:digest(bytes),mode:input.mode??files.get(from).mode};
    }
    if(!files.has(path))files.set(path,read(root,path,max));return files.get(path);
  }};
}
function destination(root,writes,path,bytes,{mode=0o644,replace=false,privateFile=false}={}) {
  safe(root,path); const old=writes.get(path);
  if(old&&!old.bytes.equals(bytes)) fail('MIGRATION_CONFLICT','Two migration inputs name the same destination.',{path});
  if(old)return;
  let existing=null;
  if(present(join(root,path))) {existing=read(root,path,Math.max(MAX_JSON,bytes.length));if(!replace&&!existing.bytes.equals(bytes))fail('MIGRATION_CONFLICT','A migration destination already contains different bytes.',{path});if(privateFile&&existing.mode!==0o600)fail('MIGRATION_EVIDENCE_MODE_UNSAFE','An existing evidence destination must have mode 0600.',{path});}
  writes.set(path,{path,bytes,size:bytes.length,digest:digest(bytes),mode,existing,replace,privateFile});
}
function finishPlan(root,summary,sources,writes,deletes,cleanup=[]) {
  const plan={v:1,root,...summary,requests_executed:0};
  executions.set(plan,{root,sources,writes,deletes:new Set(deletes),cleanup,state:summary.state,preflightOnly:Boolean(summary.preflight_only),postWrites:new Map()}); return plan;
}

/** A dry, repeatable plan. Its JSON form contains paths/counts, never evidence. */
export function planStackMigration(inputRoot,{name,splits,virtualFiles}={}) {
  const root=realpathSync(resolve(inputRoot)); safe(root,'',true);
  for(const path of [LEGACY_LAYOUT.context,LEGACY_LAYOUT.environments,LEGACY_LAYOUT.hiddenEnvironments]) if(!virtualFiles&&present(join(root,path))) fail('LAYOUT_MIGRATION_REQUIRED','Migrate the earlier project layout before planning stack migration.',{command:`${POINTER_CLI_NAME} migrate --dry-run`});
  const sources=snapshots(root,virtualFiles),writes=new Map(),deletes=new Set(),moves=[],issues=[],suggestions=[];
  const hasConfig=sources.has(LAYOUT.environments),hasStore=sources.has(LAYOUT.context);
  if(!hasConfig&&!hasStore) {
    if(sources.has(LAYOUT.defaults)) {
      const file=sources.add(LAYOUT.defaults);validateDefaults(parsed(file));destination(root,writes,DEFAULTS,file.bytes,{mode:file.mode});
      return finishPlan(root,{state:'planned',...(virtualFiles?{preflight_only:true}:{}),stacks:[],suggestions,issues,moves:[{from:LAYOUT.defaults,to:DEFAULTS}]},sources.files,writes,[LAYOUT.defaults],[LAYOUT.config]);
    }
    return finishPlan(root,{state:'noop',stacks:[],suggestions,issues,moves},sources.files,writes,deletes);
  }
  const config=hasConfig?parsed(sources.add(LAYOUT.environments)):{},old=hasStore?parsed(sources.add(LAYOUT.context)):null;
  if(old&&(old.v!==0||!object(old.operations)||old.api_context&&(!object(old.api_context)||old.api_context.v!==1||!object(old.api_context.operations)))) fail('MIGRATION_CONTEXT_INVALID','The existing knowledge store is damaged.',{path:LAYOUT.context});
  if(old)try{storedOperationEntries(old);}catch{fail('MIGRATION_CONTEXT_INVALID','The existing observation history is damaged.',{path:LAYOUT.context});}
  for(const key of Object.keys(config)) if(!['v','default','environments','hosts','defaults'].includes(key)) fail('MIGRATION_CONFIG_UNKNOWN_KEY',`Unknown configuration key '${key}'.`,{key});
  if(config.environments!==undefined&&!object(config.environments)||config.hosts!==undefined&&!object(config.hosts))fail('MIGRATION_CONFIG_INVALID','Environments and hosts must be objects.');
  const environments=config.environments??{},split=splitsOf(splits,environments),contracts=new Map();
  function contract(path) {
    if(typeof path!=='string'||!path)return null;
    const ref=sourcePath(root,path);
    if(!contracts.has(ref)) {
      const file=sources.add(ref),raw=file.bytes.toString('utf8');let doc;
      try{doc=/^\s*[{[]/.test(raw)?JSON.parse(raw):parseYaml(raw);if(!object(doc))throw Error();}
      catch{fail('MIGRATION_CONTRACT_INVALID','A bound contract cannot be parsed safely.',{path:ref});}
      contracts.set(ref,{...file,doc,operations:new Set(operationsFrom(doc).map(route=>route.op))});
    }
    return contracts.get(ref);
  }
  const primaryContract=contract(old?.api?.contract);
  const defaultName=config.default??(Object.keys(environments).length===1?Object.keys(environments)[0]:null);
  if(Object.keys(environments).length&&(!defaultName||!Object.hasOwn(environments,defaultName)))fail('MIGRATION_DEFAULT_ENVIRONMENT_REQUIRED','Choose a valid legacy default environment before migration.',{available:Object.keys(environments)});
  const defaultContract=contract(environments[defaultName]?.contract)??primaryContract;
  const mainName=requireName(name??slug(old?.api?.name??defaultContract?.doc?.info?.title??'api'));
  if([...split.values()].includes(mainName)) fail('MIGRATION_SPLIT_CONFLICT','A split stack name conflicts with the primary stack.',{stack:mainName});
  const stacks=new Map(),routes=[];
  function addStack(stack,title) {requireName(stack);if(!stacks.has(stack))stacks.set(stack,{name:stack,title,environments:{},contracts:new Map(),store:emptyStore(title??stack,old)});return stacks.get(stack);}
  const main=addStack(mainName,old?.api?.name??defaultContract?.doc?.info?.title??mainName);
  // Repo-level extensions remain with the primary service instead of being
  // duplicated into every integration. The split records below are explicit.
  if(old) for(const [key,value] of Object.entries(old)) if(!['api','operations','api_context'].includes(key)) main.store[key]=structuredClone(value);
  if(old?.api)main.store.api={...structuredClone(old.api),name:main.title};
  if(old?.api_context)for(const [key,value] of Object.entries(old.api_context))if(!['v','operations'].includes(key)) {
    main.store.api_context[key]=structuredClone(value);issues.push({code:'MIGRATION_CONTEXT_EXTENSION_RETAINED',key,stack:mainName});
  }
  for(const key of Object.keys(old??{}))if(!['v','api','generated_at','operations','api_context'].includes(key))issues.push({code:'MIGRATION_REPO_EXTENSION_RETAINED',key,stack:mainName});
  function addEnvironment(stack,envName,value,sourceEnvironment,host=false) {
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(envName)) fail('MIGRATION_ENVIRONMENT_INVALID','An environment name is invalid.');
    const row=addStack(stack),active=environment(value,envName);
    const sharedPrimary=!host&&(sourceEnvironment===defaultName||urlOrigin(active.baseUrl)===urlOrigin(environments[defaultName]?.baseUrl));
    const ownContract=contract(active.contract)??(sharedPrimary?primaryContract:null);
    if(active.envFile&&!isAbsolute(active.envFile)&&!active.envFile.startsWith('~/')) active.envFile=portable(relative(join(root,LAYOUT.collection,stack),resolve(root,active.envFile)));
    // A global host and an environment named default can share this row.
    // Compare their effective references in the same coordinate system.
    const effective={...active,...(ownContract?{contract:ownContract.path}:{})};
    if(row.environments[envName]&&JSON.stringify(row.environments[envName])!==JSON.stringify(effective)) fail('MIGRATION_HOST_CONFLICT','Host definitions disagree on the same stack environment.',{stack,environment:envName});
    if(ownContract)row.contracts.set(ownContract.path,ownContract);
    row.environments[envName]=effective;
    routes.push({stack,origin:urlOrigin(active.baseUrl),environment:sourceEnvironment,toEnvironment:envName});
  }
  for(const envName of Object.keys(environments).sort()) {
    const env=environments[envName],target=split.get(envName)??mainName;
    addEnvironment(target,envName,env,envName);
    if(envName!==defaultName&&!split.has(envName)&&urlOrigin(env.baseUrl)!==urlOrigin(environments[defaultName].baseUrl)&&(env.contract??null)!==(environments[defaultName].contract??old?.api?.contract??null)) suggestions.push({code:'MIGRATION_SPLIT_SUGGESTED',environment:envName,stack:slug(envName),argument:`--split ${envName}=${slug(envName)}`});
  }
  if(!Object.keys(environments).length&&primaryContract)main.contracts.set(primaryContract.path,primaryContract);
  const hostNames=new Set(Object.keys(config.hosts??{})); for(const env of Object.values(environments)) for(const host of Object.keys(env.hosts??{})) hostNames.add(host);
  for(const host of [...hostNames].sort()) {
    if(host===mainName||[...split.values()].includes(host))fail('MIGRATION_HOST_CONFLICT','A host name conflicts with another stack.',{stack:host});
    const global=config.hosts?.[host];
    if(global) addEnvironment(host,'default',global,'*',true);
    for(const [envName,env] of Object.entries(environments)) if(Object.hasOwn(env.hosts??{},host))addEnvironment(host,envName,env.hosts[host],envName,true);
  }
  // A hosts-only configuration does not invent a third, empty service. Keep
  // genuinely repo-level extensions in the holding stack when no primary API
  // exists; ordinary headers/generation metadata are already retained per file.
  if(!Object.keys(environments).length&&!primaryContract&&hostNames.size) {
    stacks.delete(mainName);
    const extra=Object.entries(old??{}).filter(([key])=>!['v','api','generated_at','operations','api_context'].includes(key));
    const apiExtra=Object.entries(old?.api??{}).filter(([key])=>!['name','contract','contract_digest'].includes(key));
    const contextExtra=Object.entries(old?.api_context??{}).filter(([key])=>!['v','operations'].includes(key));
    if(extra.length||apiExtra.length||contextExtra.length){const holding=addStack('unsorted','Unsorted API knowledge');for(const [key,value] of extra)holding.store[key]=structuredClone(value);for(const [key,value] of apiExtra)holding.store.api[key]=structuredClone(value);for(const [key,value] of contextExtra)holding.store.api_context[key]=structuredClone(value);for(const issue of issues)if(issue.stack===mainName)issue.stack='unsorted';issues.push({code:'MIGRATION_METADATA_UNSORTED',stack:'unsorted'});}
  }
  // Select a contract once per stack, preserving per-environment overrides.
  const pathMoves=new Map(),sharedContractPaths=new Set();
  for(const row of stacks.values()) {
    row.document={v:1,name:row.name,...(row.title?{title:row.title}:{}),environments:{}};
    const names=Object.keys(row.environments).sort();
    if(names.length) row.document.default_environment=names.includes(defaultName)?defaultName:names.includes('default')?'default':names[0];
    const primary=row.environments[row.document.default_environment]?.contract??row.contracts.keys().next().value;
    const contractNames=new Map();
    for(const [source,file] of row.contracts) {
      const filename=basename(source);if([STACK_FILE,CONTEXT_BASENAME].includes(filename))fail('MIGRATION_CONFLICT','A contract filename conflicts with stack metadata.',{path:source});
      const to=posix.join(LAYOUT.collection,row.name,filename);destination(root,writes,to,file.bytes,{mode:file.mode});contractNames.set(source,filename);moves.push({from:source,to});deletes.add(source);
      // One source copied to two stacks has no unique global replacement; its
      // stack-specific header is rewritten below instead of choosing one.
      if(sharedContractPaths.has(source))continue;
      if(!pathMoves.has(source))pathMoves.set(source,to);else if(pathMoves.get(source)!==to){pathMoves.delete(source);sharedContractPaths.add(source);}
    }
    // A stack-wide fallback is faithful only when every environment owns that
    // same contract. Otherwise a contractless integration would acquire the
    // primary API's declarations merely because its environments stay grouped.
    const commonContract=primary&&(!names.length||names.every(envName=>row.environments[envName].contract===primary))?primary:undefined;
    if(commonContract)row.document.contract=contractNames.get(commonContract);
    for(const envName of names) {const env={...row.environments[envName]};if(env.contract===commonContract)delete env.contract;else if(env.contract)env.contract=contractNames.get(env.contract);row.document.environments[envName]=env;}
    if(primary) {row.store.api.contract=posix.join(LAYOUT.collection,row.name,contractNames.get(primary));row.store.api.contract_digest=row.contracts.get(primary).digest;}
  }
  function holding(){if(stacks.get('unsorted')&&Object.keys(stacks.get('unsorted').environments).length)fail('MIGRATION_CONFLICT','The unsorted holding stack conflicts with a configured service.',{stack:'unsorted'});return addStack('unsorted','Unsorted API knowledge');}
  for(const [operation,entry] of Object.entries(old?.operations??{})) {
    const owners=[...stacks.values()].filter(row=>[...row.contracts.values()].some(file=>file.operations.has(operation)));
    const owner=owners.length===1?owners[0]:holding();
    if(owners.length!==1)issues.push({code:owners.length?'MIGRATION_OPERATION_AMBIGUOUS':'MIGRATION_OPERATION_UNSORTED',operation,stack:'unsorted'});
    owner.store.operations[operation]=structuredClone(entry);
  }
  // Raw run files are private. Classification inspects only request.url, and
  // the unchanged bytes move to a private stack directory with mode 0600.
  const evidenceNames=new Set([...sources.virtual.keys()].filter(path=>posix.dirname(path)===LAYOUT.evidence).map(path=>posix.basename(path)));
  if(present(join(root,LAYOUT.evidence))) {safe(root,LAYOUT.evidence,true);for(const entry of readdirSync(join(root,LAYOUT.evidence),{withFileTypes:true}))evidenceNames.add(entry.name);}
  for(const run of [...evidenceNames].sort()) {
      if(!/^run-[A-Za-z0-9._-]+\.json$/.test(run))continue;
      const from=posix.join(LAYOUT.evidence,run),file=sources.add(from,MAX_EVIDENCE),origin=urlOrigin(runTarget(file.bytes));
      const owners=[...new Set(routes.filter(route=>origin&&route.origin===origin).map(route=>route.stack))],stack=owners.length===1?owners[0]:'unsorted';
      if(stack==='unsorted') {holding();issues.push({code:'MIGRATION_EVIDENCE_UNSORTED',run,stack});}
      const to=posix.join(LAYOUT.evidence,stack,run);destination(root,writes,to,file.bytes,{mode:0o600,privateFile:true});moves.push({from,to});pathMoves.set(from,to);deletes.add(from);
      // A plan retains only the raw file's identity, not hundreds of response
      // bodies. Apply reads/copies one private file at a time and checks its
      // digest again; no payload can enter the serialized plan.
      const output=writes.get(to);output.copyFrom=from;output.bytes=undefined;
      if(output.existing)output.existing.bytes=undefined;
      if(!virtualFiles)file.bytes=undefined;
  }
  const ids=new Map();
  for(const [id,entry] of Object.entries(old?.api_context?.operations??{})) {
    if(!object(entry)||!object(entry.identity)||!Array.isArray(entry.observations))fail('MIGRATION_CONTEXT_INVALID','An observation record is damaged.',{record:id});
    const identity=operationIdentity(entry.identity),origin=urlOrigin(identity.endpoint)??urlOrigin(identity.provider);
    let candidates=routes.filter(route=>origin&&route.origin===origin&&route.environment===identity.environment);
    if(!candidates.length)candidates=routes.filter(route=>origin&&route.origin===origin&&route.environment==='*');
    const unique=[...new Map(candidates.map(route=>[`${route.stack}\0${route.toEnvironment}`,route])).values()];
    const selected=unique.length===1?unique[0]:null,stack=selected?.stack??'unsorted';if(!selected){holding();issues.push({code:'MIGRATION_OBSERVATION_UNSORTED',record:id,stack});}
    const normalized=normalizedIdentity(identity,stack,selected?.toEnvironment??identity.environment),nextId=digest(JSON.stringify(normalized));ids.set(id,nextId);
    const row=stacks.get(stack),next={...structuredClone(entry),identity:normalized,migration:{from_operation_id:id,identity:structuredClone(entry.identity),observation_digests:Object.fromEntries(entry.observations.map(observation=>[observation.id,digest(JSON.stringify(observation))])),...(entry.migration?{previous:structuredClone(entry.migration)}:{})}};
    if(row.store.api_context.operations[nextId])fail('MIGRATION_CONFLICT','Two observation records normalize to the same identity.',{record:id,stack});
    row.store.api_context.operations[nextId]=next;
  }
  for(const row of stacks.values()) {
    if(!row.document)row.document={v:1,name:row.name,environments:{}};
    const scopedPaths=new Map(pathMoves);
    for(const path of row.contracts.keys())scopedPaths.set(path,posix.join(LAYOUT.collection,row.name,basename(path)));
    row.store=replacements(row.store,scopedPaths,ids);
  }
  const records=new Map([...stacks.values()].flatMap(row=>Object.entries(row.store.api_context.operations)));
  for(const row of stacks.values())for(const entry of Object.values(row.store.api_context.operations)) {
    for(const observation of entry.observations)if(observation.based_on) {
      const reference=observation.based_on,target=records.get(reference.operation_id),source=target?.observations.find(item=>item.id===reference.observation_id);
      if(source&&target.migration.observation_digests[source.id]===reference.observation_digest)reference.observation_digest=digest(JSON.stringify(source));
      else issues.push({code:'MIGRATION_OBSERVATION_REFERENCE_UNRESOLVED',record:entry.migration.from_operation_id});
    }
    for(const binding of [...(entry.legacy?[entry.legacy]:[]),...(entry.legacy_bindings??[])])if(binding.kind==='http-operation') {
      if(Object.hasOwn(row.store.operations,binding.key))binding.digest=digest(JSON.stringify(row.store.operations[binding.key]));
      else issues.push({code:'MIGRATION_LEGACY_BINDING_UNSORTED',operation:binding.key,stack:row.name});
    }
  }
  for(const row of stacks.values()) {
    const folder=posix.join(LAYOUT.collection,row.name),configuration=posix.join(folder,STACK_FILE),knowledge=posix.join(folder,CONTEXT_BASENAME);
    validateStackDocument(root,join(root,folder),row.name,row.document);
    destination(root,writes,configuration,json(row.document));destination(root,writes,knowledge,json(row.store));
    if(hasConfig)moves.push({from:LAYOUT.environments,to:configuration});if(hasStore)moves.push({from:LAYOUT.context,to:knowledge});
  }
  const standalone=sources.has(LAYOUT.defaults)?parsed(sources.add(LAYOUT.defaults)):{};
  if(config.defaults!==undefined&&!object(config.defaults))fail('MIGRATION_CONFIG_INVALID','Client defaults must be an object.');
  const defaultStack=split.get(defaultName)??(stacks.has(mainName)?mainName:undefined);
  const defaults={...standalone,...config.defaults,...(defaultStack?{default_stack:defaultStack}:{})};
  validateDefaults(defaults);
  destination(root,writes,DEFAULTS,json(defaults));
  if(sources.has(LAYOUT.defaults)){moves.push({from:LAYOUT.defaults,to:DEFAULTS});deletes.add(LAYOUT.defaults);}
  if(hasConfig)deletes.add(LAYOUT.environments);if(hasStore)deletes.add(LAYOUT.context);
  for(const path of [...deletes])if(writes.has(path))deletes.delete(path);
  const summary={state:'planned',...(virtualFiles?{preflight_only:true}:{}),stacks:[...stacks.values()].map(row=>({name:row.name,environments:Object.keys(row.document.environments),operations:Object.keys(row.store.operations).length,observations:Object.values(row.store.api_context.operations).reduce((sum,entry)=>sum+entry.observations.length,0)})),suggestions,issues,moves};
  return finishPlan(root,summary,sources.files,writes,deletes,[LAYOUT.config]);
}

function checkSnapshot(root,file,code,allowAbsent=false) {
  if(!present(join(root,file.path))) {if(allowAbsent)return;fail(code,'A planned migration file is no longer present.',{path:file.path});}
  if(read(root,file.path,file.max??Math.max(MAX_JSON,file.size)).digest!==file.digest)fail(code,'A planned migration file changed.',{path:file.path});
}
function writeDestination(root,file) {
  const target=safe(root,file.path);mkdirSync(dirname(target),{recursive:true});safe(root,file.path);
  if(present(target)) {const current=read(root,file.path,Math.max(MAX_JSON,file.size));if(current.digest===file.digest)return;if(!file.replace||!file.existing||current.digest!==file.existing.digest)fail('MIGRATION_CONFLICT','A destination changed before writing.',{path:file.path});}
  const bytes=file.copyFrom?read(root,file.copyFrom,Math.max(MAX_JSON,file.size)).bytes:file.bytes;
  if(digest(bytes)!==file.digest)fail('MIGRATION_SOURCE_CHANGED','A private evidence file changed before copying.',{path:file.copyFrom});
  const temp=join(dirname(target),`.stack-migration-${process.pid}-${randomBytes(12).toString('hex')}.tmp`);let fd,created=false;
  try {
    safeOutputPath(temp,{code:'MIGRATION_UNSAFE_PATH'});fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_NONBLOCK,file.mode);created=true;writeFileSync(fd,bytes);fsyncSync(fd);closeSync(fd);fd=undefined;
    safe(root,file.path);
    if(file.replace) {checkSnapshot(root,file.existing,'MIGRATION_CONFLICT');renameSync(temp,target);created=false;}
    else {try{linkSync(temp,target);}catch(error){if(error.code==='EEXIST')fail('MIGRATION_CONFLICT','A destination appeared before writing.',{path:file.path});throw error;}unlinkSync(temp);created=false;}
  } finally {if(fd!==undefined)closeSync(fd);if(created)try{unlinkSync(temp);}catch{/* preserve the original failure */}}
}
/** Write/read back every destination before removing any original source. */
export function applyStackMigration(plan) {
  const execution=executions.get(plan);if(!execution)fail('MIGRATION_PLAN_REQUIRED','Apply requires a freshly computed in-process dry-run plan.');
  if(execution.preflightOnly)fail('MIGRATION_CANONICAL_INPUTS_REQUIRED','Apply the preflighted earlier layout, then compute a fresh stack migration plan.');
  const {root,sources,writes,postWrites,deletes,cleanup}=execution;if(execution.state==='noop')return {...plan,applied:false};
  const lock=posix.join(LAYOUT.directory,'.stack-migration.lock');safe(root,lock);mkdirSync(join(root,LAYOUT.directory),{recursive:true});let fd,lockStat;
  try {
    try{fd=openSync(join(root,lock),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);lockStat=fstatSync(fd);}catch(error){if(error.code==='EEXIST')fail('MIGRATION_BUSY','Another migration or stack move is in progress.');throw error;}
    for(const file of sources.values())checkSnapshot(root,file,'MIGRATION_SOURCE_CHANGED');
    for(const file of [...writes.values(),...postWrites.values()]){safe(root,file.path);if(present(join(root,file.path))){const current=read(root,file.path,Math.max(MAX_JSON,file.size));if(file.privateFile&&current.mode!==0o600)fail('MIGRATION_EVIDENCE_MODE_UNSAFE','An existing evidence destination must have mode 0600.',{path:file.path});if(current.digest!==file.digest&&(!file.replace||!file.existing||current.digest!==file.existing.digest))fail('MIGRATION_CONFLICT','A destination changed after planning.',{path:file.path});}else if(file.replace&&file.existing)fail('MIGRATION_CONFLICT','A destination disappeared after planning.',{path:file.path});}
    for(const file of writes.values())writeDestination(root,file);
    for(const file of writes.values())if(read(root,file.path,Math.max(MAX_JSON,file.size)).digest!==file.digest)fail('MIGRATION_READBACK_FAILED','A migration destination failed readback.',{path:file.path});
    // A stack move removes an entry only after its destination store has been
    // read back. It does not rewrite the source as part of the first phase.
    for(const file of postWrites.values())writeDestination(root,file);
    for(const file of postWrites.values())if(read(root,file.path,Math.max(MAX_JSON,file.size)).digest!==file.digest)fail('MIGRATION_READBACK_FAILED','A stack-move source failed readback.',{path:file.path});
    for(const path of deletes){const file=sources.get(path);checkSnapshot(root,file,'MIGRATION_SOURCE_CHANGED');safe(root,path);unlinkSync(join(root,path));}
    for(const path of cleanup){safe(root,path,true);try{rmdirSync(join(root,path));}catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code))throw error;}}
    return {...plan,applied:true};
  } finally {if(fd!==undefined)closeSync(fd);if(lockStat)try{const stat=lstatSync(join(root,lock));if(stat.ino===lockStat.ino&&stat.dev===lockStat.dev)unlinkSync(join(root,lock));}catch{/* never remove a replacement lock */}}
}

/** Re-file a legacy operation without rewriting its authored note history. */
export function moveStackOperation(inputRoot,{to,operation,from}={}) {
  const root=realpathSync(resolve(inputRoot));requireName(to);if(from!==undefined)requireName(from);
  if(typeof operation!=='string'||!/^[A-Z]+ \/[^?#\r\n]*$/.test(operation))fail('STACK_MOVE_OPERATION_INVALID','Name one method/path operation without query values.');
  const base=join(root,LAYOUT.collection);safe(root,LAYOUT.collection,true);
  const sources=snapshots(root),candidates=[];let target;
  for(const entry of readdirSync(base,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){if(entry.isSymbolicLink())fail('MIGRATION_UNSAFE_PATH','A stack folder must not be a link.');if(!entry.isDirectory()||!present(join(base,entry.name,STACK_FILE)))continue;requireName(entry.name);const config=parsed(sources.add(posix.join(LAYOUT.collection,entry.name,STACK_FILE)));validateStackDocument(root,join(base,entry.name),entry.name,config);const path=posix.join(LAYOUT.collection,entry.name,CONTEXT_BASENAME),file=present(join(root,path))?sources.add(path):null,store=file?parsed(file):emptyStore(config.title??entry.name);if(!object(store.operations))fail('MIGRATION_CONTEXT_INVALID','A stack knowledge file is invalid.');const item={name:entry.name,path,file,store};if(entry.name===to)target=item;if(entry.name!==to&&(!from||entry.name===from)&&Object.hasOwn(store.operations,operation))candidates.push(item);}
  if(!target)fail('STACK_NOT_FOUND','The destination stack does not exist.',{stack:to});if(candidates.length>1)fail('STACK_MOVE_AMBIGUOUS','The operation occurs in more than one source stack; use --from.',{available:candidates.map(item=>item.name)});if(!candidates.length){if(Object.hasOwn(target.store.operations,operation))return {state:'noop',to,operation,requests_executed:0};fail('STACK_MOVE_OPERATION_NOT_FOUND','No source stack contains that operation.');}
  if(Object.hasOwn(target.store.operations,operation))fail('MIGRATION_CONFLICT','The destination already contains that operation.',{stack:to,operation});
  const source=candidates[0];target.store.operations[operation]=source.store.operations[operation];delete source.store.operations[operation];const writes=new Map();destination(root,writes,target.path,json(target.store),{replace:true});destination(root,writes,source.path,json(source.store),{replace:true});
  const plan=finishPlan(root,{state:'planned',from:source.name,to,operation,moves:[{from:source.path,to:target.path}],issues:[],suggestions:[],stacks:[]},sources.files,writes,[]);
  const execution=executions.get(plan);execution.postWrites.set(source.path,writes.get(source.path));writes.delete(source.path);
  return applyStackMigration(plan);
}
