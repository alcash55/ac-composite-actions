import * as core from '@actions/core';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VERSION = '2.1.0';
// Verified with `gh release download bws-v2.1.0` and a local SHA256 check.
const CHECKSUMS = {
  x64: 'ba8233c3a4aee5d43e3c73bbd04d99e9bc5aba13bbbfd06d89b073abe732b860',
  arm64: '18253757286e119d450133a87eb463bf8c1ce418ce24c834f4f250d60cba6f9e',
};
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX256 = /^[a-f0-9]{64}$/;
// GITHUB_ENV applies to every later step, so a vault key named PATH, LD_PRELOAD
// or GITHUB_TOKEN would change how the rest of the job runs.
const RESERVED = /^(PATH|HOME|SHELL|IFS|ENV|BASH_ENV|NODE_OPTIONS|(GITHUB|RUNNER|ACTIONS|INPUT|BWS|LD|DYLD)_.*)$/;

function reservedName(name) {
  return RESERVED.test(name.toUpperCase());
}

export function verifyChecksum(bytes, expected) {
  if (!HEX256.test(expected || '') || createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new Error('Bitwarden Secrets Manager CLI archive checksum verification failed.');
  }
}

/**
 * Parses the SECRETS input into { id, name } pairs.
 * A bad line names its own line number so a typo is fixable without scrolling
 * through the whole block.
 */
export function parseSecrets(raw = '') {
  const pairs = [];
  const names = new Set();
  String(raw).split(/\r?\n/).forEach((line, index) => {
    const text = line.trim();
    if (!text || text.startsWith('#')) return;
    const match = /^(\S+)\s*>\s*(\S+)$/.exec(text);
    if (!match) throw new Error(`SECRETS line ${index + 1} must be "SECRET_ID > ENV_NAME".`);
    const [, id, name] = match;
    if (!SECRET_ID.test(id)) throw new Error(`SECRETS line ${index + 1} has an invalid secret id.`);
    if (!ENV_NAME.test(name)) throw new Error(`SECRETS line ${index + 1} has an invalid env name "${name}". Use letters, digits and underscores, and do not start with a digit.`);
    if (reservedName(name)) throw new Error(`SECRETS line ${index + 1} uses reserved env name "${name}". Pick a name the runner does not use.`);
    if (names.has(name)) throw new Error(`SECRETS sets "${name}" more than once.`);
    names.add(name);
    pairs.push({ id, name });
  });
  return pairs;
}

export function parseSecretList(stdout) {
  let raw;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error('Bitwarden Secrets Manager CLI returned invalid JSON.');
  }
  if (!Array.isArray(raw) || raw.some((s) => !s || typeof s.id !== 'string'
    || typeof s.key !== 'string' || typeof s.value !== 'string')) {
    throw new Error('Bitwarden Secrets Manager CLI returned an unexpected secret list.');
  }
  return raw.map((s) => ({ id: s.id, key: s.key, value: s.value, projectId: s.projectId ?? null }));
}

/**
 * Picks the secrets this run should export as a name -> value map.
 * Explicit pairs win nothing: a name is either in PROJECT_ID or in SECRETS,
 * never both, because silently choosing one would hide a stale secret.
 */
export function selectSecrets(secrets, { projectId = '', pairs = [] } = {}) {
  const byId = new Map(secrets.map((s) => [s.id, s]));
  const selected = new Map();
  if (projectId) {
    const inProject = secrets.filter((s) => s.projectId === projectId);
    if (!inProject.length && !pairs.length) {
      throw new Error(`No secrets were found in project "${projectId}". Check PROJECT_ID and this machine account's project access.`);
    }
    const invalid = inProject.filter((s) => !ENV_NAME.test(s.key)).map((s) => s.key);
    if (invalid.length) {
      throw new Error(`Project secret key${invalid.length > 1 ? 's' : ''} ${invalid.map((k) => `"${k}"`).join(', ')} ${invalid.length > 1 ? 'are' : 'is'} not a valid environment variable name. Rename ${invalid.length > 1 ? 'them' : 'it'}, or list the secret in SECRETS with a valid ENV_NAME.`);
    }
    const reserved = inProject.filter((s) => reservedName(s.key)).map((s) => s.key);
    if (reserved.length) {
      throw new Error(`Project secret key${reserved.length > 1 ? 's' : ''} ${reserved.map((k) => `"${k}"`).join(', ')} ${reserved.length > 1 ? 'are' : 'is'} reserved for the runner. Rename it in Bitwarden, or list it in SECRETS under another name.`);
    }
    for (const secret of inProject) selected.set(secret.key, secret.value);
  }
  for (const { id, name } of pairs) {
    const secret = byId.get(id);
    if (!secret) throw new Error(`Secret ${id} was not found for this machine account.`);
    if (selected.has(name)) throw new Error(`"${name}" is set by both PROJECT_ID and SECRETS.`);
    selected.set(name, secret.value);
  }
  return selected;
}

/**
 * Builds a GITHUB_ENV block. Heredoc syntax is used so a value with newlines
 * survives; the delimiter is random and shifted if a value happens to contain it.
 */
export function envBlock(entries, delimiter) {
  const seed = delimiter || `EOF_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const values = [...entries.values()].map((value) => String(value));
  let marker = seed;
  while (values.some((value) => value.includes(marker))) marker += 'X';
  const lines = [];
  for (const [name, value] of entries) lines.push(`${name}<<${marker}`, String(value), marker);
  return `${lines.join('\n')}\n`;
}

export function summary(selected, { projectId = '', pairs = [] } = {}) {
  const lines = ['# Bitwarden secrets', ''];
  lines.push(`${selected.size} masked environment variable${selected.size === 1 ? '' : 's'} exported.`, '');
  lines.push(`| Source | Name |`, '|---|---|');
  const explicit = new Map(pairs.map((pair) => [pair.name, pair.id]));
  for (const name of selected.keys()) {
    lines.push(`| ${explicit.has(name) ? 'SECRETS' : 'PROJECT_ID'} | \`${name}\` |`);
  }
  if (projectId) lines.push('', `Project: \`${projectId}\``);
  lines.push('', 'Values are masked in logs and are not printed by this action.');
  return lines.join('\n');
}

export function resolveRelease(env = process.env) {
  // Validate configuration before the platform, so a typo is reported as a typo
  // rather than as an unsupported runner.
  const version = env.BWS_VERSION || VERSION;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('BWS_VERSION must be a stable version such as 2.1.0.');
  const override = version !== VERSION;
  const checksum = env.BWS_SHA256 || (override ? '' : CHECKSUMS[process.arch] || '');
  if (override && !HEX256.test(checksum)) throw new Error('A version override requires BWS_SHA256 for the runner architecture.');
  if (process.platform !== 'linux' || !CHECKSUMS[process.arch]) throw new Error('The Bitwarden secrets action requires a Linux x64 or arm64 runner.');
  if (!HEX256.test(checksum)) throw new Error('A version override requires BWS_SHA256 for the runner architecture.');
  const target = process.arch === 'x64' ? 'x86_64' : 'aarch64';
  return {
    checksum,
    url: `https://github.com/bitwarden/sdk-sm/releases/download/bws-v${version}/bws-${target}-unknown-linux-gnu-${version}.zip`,
  };
}

export function install(directory, env = process.env) {
  const { checksum, url } = resolveRelease(env);
  const archive = join(directory, 'bws.zip');
  const download = spawnSync('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--retry', '3', '--max-time', '120', '--output', archive, url]);
  if (download.status !== 0) throw new Error('Could not download the pinned Bitwarden Secrets Manager CLI.');
  verifyChecksum(readFileSync(archive), checksum);
  const extract = spawnSync('unzip', ['-o', '-q', '-d', directory, archive, 'bws']);
  if (extract.status !== 0) throw new Error('Could not extract the pinned Bitwarden Secrets Manager CLI.');
  const binary = join(directory, 'bws');
  if (!existsSync(binary)) throw new Error('The Bitwarden Secrets Manager CLI archive did not contain bws.');
  spawnSync('chmod', ['0700', binary]);
  return binary;
}

/**
 * One list call per run, not one call per secret: every session counts against
 * the same IP rate limit, and the machine account can only list what it can read.
 */
export function listSecrets(binary, env = process.env, serverUrl = '') {
  const args = ['secret', 'list', '--output', 'json', '--color', 'no'];
  if (serverUrl) args.push('--server-url', serverUrl);
  const childEnv = {
    // Inherit the runner environment so HTTPS_PROXY and friends reach bws.
    ...process.env,
    ...env,
    BWS_ACCESS_TOKEN: env.BWS_ACCESS_TOKEN,
  };
  const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000, env: childEnv });
  if (result.status !== 0) {
    const detail = (result.stderr || '').trim().slice(0, 500);
    throw new Error(`Could not read Bitwarden secrets.${detail ? ` ${detail}` : ''}`);
  }
  return parseSecretList(result.stdout);
}

export async function run(env = process.env) {
  const token = env.BWS_ACCESS_TOKEN;
  if (!token) throw new Error('ACCESS_TOKEN is required. Pass a Secrets Manager machine account access token. Fork pull requests and Dependabot runs get no repository secrets, so skip this step for them.');
  core.setSecret(token);
  const projectId = (env.PROJECT_ID || '').trim();
  const pairs = parseSecrets(env.SECRETS || '');
  if (!projectId && !pairs.length) throw new Error('Set PROJECT_ID, SECRETS, or both.');
  const directory = mkdtempSync(join(tmpdir(), 'bws-'));
  try {
    const binary = env.BWS_TEST_BINARY || install(directory, env);
    const secrets = listSecrets(binary, { ...env, BWS_ACCESS_TOKEN: token }, env.BASE_URL);
    const selected = selectSecrets(secrets, { projectId, pairs });
    if (projectId && pairs.length && selected.size === pairs.length) {
      core.warning('PROJECT_ID matched no secrets; only SECRETS entries were exported.');
    }
    for (const value of selected.values()) {
      if (!value) continue;
      core.setSecret(value);
      // A mask covers one line, so a PEM key or JSON blob printed line by line
      // would leak its lines. Very short lines are skipped to keep logs readable.
      for (const line of value.split(/\r?\n/)) if (line.trim().length >= 4) core.setSecret(line.trim());
    }
    if (!env.GITHUB_ENV) throw new Error('GITHUB_ENV is not set.');
    appendFileSync(env.GITHUB_ENV, envBlock(selected));
    core.setOutput('KEYS', JSON.stringify([...selected.keys()]));
    core.info(`Exported ${selected.size} secret(s) as masked environment variables: ${[...selected.keys()].join(', ')}`);
    await core.summary.addRaw(summary(selected, { projectId, pairs })).write();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// Run only as the entry point, so tests can import helpers. Checking NODE_ENV
// instead made the action a silent no-op in jobs that set NODE_ENV=test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => core.setFailed(error.message));
}
