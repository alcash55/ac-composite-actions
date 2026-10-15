import * as core from '@actions/core';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const VERSION = '1.9.0';
const CHECKSUMS = {
  x64: 'f8b185a39ffcece2a1ca82bf3a4e7435cd81963ffd16b7a9128daf75f35f6de7',
  arm64: '1d39116e0a58dc94574715e2aa12a2dbd5062f193eee3fec011fef6ba06bd13b',
};

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Required git history is missing. Use actions/checkout with fetch-depth: 0 and the PR head ref.');
  return result.stdout.trim();
}

export function scanOptions(env, cwd) {
  if (git(['rev-parse', '--is-shallow-repository'], cwd) !== 'false') {
    throw new Error('Shallow checkout. Use actions/checkout with fetch-depth: 0.');
  }
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const mode = env.MODE || (env.GITHUB_EVENT_NAME === 'pull_request' ? 'diff' : 'full');
  if (!['diff', 'full'].includes(mode)) throw new Error('MODE must be diff or full.');
  if (mode === 'full') return { mode, logOpts: '--all' };
  const base = env.BASE_REF || event.pull_request?.base?.sha;
  const head = event.pull_request?.head?.sha || 'HEAD';
  if (!base) throw new Error('Diff mode needs BASE_REF or a pull_request event.');
  // Resolve both refs before building --log-opts. Never pass user-supplied git options.
  const baseSha = git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], cwd);
  const headSha = git(['rev-parse', '--verify', '--end-of-options', `${head}^{commit}`], cwd);
  git(['merge-base', baseSha, headSha], cwd);
  return { mode, logOpts: `${baseSha}..${headSha}` };
}

export function verifyChecksum(bytes, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected || '') || createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new Error('Betterleaks archive checksum verification failed.');
  }
}

export function install(directory, env = process.env) {
  if (process.platform !== 'linux' || !CHECKSUMS[process.arch]) throw new Error('Betterleaks action requires Linux x64 or arm64.');
  const version = env.BETTERLEAKS_VERSION || VERSION;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('BETTERLEAKS_VERSION must be a stable version such as 1.9.0.');
  const checksum = env.BETTERLEAKS_SHA256 || (version === VERSION ? CHECKSUMS[process.arch] : '');
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error('A version override requires BETTERLEAKS_SHA256 for the runner architecture.');
  const archive = join(directory, 'release.tar.gz');
  const url = `https://github.com/betterleaks/betterleaks/releases/download/v${version}/betterleaks_${version}_linux_${process.arch}.tar.gz`;
  const download = spawnSync('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--retry', '3', '--output', archive, url]);
  if (download.status !== 0) throw new Error('Could not download the pinned Betterleaks release.');
  verifyChecksum(readFileSync(archive), checksum);
  const extract = spawnSync('tar', ['-xzf', archive, '-C', directory, 'betterleaks']);
  if (extract.status !== 0) throw new Error('Could not extract Betterleaks.');
  return join(directory, 'betterleaks');
}

export function scan(binary, directory, env = process.env, cwd = process.cwd()) {
  const { mode, logOpts } = scanOptions(env, cwd);
  const report = join(directory, 'report.json');
  const args = ['git', cwd, '--log-opts', logOpts, '--redact=100', '--no-banner', '--no-color', '--log-level=error', '--exit-code=10', '--report-format=json', '--report-path', report];
  const config = env.CONFIG_PATH || '.betterleaks.toml';
  if (existsSync(resolve(cwd, config))) args.push('--config', resolve(cwd, config));
  else if (env.CONFIG_PATH && !['.betterleaks.toml', '.gitleaks.toml'].includes(config)) throw new Error('CONFIG_PATH does not exist.');
  // Let the scanner discover .gitleaks.toml when the default config is absent.
  // Strip ambient settings so a runner cannot silently enable validation or change rules.
  const scannerEnv = Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([key]) => !/^(BETTERLEAKS_|GITLEAKS_)/.test(key)));
  const result = spawnSync(binary, args, { cwd, env: scannerEnv, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  // Never echo scanner output: even diagnostics can contain source text or credentials.
  if (![0, 10].includes(result.status)) throw new Error('Betterleaks scan failed. Check the consumer config and git history. Scanner diagnostics were withheld to protect secrets.');
  let raw;
  try {
    raw = JSON.parse(readFileSync(report, 'utf8'));
  } catch {
    throw new Error('Betterleaks did not produce a valid JSON report.');
  }
  if (!Array.isArray(raw) || (result.status === 10 && raw.length === 0)
    || raw.some((f) => typeof f.File !== 'string' || !Number.isInteger(f.StartLine)
      || typeof f.RuleID !== 'string' || typeof f.Commit !== 'string')) {
    throw new Error('Betterleaks returned an invalid report.');
  }
  const findings = raw.map((finding) => ({
    file: finding.File, line: finding.StartLine, rule: finding.RuleID,
    commit: finding.Commit, match: '[REDACTED]',
  }));
  return { mode, findings };
}

export function summary({ mode, findings }) {
  const cell = (value) => String(value ?? '').replace(/[&<>|`\r\n]/g, (c) => `&#${c.charCodeAt(0)};`).replace(/@/g, '&#64;');
  const lines = [`# Secret scan`, '', `${findings.length} finding(s), ${mode} mode.`, ''];
  if (findings.length) {
    lines.push('| File | Line | Rule | Commit | Match |', '|---|---|---|---|---|');
    for (const f of findings.slice(0, 100)) lines.push(`| ${cell(f.file)} | ${cell(f.line)} | ${cell(f.rule)} | ${cell(f.commit)} | [REDACTED] |`);
    if (findings.length > 100) lines.push('', 'Only the first 100 findings are shown.');
    lines.push('', 'Rotate any live credential. Removing it from the current tree does not remove it from history.');
  }
  return lines.join('\n');
}

export function reportFindings(findings) {
  return findings.slice(0, 100).map((f) => ({
    ...f, file: f.file.slice(0, 200), rule: f.rule.slice(0, 100),
  }));
}

export async function run(env = process.env) {
  const directory = mkdtempSync(join(tmpdir(), 'betterleaks-'));
  try {
    // Validate the checkout before downloading anything.
    scanOptions(env, process.cwd());
    const result = scan(install(directory, env), directory, env);
    core.setOutput('FINDINGS', JSON.stringify(result.findings));
    core.setOutput('HAS_FINDINGS', String(result.findings.length > 0));
    if (env.GITHUB_EVENT_NAME === 'pull_request') {
      const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
      const reportDir = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'betterleaks-result-'));
      const path = join(reportDir, 'result.json');
      // Bound the artifact and environment output used by the privileged reporter.
      const findings = reportFindings(result.findings);
      writeFileSync(path, JSON.stringify({
        version: 1, runId: env.GITHUB_RUN_ID, prNumber: event.number,
        headSha: event.pull_request.head.sha, total: result.findings.length, findings,
      }), { mode: 0o600 });
      core.setOutput('REPORT_PATH', path);
    }
    await core.summary.addRaw(summary(result)).write();
    if (result.findings.length) core.setFailed('Secret scan found credentials. See the redacted job summary.');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.env.NODE_ENV !== 'test') {
  run().catch((error) => core.setFailed(error.message));
}
