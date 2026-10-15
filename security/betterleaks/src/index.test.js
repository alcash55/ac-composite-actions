import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.NODE_ENV = 'test';
const { scanOptions, scan, summary, verifyChecksum, install } = await import('./index.js');
const key = 'AKIA' + 'Q7WE2R3TY4U5I6OP';
const credentials = `AWS_ACCESS_KEY_ID=${key}\nAWS_SECRET_ACCESS_KEY=${'aB3dE5gH7jK9mN2pQ4sT6vW8yZ0cF1iL3oR5uX7z'}\n`;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'secret-test-'));
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  const commit = (file, contents) => {
    writeFileSync(join(repo, file), contents);
    git('add', '.');
    git('commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  return { directory, repo, git, commit };
}

test('diff resolves refs to SHAs and excludes base history', (t) => {
  const f = fixture(t);
  const base = f.commit('old.txt', 'old');
  const head = f.commit('new.txt', 'new');
  assert.deepEqual(scanOptions({ MODE: 'diff', BASE_REF: base }, f.repo), { mode: 'diff', logOpts: `${base}..${head}` });
  assert.throws(() => scanOptions({ MODE: 'diff', BASE_REF: '--all' }, f.repo), /history is missing/);
  assert.throws(() => scanOptions({ MODE: 'diff' }, f.repo), /needs BASE_REF/);
  assert.throws(() => scanOptions({ MODE: 'typo' }, f.repo), /MODE must/);
  assert.equal(scanOptions({ GITHUB_EVENT_NAME: 'push' }, f.repo).mode, 'full');
});

test('PR event scans head rather than the checkout merge commit', (t) => {
  const f = fixture(t);
  const base = f.commit('base.txt', 'base');
  const head = f.commit('head.txt', 'head');
  f.commit('merge.txt', 'synthetic merge');
  const event = join(f.directory, 'event.json');
  writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head } } }));
  assert.equal(scanOptions({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event }, f.repo).logOpts, `${base}..${head}`);
});

test('shallow checkout fails with actionable instructions', (t) => {
  const f = fixture(t);
  f.commit('file.txt', 'text');
  const shallow = join(f.directory, 'shallow');
  execFileSync('git', ['clone', '--depth=1', `file://${f.repo}`, shallow], { stdio: 'pipe' });
  assert.throws(() => scanOptions({ MODE: 'full' }, shallow), /fetch-depth: 0/);
});

test('checksum mismatch and unverified overrides fail closed', () => {
  assert.throws(() => verifyChecksum(Buffer.from('tampered'), '0'.repeat(64)), /checksum verification failed/);
  assert.throws(() => install('/tmp', { BETTERLEAKS_VERSION: '1.8.0' }), /requires BETTERLEAKS_SHA256/);
  assert.throws(() => install('/tmp', { BETTERLEAKS_VERSION: '../main' }), /stable version/);
});

test('summary escapes untrusted metadata and never uses the scanner match', () => {
  const output = summary({ mode: 'diff', findings: [{ file: '<img>|@user\nfile', line: 1, rule: 'aws', commit: 'abc', match: key }] });
  assert.ok(!output.includes(key));
  assert.ok(!output.includes('<img>'));
  assert.ok(!output.includes('@user'));
  assert.match(output, /REDACTED/);
});

const binary = process.env.BETTERLEAKS_TEST_BINARY;
test('real scanner: full finds old secret, diff ignores it, new key fails and allowlist suppresses it', { skip: !binary }, (t) => {
  const f = fixture(t);
  const base = f.commit('old.env', credentials);
  f.commit('clean.txt', 'hello');
  const full = scan(binary, f.directory, { MODE: 'full' }, f.repo);
  assert.ok(full.findings.some((finding) => finding.file === 'old.env' && finding.line === 1));
  assert.equal(scan(binary, f.directory, { MODE: 'diff', BASE_REF: base }, f.repo).findings.length, 0);
  const sha = f.commit('new.env', credentials);
  const diff = scan(binary, f.directory, { MODE: 'diff', BASE_REF: base }, f.repo);
  assert.ok(diff.findings.some((finding) => finding.file === 'new.env' && finding.commit === sha));
  assert.ok(!JSON.stringify(diff).includes(key));
  f.commit('.gitleaks.toml', '[extend]\nuseDefault = true\n[allowlist]\npaths = [\'\'\'new\\.env\'\'\', \'\'\'old\\.env\'\'\']\n');
  assert.equal(scan(binary, f.directory, { MODE: 'full' }, f.repo).findings.length, 0);
  writeFileSync(join(f.repo, '.gitleaks.toml'), 'not valid toml !');
  assert.throws(() => scan(binary, f.directory, { MODE: 'full' }, f.repo), /scan failed/);
});
