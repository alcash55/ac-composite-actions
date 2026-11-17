import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { parseSecrets, parseSecretList, selectSecrets, envBlock, summary, verifyChecksum, resolveRelease } =
  await import('./index.js');

const id = '382580ab-1368-4e85-bfa3-b02e01400c9f';
const otherId = 'be8e0ad8-d545-4017-a55a-b02f014d4158';
const project = 'e325ea69-a3ab-4dff-836f-b02e013fe530';
const secret = (overrides = {}) => ({ id, key: 'DB_PASSWORD', value: 'v', projectId: project, ...overrides });

test('parseSecrets reads pairs and ignores comments', () => {
  assert.deepEqual(parseSecrets(`# mine\n\n${id} > ONE\n${otherId}   >   TWO  \n`), [
    { id, name: 'ONE' },
    { id: otherId, name: 'TWO' },
  ]);
  assert.deepEqual(parseSecrets(''), []);
});

test('parseSecrets rejects malformed lines and bad names', () => {
  assert.throws(() => parseSecrets('not a pair'), /line 1 must be/);
  assert.throws(() => parseSecrets('not-a-uuid > ONE'), /invalid secret id/);
  assert.throws(() => parseSecrets(`${id} > 1BAD`), /invalid env name "1BAD"/);
  assert.throws(() => parseSecrets(`${id} > HAS-DASH`), /invalid env name/);
  assert.throws(() => parseSecrets(`${id} > SAME\n${otherId} > SAME`), /more than once/);
});

test('parseSecretList validates the CLI output', () => {
  assert.deepEqual(parseSecretList(JSON.stringify([{ id, key: 'K', value: 'v', projectId: project }])), [
    { id, key: 'K', value: 'v', projectId: project },
  ]);
  assert.equal(parseSecretList(JSON.stringify([{ id, key: 'K', value: 'v' }]))[0].projectId, null);
  assert.throws(() => parseSecretList('not json'), /invalid JSON/);
  assert.throws(() => parseSecretList('{}'), /unexpected secret list/);
  assert.throws(() => parseSecretList(JSON.stringify([{ id, key: 'K' }])), /unexpected secret list/);
});

test('project mode exports every secret by key', () => {
  const selected = selectSecrets([secret(), secret({ id: otherId, key: 'API_KEY', value: 'k' })], { projectId: project });
  assert.deepEqual([...selected], [['DB_PASSWORD', 'v'], ['API_KEY', 'k']]);
});

test('explicit mode exports by id under the requested name', () => {
  const selected = selectSecrets([secret()], { pairs: [{ id, name: 'DATABASE_URL' }] });
  assert.deepEqual([...selected], [['DATABASE_URL', 'v']]);
});

test('project and explicit modes combine, and an explicit name can alias a project secret', () => {
  const secrets = [secret(), secret({ id: otherId, key: 'API_KEY', value: 'k' })];
  const selected = selectSecrets(secrets, { projectId: project, pairs: [{ id: otherId, name: 'STRIPE_KEY' }] });
  assert.deepEqual([...selected], [['DB_PASSWORD', 'v'], ['API_KEY', 'k'], ['STRIPE_KEY', 'k']]);
});

test('selection fails loudly on the mistakes that silently lose a secret', () => {
  assert.throws(() => selectSecrets([secret()], { pairs: [{ id: otherId, name: 'X' }] }), /was not found/);
  assert.throws(() => selectSecrets([secret()], { projectId: project, pairs: [{ id, name: 'DB_PASSWORD' }] }), /both PROJECT_ID and SECRETS/);
  assert.throws(() => selectSecrets([secret({ key: 'Not A Name' })], { projectId: project }), /not a valid environment variable name/);
  assert.throws(() => selectSecrets([], { projectId: project }), /No secrets were found in project/);
  const outside = selectSecrets([secret({ projectId: 'elsewhere' })], { projectId: project, pairs: [{ id, name: 'X' }] });
  assert.deepEqual([...outside.keys()], ['X']);
});

test('envBlock keeps multiline values intact and dodges the delimiter', () => {
  const block = envBlock(new Map([['ONE', 'a\nb'], ['TWO', 'EOF_TEST_2']]), 'EOF_TEST_2');
  assert.match(block, /^ONE<<EOF_TEST_2X\na\nb\nEOF_TEST_2X\n/m);
  assert.match(block, /TWO<<EOF_TEST_2X\nEOF_TEST_2\nEOF_TEST_2X\n/);
});

test('summary names variables but never carries values', () => {
  const output = summary(new Map([['DB_PASSWORD', 'super-secret-value']]), { projectId: project, pairs: [] });
  assert.match(output, /DB_PASSWORD/);
  assert.match(output, /PROJECT_ID/);
  assert.ok(!output.includes('super-secret-value'));
});

test('checksum verification fails closed', () => {
  const bytes = Buffer.from('release');
  assert.doesNotThrow(() => verifyChecksum(bytes, createHash('sha256').update(bytes).digest('hex')));
  assert.throws(() => verifyChecksum(bytes, '0'.repeat(64)), /checksum verification failed/);
  assert.throws(() => verifyChecksum(bytes, 'not-hex'), /checksum verification failed/);
});

test('release config is validated before anything is downloaded', () => {
  assert.throws(() => resolveRelease({ BWS_VERSION: '../main' }), /stable version/);
  assert.throws(() => resolveRelease({ BWS_VERSION: '1.0.0' }), /requires BWS_SHA256/);
});

test('reserved runner variable names are rejected in both modes', () => {
  for (const name of ['PATH', 'LD_PRELOAD', 'NODE_OPTIONS', 'BASH_ENV', 'GITHUB_TOKEN', 'RUNNER_TEMP', 'BWS_ACCESS_TOKEN']) {
    assert.throws(() => parseSecrets(`${id} > ${name}`), /reserved/, `SECRETS name ${name} should be rejected`);
    assert.throws(() => selectSecrets([secret({ key: name })], { projectId: project }), /reserved/, `project key ${name} should be rejected`);
  }
  assert.deepEqual(parseSecrets(`${id} > GH_TOKEN`), [{ id, name: 'GH_TOKEN' }]);
});

test('running the entry point under NODE_ENV=test still runs the action', () => {
  const entry = fileURLToPath(new URL('./index.js', import.meta.url));
  const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'test' } });
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stdout: ${result.stdout}`);
  assert.match(result.stdout, /ACCESS_TOKEN is required/);
});
