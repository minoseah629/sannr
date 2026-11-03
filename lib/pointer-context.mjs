import { LAYOUT } from './layout.mjs';
// The managed block is another view of the same authored records. It carries
// bounded, scoped claims, never upgrades them to execution evidence, and never
// assumes that a manifest alone registered an optional MCP capability.
import { accessSync, constants, realpathSync, existsSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';

import { blockText, blockCode } from './block-text.mjs';
import { graphRecordTool } from './graph-record.mjs';
import { scanMetadataSecrets } from './verdicts.mjs';
import { installedMcpLaunch, pinnedMcpPackage } from './advertisement.mjs';
import { POINTER_CLI_NAME } from './brand.mjs';
import { inspectNoteHistory, loadContext } from './context.mjs';
import { stackEvidenceClasses, formatEvidenceClasses, rankNoteRecords } from './evidence-confidence.mjs';
import { projectKnownNotes } from './evidence-confidence.mjs';
import { loadNoteReadContext } from './note-read-model.mjs';
import { notePointerDataText, NOTE_DATA_MEANING } from './note-projection.mjs';
import { MAX_REQUEST_STACK_FACTS, stackFactsProjection } from './stack-facts.mjs';
import { currentStackScope, withStackScope } from './stack-scope.mjs';
import { stackCatalog, stackScope } from './stacks.mjs';
import { importedTestClaimCounts } from './imported-test-claims.mjs';
import { SETUP_BINDING_ENV, setupBindingId, validSetupBinding } from './setup-binding.mjs';

const MAX_LESSONS = 15;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function executableIdentity(command, cwd, env) {
  if (typeof command !== 'string' || !command) return null;
  const candidates = isAbsolute(command) || /[\\/]/u.test(command) ? [resolve(cwd, command)]
    : (env.PATH ?? '').split(delimiter).map(directory => resolve(cwd, directory || '.', command));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); }
    catch { continue; }
    // The first executable is what the host launches. A later Node entry in
    // PATH must not excuse an earlier executable with the same command name.
    try { return realpathSync(candidate); }
    catch { return null; }
  }
  return null;
}

export function registeredContextTools(root, registrations, serverPath) {
  const available = { read: false, record: false };
  let canonicalRoot, canonicalServer, nodePath;
  try { canonicalRoot = realpathSync(root); canonicalServer = realpathSync(serverPath); nodePath = realpathSync(process.execPath); }
  catch { return available; }
  const pinnedLaunch = installedMcpLaunch(dirname(canonicalServer));
  const packageSpec = pinnedMcpPackage(pinnedLaunch);
  const npxPath = packageSpec ? executableIdentity(pinnedLaunch.command, root,
    { ...process.env, ...pinnedLaunch.env }) : null;
  for (const registration of registrations) {
    if (registration.code || typeof registration.command !== 'string'
      || !Array.isArray(registration.args)) continue;
    const env = { ...process.env, ...registration.env };
    if (env.API_CONTEXT_OFF === '1') continue;
    try {
      const cwd = resolve(root, registration.cwd ?? '.');
      if (realpathSync(resolve(cwd, env.API_CONTEXT_DIR ?? '.')) !== canonicalRoot) continue;
      const registeredPackage = pinnedMcpPackage(registration);
      if (registeredPackage) {
        if (!packageSpec || registeredPackage !== packageSpec || !npxPath ||
            executableIdentity(registration.command, cwd, env) !== npxPath ||
            !validSetupBinding(registration.env?.[SETUP_BINDING_ENV]) ||
            setupBindingId(root, { command: registration.command, args: registration.args, env: registration.env }) !== registration.env[SETUP_BINDING_ENV]) continue;
      } else if (registration.args.length !== 1 || typeof registration.args[0] !== 'string' ||
          executableIdentity(registration.command, cwd, env) !== nodePath ||
          realpathSync(resolve(cwd, registration.args[0])) !== canonicalServer) continue;
      // This is the exact write-tool configuration check, with no process,
      // request, catalog delivery, or metrics side effect. A broken manifest
      // never earns workflow instructions merely because its filename exists.
      if (!graphRecordTool(root, { env })) continue;
      available.read = true;
      if (env.API_REQUEST_READ_ONLY !== '1') available.record = true;
    } catch { /* Missing or unsafe local configuration advertises no tools. */ }
  }
  return available;
}

export function renderInheritedLessons(ctx, { containsMachineLocalPath, contextPath = LAYOUT.context, showCommand, budget, maxLessons = MAX_LESSONS, heading = '###' }) {
  const limit = Math.max(0, Math.min(maxLessons, budget?.remaining ?? maxLessons));
  if (!object(ctx?.api_context?.operations)) return [];
  const lessons = [];
  let omitted = 0, total = 0;
  for (const entry of Object.values(ctx.api_context.operations)) {
    if (!object(entry?.identity) || !Array.isArray(entry.observations)) continue;
    for (const observation of entry.observations) {
      if (observation?.basis !== 'authored' || !Array.isArray(observation.notes)) continue;
      for (const note of observation.notes) {
        const scope = ['operation', 'provider', 'protocol', 'environment'].map(key => entry.identity[key]);
        if (typeof note !== 'string' || scope.some(value => typeof value !== 'string' || containsMachineLocalPath(value)) || containsMachineLocalPath(note)) { omitted++; continue; }
        try { scanMetadataSecrets({ scope, note }, 'POINTER_LESSON_UNSAFE'); }
        catch { omitted++; continue; }
        // Flatten at render time, including hand edits and imports. Do not
        // use the capture validator here: rejecting a legacy control/newline
        // must not lose an otherwise useful, safely rendered authored lesson.
        total++;
        if (lessons.length < limit) lessons.push({ scope, note });
      }
    }
  }
  if (!total && !omitted) return [];
  const lines = [`${heading} inherited lessons (authored, unverified)`, '',
    'These are scoped authored claims, not proof of current behavior.', ''];
  for (const { scope: [operation, provider, protocol, environment], note } of lessons) {
    lines.push(`- \`${blockCode(operation)}\` (provider \`${blockCode(provider, { max: 128 })}\`; protocol \`${blockCode(protocol, { max: 32 })}\`; environment \`${blockCode(environment, { max: 128 })}\`) — ${blockText(note)}`);
  }
  if (total > limit) lines.push(showCommand
    ? `- ${total - limit} inherited lessons omitted (per-stack cap ${MAX_LESSONS}${(budget?.remaining ?? MAX_LESSONS) < maxLessons ? `; total cap ${MAX_TOTAL_STACK_FACTS}` : ''}); read \`${showCommand}\`.`
    : `- …and ${total - limit} more inherited lessons in \`${contextPath}\`.`);
  if (budget) budget.remaining -= lessons.length;
  if (omitted) lines.push(`- ${omitted} inherited lesson${omitted === 1 ? '' : 's'} omitted from this managed block because the saved text or scope is unsafe or malformed.${showCommand ? ` Inspect \`${showCommand}\`.` : ''}`);
  return [...lines, ''];
}

// Keep the experiment's facts formatter untouched; stacks provide isolation
// and delivery bounds around it. Limits count saved facts, not output bytes.
export const MAX_STACK_FACTS = 15;
export const MAX_TOTAL_STACK_FACTS = 60;
export function renderStackContext(root, plannedContext, { portable, containsMachineLocalPath, renderMcp = () => [] } = {}) {
  const catalog = stackCatalog(root);
  if (!catalog.stacks.length) return null;
  if (catalog.problems.length) {
    const error = catalog.problems[0];
    throw Object.assign(new Error(error.message), error);
  }
  const selected = currentStackScope()?.stack;
  const ordered = [...catalog.stacks].sort((a, b) =>
    a.name === catalog.defaults.default_stack ? -1 : b.name === catalog.defaults.default_stack ? 1 : a.name.localeCompare(b.name));
  const budget = { remaining: MAX_TOTAL_STACK_FACTS };
  // Adding a stack-wide fact must not change the existing operation-facts
  // projection or its omissions. Bound the new prefix independently.
  const stackFactBudget = { remaining: MAX_TOTAL_STACK_FACTS };
  const lines = portable ? [] : ['Install the repo-local CLI before using the scoped commands below.', ''];
  for (const row of ordered) {
    const scope = stackScope(root, { stack: row.name, environment: row.document.default_environment });
    withStackScope(scope, () => {
      // connect/learn plan their pointer and knowledge writes together. Read
      // siblings from disk but use the selected stack's planned bytes here.
      const ctx = row.name === selected && plannedContext ? plannedContext : loadContext(root);
      const command = `${portable ?? POINTER_CLI_NAME} show --stack ${row.name}`;
      const environments = [...row.environmentNames].sort();
      const contract = scope.config.contract;
      const contractState = contract ? existsSync(contract) ? 'bound' : 'missing' : 'not_bound';
      const contractStates = environments.map(environment => {
        const path = stackScope(root, { stack: row.name, environment }).config.contract;
        return { environment, state: path ? existsSync(path) ? 'bound' : 'missing' : 'not_bound' };
      });
      const confidence = stackEvidenceClasses(root, ctx ?? {}, { commits: true });
      const operationCount = confidence.operations.size;
      // Committed instructions carry the decision, not the private inbox status.
      const noteRead = loadNoteReadContext(root, ctx, { runRequests: false });
      const gotchas = Object.entries(ctx?.operations ?? {}).flatMap(([op, entry]) => projectKnownNotes(entry, noteRead.forOperation(op)).records.map(record => ({ op, note: record.text, record })));
      const stackFacts = stackFactsProjection(ctx, { stack: row.name, maxFacts: Infinity });
      const contradictions = [...confidence.operations.values()].flatMap(operation => {
        const scopedFacts = stackFacts.records.filter(record => !record.provenance?.operations
          || record.provenance.operations.includes(operation.operation));
        const history = inspectNoteHistory(operation.entry, operation.operation);
        const basis = { summary: operation.summary, freshness: operation.freshness };
        return [...rankNoteRecords(scopedFacts, basis),
          ...rankNoteRecords(history.active, { ...basis, history })].filter(record => record.contradictions.length).map(record => ({ operation: operation.operation,
          kinds: record.contradictions }));
      });
      const safeStackFacts = stackFacts.records.filter(record => {
        if (containsMachineLocalPath(record.text)
          || record.provenance?.operations?.some(containsMachineLocalPath)) return false;
        try { scanMetadataSecrets({ note: record.text, operations: record.provenance?.operations ?? [] }, 'POINTER_LESSON_UNSAFE'); return true; }
        catch { return false; }
      });
      const stackLimit = Math.min(MAX_REQUEST_STACK_FACTS, stackFactBudget.remaining);
      const shownStackFacts = safeStackFacts.slice(0, stackLimit);
      const withheldStackFacts = stackFacts.history.active.length - safeStackFacts.length;
      const safe = gotchas.filter(({ note }) => !containsMachineLocalPath(note));
      const withheld = gotchas.length - safe.length;
      const limit = Math.min(MAX_STACK_FACTS, budget.remaining);
      const shown = safe.slice(0, limit);
      const omitted = safe.length - shown.length;
      const lifecycle = operationCount && confidence.counts.observed + confidence.counts.asserted + confidence.counts.verified === 0
        ? 'No current response, passing assertion or learn verification is counted.'
        : 'This is the current committed knowledge and retains its execution evidence.';
      lines.push(`### Stack \`${row.name}\``, '',
        `Environments: ${environments.length ? environments.map(name => `\`${blockCode(name)}\``).join(', ') : 'none'}. Contract: ${contractState}${row.document.default_environment ? ` (default environment \`${blockCode(row.document.default_environment)}\`)` : ''}.`,
        ...(contractStates.some(state => state.state !== contractState) ? [
          `Contract by environment: ${contractStates.map(({ environment, state }) => `\`${blockCode(environment)}\`: ${state}`).join('; ')}.`,
        ] : []), '',
        `API knowledge for this service is in \`${scope.contextFile}\` — ${operationCount} operation${operationCount === 1 ? '' : 's'}; ${formatEvidenceClasses(confidence.counts)}. ` +
        'It records learned response shapes, field values allowed by the contract, and how recently every execution-derived claim was checked. ' + lifecycle, '');
      if (!ctx) lines.push(`No saved knowledge yet. Read \`${command}\` for this stack's current state.`, '');
      if (row.name === 'unsorted') lines.push(`${operationCount} operation${operationCount === 1 ? '' : 's'} awaiting a destination stack. Re-file with \`${portable ?? POINTER_CLI_NAME} stack move --to <stack> "<METHOD /path>"\`.`, '');
      const testCounts = ctx ? importedTestClaimCounts(ctx) : { total: 0 };
      if (testCounts.total) lines.push(`${testCounts.total} claims from imported tests are stored separately in \`imported_test_claims\`; they are not included in the verified-operation count. Read their source, conditions and individual execution evidence before relying on them.`, '');
      for (const item of contradictions.slice(0, 5)) lines.push(`Contradicted authored note for \`${blockCode(item.operation)}\`: ${item.kinds.join(', ')} differs from the latest response. The claim is retained; inspect \`${command}\`.`, '');
      if (contradictions.length > 5) lines.push(`${contradictions.length - 5} more contradiction flags omitted; inspect \`${command}\`.`, '');
      if (safeStackFacts.length || withheldStackFacts) {
        lines.push('**Stack facts** (authored, unverified):', '');
        for (const fact of shownStackFacts) {
          const operations = fact.provenance?.operations;
          const applies = operations?.length ? `Only ${operations.map(op => `\`${blockCode(op)}\``).join(', ')}` : 'Every operation';
          lines.push(`- ${applies} — ${blockText(fact.text)} [${blockText(notePointerDataText(fact, containsMachineLocalPath))}]`);
        }
        const omittedFacts = safeStackFacts.length - shownStackFacts.length;
        if (omittedFacts) lines.push(`- ${omittedFacts} stack facts omitted (stack-fact cap ${MAX_REQUEST_STACK_FACTS}${stackLimit < MAX_REQUEST_STACK_FACTS ? `; stack-fact total cap ${MAX_TOTAL_STACK_FACTS}` : ''}); read \`${command}\`.`);
        if (withheldStackFacts) lines.push(`- ${withheldStackFacts} stack facts withheld because their text or operation scope is unsafe or malformed; inspect \`${command}\`.`);
        lines.push('');
      }
      if (safe.length || withheld) {
        lines.push('**Known gotchas** (do not rediscover these):', '', NOTE_DATA_MEANING, '');
        for (const fact of shown) lines.push('- `' + blockCode(fact.op) + '` — ' + blockText(fact.note) + ' [' + blockText(notePointerDataText(fact.record, containsMachineLocalPath)) + ']');
        if (omitted) lines.push(`- ${omitted} gotchas omitted (per-stack cap ${MAX_STACK_FACTS}${limit < MAX_STACK_FACTS ? `; total cap ${MAX_TOTAL_STACK_FACTS}` : ''}); read \`${command}\`.`);
        if (withheld) lines.push(`- ${withheld} gotcha${withheld === 1 ? '' : 's'} omitted because the saved text contains a machine-local absolute path; inspect \`${command}\`.`);
        lines.push('');
      }
      budget.remaining -= shown.length;
      stackFactBudget.remaining -= shownStackFacts.length;
      lines.push(...renderInheritedLessons(ctx, { containsMachineLocalPath, contextPath: scope.contextFile, showCommand: command, budget, maxLessons: MAX_STACK_FACTS - shown.length, heading: '####' }));
      lines.push(...renderMcp(ctx));
    });
  }
  return lines;
}
