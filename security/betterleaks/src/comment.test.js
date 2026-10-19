import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
const { validateReport } = await import('./comment.js');
const sha = 'a'.repeat(40);
const source = { id: 42, event: 'pull_request', head_sha: sha, repository: { full_name: 'owner/repo' }, head_repository: { full_name: 'contributor/fork' } };
const pr = { number: 7, state: 'open', head: { sha, repo: { full_name: 'contributor/fork' } }, base: { repo: { full_name: 'owner/repo' } } };
const report = { version: 1, runId: '42', prNumber: 7, headSha: sha, total: 1, findings: [{ file: 'file.env', line: 1, rule: 'aws', commit: sha, match: 'never-display' }] };

test('accepts a matching fork PR report and strips any supplied secret', () => {
  const result = validateReport(report, source, pr, 'owner/repo');
  assert.equal(result.findings[0].match, '[REDACTED]');
  assert.ok(!JSON.stringify(result).includes('never-display'));
});
test('clean report clears findings, stale or closed reports cannot overwrite newer results', () => {
  assert.deepEqual(validateReport({ ...report, total: 0, findings: [] }, source, pr, 'owner/repo'), { total: 0, findings: [] });
  assert.equal(validateReport(report, source, { ...pr, head: { ...pr.head, sha: 'b'.repeat(40) } }, 'owner/repo'), null);
  assert.equal(validateReport(report, source, { ...pr, state: 'closed' }, 'owner/repo'), null);
});
test('rejects forged run, SHA, PR number, repository, and event associations', () => {
  for (const change of [{ runId: 99 }, { headSha: 'b'.repeat(40) }, { prNumber: 8 }, { total: 2 }, { findings: [{ ...report.findings[0], commit: 'bad' }] }]) {
    assert.throws(() => validateReport({ ...report, ...change }, source, pr, 'owner/repo'));
  }
  assert.throws(() => validateReport(report, { ...source, event: 'push' }, pr, 'owner/repo'));
  assert.throws(() => validateReport(report, source, pr, 'someone/else'));
  assert.throws(() => validateReport(report, source, { ...pr, head: { ...pr.head, repo: { full_name: 'another/fork' } } }, 'owner/repo'));
});
