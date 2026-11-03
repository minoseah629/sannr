import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LAYOUT } from '../../lib/layout.mjs';
import { recordGraphContext } from '../../lib/graph-record.mjs';
import { exportGraphSnapshot } from '../../lib/graph-export.mjs';

export const NODE = 'provider#api';
export const OPERATION = 'POST /invoices';
export const AT = '2026-08-01T12:00:00.000Z';
export const LOCAL_NOTE = 'account_id is required despite the contract.';
export const THIRD_NOTE = 'Recheck invoice prerequisites before relying on this third-party lesson.';
export const json = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data)); };

export function consumerManifest(id) {
  return { v: 1, repository: { id, name: id }, catalog: 'catalog', nodes: [],
    dependencies: [{ from: 'repo', to: NODE, kind: 'calls' }],
    context: { providers: [{ node: NODE, provider: 'billing', environment: 'staging', protocol: 'http' }] } };
}

// All persisted records belong to temporary projects supplied by the test.
export function createConsumerFixture(parent) {
  const create = id => {
    const root = join(parent, id);
    mkdirSync(join(root, 'catalog'), { recursive: true });
    json(join(root, LAYOUT.graphManifest), consumerManifest(id));
    return root;
  };
  const root = create('consumer'), third = create('third');
  const record = (project, note) => recordGraphContext(project, {
    node: NODE, operation: OPERATION, environment: 'staging', note, observed_at: AT,
  });
  record(root, LOCAL_NOTE); record(third, THIRD_NOTE);
  json(join(root, 'catalog', 'third.json'), exportGraphSnapshot(third));
  return { root, third, create };
}
