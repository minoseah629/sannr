// Current-write specimens use a real named stack and the public resolver.
// Fixtures retaining the legacy layout must author saved snapshots directly.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, join, posix, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync } from './layout-fixture.mjs';
import { CONTEXT_BASENAME } from '../../lib/brand.mjs';
import { LAYOUT } from '../../lib/layout.mjs';
import { resolveStack } from '../../lib/stacks.mjs';
import { withStackScope } from '../../lib/stack-scope.mjs';
import { operationId } from '../../lib/operation-context.mjs';

export const fixtureContextFile = (root, name = 'fixture') => join(root, LAYOUT.collection, name, CONTEXT_BASENAME);
export const fixtureEvidencePath = (name = 'fixture') => posix.join(LAYOUT.evidence, name);
export function createFixtureStack(root, { name = 'fixture', title = 'Fixture API',
  environment = 'local', baseUrl = 'https://fixture.example.test', contract,
  environments, environmentConfig } = {}) {
  const folder = join(root, LAYOUT.collection, name);
  mkdirSync(folder, { recursive: true });
  if (contract) copyFileSync(resolve(root, contract), join(folder, basename(contract)));
  const configured = structuredClone(environments ?? { [environment]: { baseUrl } });
  if (environmentConfig) configured[environment] = {
    ...(configured[environment] ?? { baseUrl }), ...environmentConfig,
  };
  writeFileSync(join(folder, 'stack.json'), JSON.stringify({ v: 1, name, title,
    default_environment: environment, ...(contract ? { contract: basename(contract) } : {}),
    environments: configured }));
  mkdirSync(join(root, fixtureEvidencePath(name)), { recursive: true });
  return resolveStack(root, { stack: name });
}
export const inFixtureStack = (root, fn, name = 'fixture') => withStackScope(resolveStack(root, { stack: name }), fn);

// Map aggregation over named stacks belongs to STACKS-2. These explicit saved
// clones preserve historical map/view regression coverage without permitting
// a live request to write the retired single-store layout.
const historicalProjections = new Map();
export function registerHistoricalFixtureProjection(t, root, name = 'fixture') {
  const projection = realpathSync(mkdtempSync(join(tmpdir(), 'historical-map-projection-')));
  historicalProjections.set(root, { projection, name });
  t.after(() => { historicalProjections.delete(root); rmSync(projection, { recursive: true, force: true }); });
}
export function historicalFixtureProjection(root) {
  const selected = historicalProjections.get(root);
  if (!selected) return root;
  const { projection, name } = selected, folder = posix.join(LAYOUT.collection, name);
  const document = JSON.parse(readFileSync(join(root, folder, 'stack.json')));
  const contractPaths = new Set([document.contract, ...Object.values(document.environments).map(env => env.contract)].filter(Boolean));
  for (const path of contractPaths) {
    const target = join(projection, folder, path);
    mkdirSync(resolve(target, '..'), { recursive: true });
    copyFileSync(join(root, folder, path), target);
  }
  const context = JSON.parse(readFileSync(fixtureContextFile(root, name)));
  const identities = new Map();
  const projected = Object.fromEntries(Object.entries(context.api_context?.operations ?? {}).map(([id, entry]) => {
    const { stack, ...identity } = entry.identity;
    const legacyId = operationId(identity); identities.set(id, legacyId);
    return [legacyId, { ...entry, identity }];
  }));
  // The old reader's identity predates stack. This is explicitly a synthetic
  // historical snapshot, not a migrated store or a new observed assertion.
  if (context.api_context) context.api_context.operations = projected;
  const copiedEvidence = selected.copiedEvidence ??= new Set();
  for (const path of copiedEvidence) rmSync(join(projection, path), { force: true });
  copiedEvidence.clear();
  for (const entry of Object.values(projected)) for (const observation of entry.observations ?? []) {
    if (identities.has(observation.based_on?.operation_id)) observation.based_on.operation_id = identities.get(observation.based_on.operation_id);
    for (const ref of observation.evidence ?? []) if (existsSync(join(root, ref.path))) {
      const target = join(projection, ref.path);
      mkdirSync(resolve(target, '..'), { recursive: true });
      copyFileSync(join(root, ref.path), target);
      copiedEvidence.add(ref.path);
    }
  }
  writeFileSync(join(projection, LAYOUT.context), JSON.stringify(context));
  writeFileSync(join(projection, LAYOUT.environments), JSON.stringify({ v: 1,
    default: document.default_environment,
    environments: Object.fromEntries(Object.entries(document.environments).map(([environment, env]) => [environment,
      { ...env, ...((env.contract ?? document.contract) ? { contract: posix.join(folder, env.contract ?? document.contract) } : {}) }])) }));
  return projection;
}

// Compatibility controls for graph/pointer readers deferred to STACKS-2.
// All genuine writes still execute through a real resolved stack; only test
// setup copies the saved result into the historical reader's single store.
// Copy incoming fixture edits too, so integrity/security tests validate their
// exact specimen instead of silently restoring an earlier healthy record.
export function withFixtureProjection(root, fn) {
  const file = fixtureContextFile(root), legacy = join(root, LAYOUT.context);
  if (!existsSync(join(root, LAYOUT.collection, 'fixture', 'stack.json'))) createFixtureStack(root);
  if (existsSync(legacy)) writeFileSync(file, readFileSync(legacy));
  const result = inFixtureStack(root, fn);
  if (existsSync(file)) writeFileSync(legacy, readFileSync(file));
  return result;
}
