import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse } from 'yaml';

vi.mock('@actions/core', () => ({
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  notice: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'child_process';
import * as core from '@actions/core';
import {
  readConfig,
  readFileFromDisk,
  getFileContent,
  runCspell,
  spellCheckFile,
  setOutputs,
  run,
} from './index.js';

const VALID_ENV = {
  DIFF: 'docs/a.md docs/b.md',
  BRANCH: 'main',
  GITHUB_ORG: 'alcash55/Resume',
  GH_TOKEN: 'ghp_token',
};

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Required: the output-name contract that the CSPELL_ERRORS/SPELL_ERRORS
// mismatch would have caught. action.yml's `value:` references the name the
// script must set; if the two drift, the output is silently always empty. ---
describe('action.yml <-> index.js output contract', () => {
  it('sets every output name that action.yml references via steps.*.outputs.*', () => {
    const doc = parse(readFileSync(new URL('./action.yml', import.meta.url), 'utf-8'));
    const declaredNames = Object.values(doc.outputs ?? {}).map((output) => {
      const match = String(output.value).match(/steps\.[\w-]+\.outputs\.([A-Za-z0-9_]+)/);

      if (!match) {
        throw new Error(`Could not parse an output reference from: ${output.value}`);
      }

      return match[1];
    });

    expect(declaredNames).not.toHaveLength(0);

    const source = readFileSync(new URL('./index.js', import.meta.url), 'utf-8');
    const setNames = new Set(
      [...source.matchAll(/core\.setOutput\(\s*["']([A-Za-z0-9_]+)["']/g)].map((m) => m[1])
    );

    for (const name of declaredNames) {
      expect(setNames, `index.js never calls core.setOutput("${name}", ...)`).toContain(name);
    }
  });
});

describe('readConfig', () => {
  it('parses a valid environment', () => {
    expect(readConfig(VALID_ENV)).toEqual({
      files: ['docs/a.md', 'docs/b.md'],
      branch: 'main',
      owner: 'alcash55',
      repo: 'Resume',
      token: 'ghp_token',
      cspellConfigPath: '.cspell.json',
    });
  });

  it.each(['DIFF', 'BRANCH', 'GITHUB_ORG', 'GH_TOKEN'])(
    'throws when %s is missing rather than falling back to a hardcoded default',
    (key) => {
      const env = { ...VALID_ENV };
      delete env[key];

      expect(() => readConfig(env)).toThrow(`Missing required input(s): ${key}`);
    }
  );

  it('rejects a malformed GITHUB_ORG', () => {
    expect(() => readConfig({ ...VALID_ENV, GITHUB_ORG: 'alcash55' })).toThrow(/owner\/repo/);
  });

  it('honours a custom CSPELL_CONFIG_PATH', () => {
    const config = readConfig({ ...VALID_ENV, CSPELL_CONFIG_PATH: '/x/.cspell.json' });

    expect(config.cspellConfigPath).toBe('/x/.cspell.json');
  });
});

describe('readFileFromDisk', () => {
  let workspace;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'spellcheck-disk-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('reads a file that exists in the checkout', () => {
    writeFileSync(join(workspace, 'a.md'), 'hello');

    expect(readFileFromDisk(workspace, 'a.md')).toBe('hello');
  });

  it('returns null rather than throwing when the file is not on disk', () => {
    expect(readFileFromDisk(workspace, 'missing.md')).toBeNull();
  });
});

describe('getFileContent', () => {
  let workspace;
  let originalWorkspaceEnv;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'spellcheck-workspace-'));
    originalWorkspaceEnv = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = workspace;
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    process.env.GITHUB_WORKSPACE = originalWorkspaceEnv;
  });

  it('prefers the on-disk checkout and never calls the API when the file exists', async () => {
    writeFileSync(join(workspace, 'a.md'), 'from disk');
    const octokit = { repos: { getContent: vi.fn() } };

    const content = await getFileContent(octokit, { owner: 'o', repo: 'r', branch: 'main' }, 'a.md');

    expect(content).toBe('from disk');
    expect(octokit.repos.getContent).not.toHaveBeenCalled();
  });

  it('falls back to the GitHub API when the file is not in the checkout', async () => {
    const octokit = {
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: { content: Buffer.from('from api').toString('base64') },
        }),
      },
    };

    const content = await getFileContent(
      octokit,
      { owner: 'alcash55', repo: 'Resume', branch: 'feature' },
      'missing.md'
    );

    expect(content).toBe('from api');
    expect(octokit.repos.getContent).toHaveBeenCalledWith({
      owner: 'alcash55',
      repo: 'Resume',
      path: 'missing.md',
      ref: 'feature',
    });
  });
});

describe('runCspell', () => {
  it('passes --config and quotes both paths', () => {
    execSync.mockReturnValue('');

    runCspell('/tmp/x file.md', '/cfg/.cspell.json');

    expect(execSync).toHaveBeenCalledWith(
      'cspell lint --no-exit-code --config "/cfg/.cspell.json" "/tmp/x file.md"',
      { encoding: 'utf-8' }
    );
  });
});

describe('spellCheckFile', () => {
  it('returns null and leaves no temp file behind when cspell reports nothing', () => {
    execSync.mockReturnValue('');

    const result = spellCheckFile('docs/a.md', 'hello world', '.cspell.json');

    expect(result).toBeNull();
    // The temp path passed to execSync should not exist afterward.
    const tempPath = execSync.mock.calls[0][0].match(/"([^"]+\.spellcheck-tmp[^"]*\.md)"$/)?.[1];
    expect(tempPath).toBeTruthy();
    expect(existsSync(tempPath)).toBe(false);
  });

  it('reports the original file path, not the temp file cspell actually saw', () => {
    execSync.mockImplementation((command) => {
      const tempPath = command.match(/"([^"]+)"$/)[1];
      return `${tempPath}:1:1 - Unknown word (wrod)\n`;
    });

    const result = spellCheckFile('docs/real-name.md', 'a wrod', '.cspell.json');

    expect(result.file).toBe('docs/real-name.md');
    expect(result.output).toContain('docs/real-name.md:1:1');
    expect(result.output).not.toMatch(/spellcheck-tmp/);
  });

  // The original implementation commented out unlinkSync, so a file survived
  // between runs; it also only reached cleanup on the success path. Both must
  // hold: the temp file is removed even when cspell itself throws.
  it('removes the temp file even when cspell throws', () => {
    let capturedPath;

    execSync.mockImplementation((command) => {
      capturedPath = command.match(/"([^"]+)"$/)[1];
      throw new Error('cspell crashed');
    });

    expect(() => spellCheckFile('docs/a.md', 'content', '.cspell.json')).toThrow('cspell crashed');
    expect(existsSync(capturedPath)).toBe(false);
  });
});

describe('setOutputs', () => {
  it('always sets SPELL_ERRORS, even for an empty result', () => {
    setOutputs([]);

    expect(core.setOutput).toHaveBeenCalledWith('SPELL_ERRORS', '[]');
  });

  it('serializes a flat array of { file, output }, not an array of arrays', () => {
    setOutputs([{ file: 'a.md', output: 'oops' }]);

    expect(core.setOutput).toHaveBeenCalledWith(
      'SPELL_ERRORS',
      JSON.stringify([{ file: 'a.md', output: 'oops' }])
    );
  });
});

describe('run', () => {
  let workspace;
  let original;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'spellcheck-run-'));
    original = { ...process.env };
    Object.assign(process.env, VALID_ENV, { GITHUB_WORKSPACE: workspace });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    process.env = original;
  });

  it('sets SPELL_ERRORS to an empty JSON array when there is nothing to report', async () => {
    process.env.DIFF = 'clean.md';
    writeFileSync(join(workspace, 'clean.md'), 'clean text');
    execSync.mockReturnValue('');

    const result = await run();

    expect(result).toEqual([]);
    expect(core.setOutput).toHaveBeenCalledWith('SPELL_ERRORS', '[]');
  });

  it('produces one entry per file with issues and skips clean files', async () => {
    process.env.DIFF = 'a.md b.md';
    writeFileSync(join(workspace, 'a.md'), 'bad wrod');
    writeFileSync(join(workspace, 'b.md'), 'clean text');

    execSync.mockImplementation((command) => {
      const tempPath = command.match(/"([^"]+)"$/)[1];
      const content = readFileSync(tempPath, 'utf-8');
      return content.includes('wrod') ? `${tempPath}:1:5 - Unknown word (wrod)\n` : '';
    });

    const result = await run();

    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('a.md');
    expect(core.setOutput).toHaveBeenCalledWith('SPELL_ERRORS', JSON.stringify(result));
  });
});
