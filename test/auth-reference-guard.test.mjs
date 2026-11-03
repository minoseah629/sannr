import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAuthReference } from '../lib/auth-reference.mjs';
import { secretIn as strictSecretIn, scanMetadataSecrets } from '../lib/verdicts.mjs';
import { authEnvVars } from '../lib/config.mjs';

const secretIn = text => strictSecretIn(text, { allowAuthReferences: true });
const references = ['bearer:ENV_NAME', 'header:X-API-Key:ENV_NAME', 'header:Authorization:ENV_NAME', 'query:api_key:ENV_NAME', 'oauth:CLIENT_ID_ENV:CLIENT_SECRET_ENV', 'basic:USER_ENV:PASS_ENV'];
for (const reference of references) test(`credential reference is safe in prose and metadata: ${reference}`, () => {
  assert.ok(parseAuthReference(reference));
  assert.ok(Array.isArray(authEnvVars(reference)));
  for (const text of [reference, `Use ${reference}.`, `Use \`${reference}\`, then retry.`, `Use (${reference}); then retry.`, `Use '${reference}'!`]) {
    assert.equal(secretIn(text), null, text);
    assert.doesNotThrow(() => scanMetadataSecrets({ reason: text }));
  }
});

test('auth parser rejects incomplete forms and preserves portable lowercase runtime references', () => {
  for (const ref of ['header:ENV_NAME', 'header::ENV_NAME', 'bearer:ENV:EXTRA', 'oauth:ONLY_ONE', 'oauth:A:B:C', 'basic:ENV_NAME', 'bearer:1_INVALID', 'bearer:ENV NAME', 'header:Bad Header:ENV', 'query:a&b:ENV']) {
    assert.equal(parseAuthReference(ref), null, ref);
    assert.ok(authEnvVars(ref).invalid, ref);
  }
  assert.deepEqual(parseAuthReference('bearer:lower_env'), { scheme: 'bearer', envVar: 'lower_env' });
  assert.equal(parseAuthReference('bearer:lower_env', { prose: true }), null);
  assert.deepEqual(parseAuthReference('basic:lower_user:lower_pass'), { scheme: 'basic', usernameEnv: 'lower_user', passwordEnv: 'lower_pass' });
  assert.deepEqual(authEnvVars('basic:USER_ENV:PASS_ENV'), ['USER_ENV', 'PASS_ENV']);
  assert.equal(parseAuthReference('basic:lower_user:lower_pass', { prose: true }), null);
  for (const ref of ['basic:USER_ENV:', 'basic::PASS_ENV', 'basic:A:B:C', 'basic:1_USER:PASS_ENV', 'basic:USER_ENV:literal-value']) {
    assert.equal(parseAuthReference(ref), null, ref);
    assert.throws(() => scanMetadataSecrets({ text: ref }), { code: 'IMPORT_SECRET_REFUSED' });
  }
});

test('only complete bounded uppercase references escape the inline-value heuristic', () => {
  for (const text of ['basic:ENV_NAME', 'bearer:literal_value', 'bearer:ENV_NAME/extra', 'bearer:ENV_NAME=extra', 'bearer:ENV_NAME:extra', '/bearer:ENV_NAME', '\\bearer:ENV_NAME', '?bearer:ENV_NAME', 'x:bearer:ENV_NAME', 'https://host.test/bearer:ENV_NAME', 'header:ENV_NAME', 'header:X-API-Key:ENV_NAME/extra', 'query:api_key:ENV_NAME?secret=abcdefg']) {
    assert.ok(secretIn(text), text);
    assert.throws(() => scanMetadataSecrets({ text }), { code: 'IMPORT_SECRET_REFUSED' });
  }
});

test('reference syntax never masks credentials elsewhere or known token shapes inside it', () => {
  for (const secret of ['ghp_syntheticfixture12345', 'eyJsyntheticlongsegment.eyJsyntheticsecondsegment.signature', '-----BEGIN PRIVATE KEY-----', 'https://user:password@host.test/', 'https://host.test/?token=fixturevalue', 'password=fixturepassword', 'Bearer abcdefghijklmnopqrstu', 'AKIA1234567890123456']) {
    assert.ok(secretIn(`bearer:ENV_NAME ${secret}`), secret);
    assert.throws(() => scanMetadataSecrets({ reason: `header:X-API-Key:ENV_NAME ${secret}` }), { code: 'IMPORT_SECRET_REFUSED' });
  }
  assert.ok(secretIn('bearer:AKIA1234567890123456'));
  assert.ok(secretIn('header:X-API-Key:AKIA1234567890123456'));
  assert.ok(secretIn('basic:USER_ENV:AKIA1234567890123456'));
});

test('credential validation never reads environment values', () => {
  process.env.GUARD_FIXTURE_ENV = 'ghp_syntheticfixture12345';
  try { assert.equal(secretIn('bearer:GUARD_FIXTURE_ENV'), null); }
  finally { delete process.env.GUARD_FIXTURE_ENV; }
});

test('executable payload scans remain strict by default', () => {
  assert.ok(strictSecretIn('bearer:ENV_NAME'));
  assert.ok(strictSecretIn('header:X-API-Key:ENV_NAME'));
  assert.ok(strictSecretIn('basic:USER_ENV:PASS_ENV'));
  assert.ok(strictSecretIn('basic:literal-user:literal-password'));
});
