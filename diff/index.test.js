import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { parse } from 'yaml';

vi.mock('@actions/core', () => ({
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  notice: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));

// Octokit attaches `paginate` per instance via a plugin, so it cannot be spied
// on the prototype — the whole module is replaced with a stub instead.
const { paginateMock } = vi.hoisted(() => ({ paginateMock: vi.fn() }));

vi.mock('@octokit/rest', () => ({
  Octokit: class {
    constructor(options) {
      this.options = options;
      this.paginate = paginateMock;
      this.rest = { pulls: { listFiles: 'listFiles' } };
    }
  },
}));

import * as core from '@actions/core';
import {
  categorizeFiles,
  formatErrorMsg,
  getChangedFilenames,
  parseExtensions,
  readConfig,
  run,
  setOutputs,
} from './index.js';

const VALID_ENV = {
  PR_NUMBER: '42',
  GITHUB_ORG: 'alcash55/Resume',
  GH_TOKEN: 'ghp_token',
};

/** Collects core.setOutput calls into a plain object for readable assertions. */
function collectOutputs() {
  return Object.fromEntries(core.setOutput.mock.calls);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// Required: the output-name contract that a CSPELL_ERRORS/SPELL_ERRORS style
// mismatch would have caught. action.yml's `value:` references the name
// index.js must set; if the two drift, the output silently stays empty.
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
  it('parses a valid environment into owner, repo, pr number and extensions', () => {
    const config = readConfig(VALID_ENV);

    expect(config).toEqual({
      owner: 'alcash55',
      repo: 'Resume',
      prNumber: 42,
      token: 'ghp_token',
      extensions: ['.md', '.mdx'],
    });
  });

  it.each(['PR_NUMBER', 'GITHUB_ORG', 'GH_TOKEN'])('throws when %s is missing', (key) => {
    const env = { ...VALID_ENV };
    delete env[key];

    expect(() => readConfig(env)).toThrow(`Missing required input(s): ${key}`);
  });

  it('names every missing input at once rather than failing one at a time', () => {
    expect(() => readConfig({ GH_TOKEN: 'x' })).toThrow(
      'Missing required input(s): PR_NUMBER, GITHUB_ORG'
    );
  });

  // parseInt('12abc') is 12, which would silently target the wrong pull request.
  it.each(['12abc', 'not-a-number', '0', '-3', '1.5'])(
    'rejects PR_NUMBER "%s" instead of coercing it',
    (prNumber) => {
      expect(() => readConfig({ ...VALID_ENV, PR_NUMBER: prNumber })).toThrow(/PR_NUMBER/);
    }
  );

  it.each(['alcash55', '/Resume', 'alcash55/'])('rejects malformed GITHUB_ORG "%s"', (org) => {
    expect(() => readConfig({ ...VALID_ENV, GITHUB_ORG: org })).toThrow(/owner\/repo/);
  });

  it('honours a custom FILE_EXTENSIONS list', () => {
    const config = readConfig({ ...VALID_ENV, FILE_EXTENSIONS: 'ts, .TSX' });

    expect(config.extensions).toEqual(['.ts', '.tsx']);
  });
});

describe('parseExtensions', () => {
  it('lowercases, dot-prefixes and de-duplicates', () => {
    expect(parseExtensions('MD, .md  mdx,md')).toEqual(['.md', '.mdx']);
  });

  it('accepts space separated input', () => {
    expect(parseExtensions('md mdx txt')).toEqual(['.md', '.mdx', '.txt']);
  });

  it('throws on an empty list rather than matching nothing forever', () => {
    expect(() => parseExtensions('  ,  ')).toThrow(/did not contain any extensions/);
  });
});

describe('categorizeFiles', () => {
  const extensions = ['.md', '.mdx'];

  it('keeps matching files and drops non-matching ones', () => {
    const result = categorizeFiles(
      ['docs/intro.md', 'src/app.ts', 'docs/guide.mdx', 'README'],
      extensions
    );

    expect(result.workingFiles).toEqual(['docs/intro.md', 'docs/guide.mdx']);
    expect(result.errorFiles).toEqual([]);
  });

  it('matches extensions case-insensitively', () => {
    const result = categorizeFiles(['docs/INTRO.MD'], extensions);

    expect(result.workingFiles).toEqual(['docs/INTRO.MD']);
  });

  it('flags names containing spaces and keeps them out of the working set', () => {
    const result = categorizeFiles(['docs/my notes.md', 'docs/clean.md'], extensions);

    expect(result.errorFiles).toEqual(['docs/my notes.md']);
    expect(result.workingFiles).toEqual(['docs/clean.md']);
  });

  // A space anywhere in the path breaks the space-delimited DIFF contract,
  // not just a space in the basename.
  it('flags a space in a parent directory, not only in the file name', () => {
    const result = categorizeFiles(['my docs/clean.md'], extensions);

    expect(result.errorFiles).toEqual(['my docs/clean.md']);
    expect(result.workingFiles).toEqual([]);
  });

  it('flags tabs and other whitespace, not only literal spaces', () => {
    const result = categorizeFiles(['docs/tabbed\tname.md'], extensions);

    expect(result.errorFiles).toEqual(['docs/tabbed\tname.md']);
  });

  it('does not flag a badly named file that we would not have processed anyway', () => {
    const result = categorizeFiles(['src/my component.ts'], extensions);

    expect(result.errorFiles).toEqual(['src/my component.ts']);
    expect(result.workingFiles).toEqual([]);
  });

  it('returns empty lists for an empty diff', () => {
    expect(categorizeFiles([], extensions)).toEqual({ workingFiles: [], errorFiles: [] });
  });
});

describe('formatErrorMsg', () => {
  it('returns an empty string when there is nothing to report', () => {
    expect(formatErrorMsg([])).toBe('');
  });

  it('renders one bullet per rejected file', () => {
    const message = formatErrorMsg(['a b.md', 'c d.md']);

    expect(message).toContain('# Invalid File Names');
    expect(message).toContain('`a b.md`');
    expect(message).toContain('`c d.md`');
    expect(message.match(/^- /gm)).toHaveLength(2);
  });
});

describe('getChangedFilenames', () => {
  it('excludes removed files so downstream steps never read a deleted path', async () => {
    const octokit = {
      rest: { pulls: { listFiles: 'listFiles' } },
      paginate: vi.fn().mockResolvedValue([
        { filename: 'kept.md', status: 'modified' },
        { filename: 'gone.md', status: 'removed' },
        { filename: 'added.md', status: 'added' },
        { filename: 'moved.md', status: 'renamed' },
      ]),
    };

    const files = await getChangedFilenames(octokit, {
      owner: 'alcash55',
      repo: 'Resume',
      prNumber: 42,
    });

    expect(files).toEqual(['kept.md', 'added.md', 'moved.md']);
  });

  // The raw endpoint caps at 30 files per page; without paginate a 31-file PR
  // silently loses everything past the first page.
  it('paginates with the maximum page size', async () => {
    const octokit = {
      rest: { pulls: { listFiles: 'listFiles' } },
      paginate: vi.fn().mockResolvedValue([]),
    };

    await getChangedFilenames(octokit, { owner: 'alcash55', repo: 'Resume', prNumber: 42 });

    expect(octokit.paginate).toHaveBeenCalledWith('listFiles', {
      owner: 'alcash55',
      repo: 'Resume',
      pull_number: 42,
      per_page: 100,
    });
  });
});

describe('setOutputs', () => {
  it('sets all four outputs on a normal run', () => {
    setOutputs({
      allFiles: ['a.md', 'b.ts'],
      workingFiles: ['a.md'],
      errorFiles: [],
    });

    expect(collectOutputs()).toEqual({
      ALL_FILES: 'a.md b.ts',
      DIFF: 'a.md',
      ERROR_FILES: '',
      HAS_CHANGES: 'true',
    });
  });

  // The previous implementation exited before setting outputs on an empty diff,
  // which left consumers reading an undefined DIFF.
  it('still sets all four outputs when everything is empty', () => {
    setOutputs({ allFiles: [], workingFiles: [], errorFiles: [] });

    expect(collectOutputs()).toEqual({
      ALL_FILES: '',
      DIFF: '',
      ERROR_FILES: '',
      HAS_CHANGES: 'false',
    });
  });

  it('reports HAS_CHANGES false when the only changed files were rejected', () => {
    setOutputs({
      allFiles: ['bad name.md'],
      workingFiles: [],
      errorFiles: ['bad name.md'],
    });

    const outputs = collectOutputs();

    expect(outputs.HAS_CHANGES).toBe('false');
    expect(outputs.DIFF).toBe('');
    expect(outputs.ERROR_FILES).toContain('bad name.md');
  });
});

describe('run', () => {
  /** Installs a fake PR file list and returns the outputs run() produced. */
  async function runWith(files, env = {}) {
    const original = { ...process.env };
    Object.assign(process.env, VALID_ENV, env);

    paginateMock.mockResolvedValue(
      files.map((f) => (typeof f === 'string' ? { filename: f, status: 'modified' } : f))
    );

    try {
      await run();
      return collectOutputs();
    } finally {
      process.env = original;
    }
  }

  it('produces a usable DIFF end to end', async () => {
    const outputs = await runWith(['docs/a.md', 'src/b.ts', 'docs/c.mdx']);

    expect(outputs.DIFF).toBe('docs/a.md docs/c.mdx');
    expect(outputs.ALL_FILES).toBe('docs/a.md src/b.ts docs/c.mdx');
    expect(outputs.HAS_CHANGES).toBe('true');
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('succeeds with empty outputs on an empty pull request', async () => {
    const outputs = await runWith([]);

    expect(outputs).toEqual({
      ALL_FILES: '',
      DIFF: '',
      ERROR_FILES: '',
      HAS_CHANGES: 'false',
    });
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('reports rejected names without failing the step', async () => {
    const outputs = await runWith(['docs/bad name.md', 'docs/good.md']);

    expect(outputs.DIFF).toBe('docs/good.md');
    expect(outputs.ERROR_FILES).toContain('docs/bad name.md');
    expect(core.warning).toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('respects FILE_EXTENSIONS so the action is not markdown-only', async () => {
    const outputs = await runWith(['src/a.ts', 'src/b.tsx', 'docs/c.md'], {
      FILE_EXTENSIONS: 'ts,tsx',
    });

    expect(outputs.DIFF).toBe('src/a.ts src/b.tsx');
  });

  it('propagates a config error so the caller can fail the step', async () => {
    const original = { ...process.env };
    Object.assign(process.env, VALID_ENV, { PR_NUMBER: 'nope' });

    try {
      await expect(run()).rejects.toThrow(/PR_NUMBER/);
    } finally {
      process.env = original;
    }
  });
});
