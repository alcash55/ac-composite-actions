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

// Only exercised by extractRenderedEntries — every other test in this file
// never touches a browser, so the mock just has to exist, not do anything
// useful by default.
const mockPage = {
  goto: vi.fn(),
  evaluate: vi.fn(),
};
const mockBrowser = {
  newPage: vi.fn(() => mockPage),
  close: vi.fn(),
};
vi.mock('playwright', () => ({
  chromium: { launch: vi.fn(() => mockBrowser) },
}));

import { execSync } from 'child_process';
import * as core from '@actions/core';
import {
  readConfig,
  readFileFromDisk,
  getFileContent,
  listCheckoutFiles,
  resolveCspellConfigPath,
  runCspell,
  spellCheckFile,
  buildRenderedText,
  loadRenderedEntries,
  extractRenderedEntries,
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
  // clearAllMocks resets call history but not an explicit mockResolvedValue/
  // mockRejectedValue set by a previous test (e.g. the "closes the browser
  // even when scraping throws" case below) — reset the playwright mock page
  // to a benign default each time so that override cannot leak forward.
  mockPage.goto.mockResolvedValue(undefined);
  mockPage.evaluate.mockResolvedValue({ innerText: '', description: '', labels: [] });
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
  it('parses a valid environment (source mode with DIFF, unchanged from before modes existed)', () => {
    expect(readConfig(VALID_ENV)).toEqual({
      mode: 'source',
      dictionaryPath: null,
      files: ['docs/a.md', 'docs/b.md'],
      branch: 'main',
      owner: 'alcash55',
      repo: 'Resume',
      token: 'ghp_token',
      cspellConfigPath: '.cspell.json',
    });
  });

  it.each(['BRANCH', 'GITHUB_ORG', 'GH_TOKEN'])(
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

  it('honours a custom DICTIONARY', () => {
    const config = readConfig({ ...VALID_ENV, DICTIONARY: 'e2e/.cspell.json' });

    expect(config.dictionaryPath).toBe('e2e/.cspell.json');
  });

  it('rejects an unrecognised SPELLCHECK_MODE', () => {
    expect(() => readConfig({ ...VALID_ENV, SPELLCHECK_MODE: 'bogus' })).toThrow(/SPELLCHECK_MODE must be "source" or "rendered"/);
  });

  describe('source mode with no DIFF (whole-checkout glob)', () => {
    it('does not require BRANCH/GITHUB_ORG/GH_TOKEN — there is no PR context to fall back on', () => {
      const config = readConfig({});

      expect(config).toEqual({
        mode: 'source',
        dictionaryPath: null,
        cspellConfigPath: '.cspell.json',
        extensions: ['ts', 'tsx', 'html', 'md', 'mdx', 'json'],
      });
    });

    it('parses a custom EXTENSIONS list, trimming whitespace and leading dots', () => {
      const config = readConfig({ EXTENSIONS: ' ts, .tsx ,md' });

      expect(config.extensions).toEqual(['ts', 'tsx', 'md']);
    });

    it('an empty DIFF (explicitly set) behaves the same as DIFF being unset', () => {
      const config = readConfig({ DIFF: '' });

      expect(config).toEqual({
        mode: 'source',
        dictionaryPath: null,
        cspellConfigPath: '.cspell.json',
        extensions: ['ts', 'tsx', 'html', 'md', 'mdx', 'json'],
      });
    });
  });

  describe('rendered mode', () => {
    it('accepts RENDERED_CONTENT_PATH alone, without BASE_URL/ROUTES', () => {
      const config = readConfig({ SPELLCHECK_MODE: 'rendered', RENDERED_CONTENT_PATH: 'e2e/rendered.json' });

      expect(config).toEqual({
        mode: 'rendered',
        dictionaryPath: null,
        cspellConfigPath: '.cspell.json',
        renderedContentPath: 'e2e/rendered.json',
        routes: [],
        baseUrl: null,
      });
    });

    it('accepts BASE_URL + ROUTES alone, without RENDERED_CONTENT_PATH', () => {
      const config = readConfig({ SPELLCHECK_MODE: 'rendered', BASE_URL: 'http://localhost:4173', ROUTES: '/ /about' });

      expect(config).toEqual({
        mode: 'rendered',
        dictionaryPath: null,
        cspellConfigPath: '.cspell.json',
        renderedContentPath: null,
        routes: ['/', '/about'],
        baseUrl: 'http://localhost:4173',
      });
    });

    it('throws when neither RENDERED_CONTENT_PATH nor BASE_URL+ROUTES is given', () => {
      expect(() => readConfig({ SPELLCHECK_MODE: 'rendered' })).toThrow(/RENDERED_CONTENT_PATH.*BASE_URL/s);
    });

    it('throws when BASE_URL is given without ROUTES', () => {
      expect(() => readConfig({ SPELLCHECK_MODE: 'rendered', BASE_URL: 'http://localhost:4173' })).toThrow(
        /RENDERED_CONTENT_PATH.*BASE_URL/s
      );
    });
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

describe('listCheckoutFiles', () => {
  it('runs git ls-files against the workspace and filters by extension', () => {
    execSync.mockReturnValue('README.md\nsrc/App.tsx\nsrc/App.test.tsx\npackage.json\nlogo.png\n');

    const files = listCheckoutFiles('/repo', ['md', 'tsx']);

    expect(execSync).toHaveBeenCalledWith('git ls-files', { cwd: '/repo', encoding: 'utf-8' });
    expect(files).toEqual(['README.md', 'src/App.tsx', 'src/App.test.tsx']);
  });

  it('is case-insensitive and ignores blank lines', () => {
    execSync.mockReturnValue('DOCS.MD\n\n\nnotes.txt\n');

    expect(listCheckoutFiles('/repo', ['md'])).toEqual(['DOCS.MD']);
  });
});

describe('resolveCspellConfigPath', () => {
  it('returns the base config path unchanged when there is no consumer dictionary', () => {
    const { configPath, cleanup } = resolveCspellConfigPath('/shared/.cspell.json', null);

    expect(configPath).toBe('/shared/.cspell.json');
    expect(() => cleanup()).not.toThrow();
  });

  it('writes a merged config importing both files when a dictionary is given, and cleanup removes it', () => {
    const { configPath, cleanup } = resolveCspellConfigPath('/shared/.cspell.json', '/repo/.cspell.json');

    expect(configPath).not.toBe('/shared/.cspell.json');
    expect(existsSync(configPath)).toBe(true);

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.import).toEqual(['/shared/.cspell.json', '/repo/.cspell.json']);

    cleanup();
    expect(existsSync(configPath)).toBe(false);
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

  it('works with a route label (rendered mode reuses this same helper)', () => {
    execSync.mockImplementation((command) => {
      const tempPath = command.match(/"([^"]+)"$/)[1];
      return `${tempPath}:1:1 - Unknown word (wrod)\n`;
    });

    const result = spellCheckFile('/about', 'a wrod', '.cspell.json');

    expect(result.file).toBe('/about');
    expect(result.output).toContain('/about:1:1');
  });
});

describe('buildRenderedText', () => {
  it('joins innerText, description, and labels with newlines', () => {
    const text = buildRenderedText({
      innerText: 'Hello world',
      description: 'A portfolio site',
      labels: ['Profile photo', 'Open menu'],
    });

    expect(text).toBe('Hello world\nA portfolio site\nProfile photo\nOpen menu');
  });

  it('omits empty pieces rather than leaving blank lines', () => {
    expect(buildRenderedText({ innerText: 'Hello', description: '', labels: [] })).toBe('Hello');
  });

  it('defaults every field so a partial scrape does not throw', () => {
    expect(buildRenderedText({})).toBe('');
  });
});

describe('loadRenderedEntries', () => {
  let workspace;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'spellcheck-rendered-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('parses a JSON array of scraped entries into { route, text }', () => {
    const path = join(workspace, 'rendered.json');
    writeFileSync(
      path,
      JSON.stringify([
        { route: '/', innerText: 'Home', description: 'Welcome', labels: ['Logo'] },
        { route: '/about', innerText: 'About', description: '', labels: [] },
      ])
    );

    expect(loadRenderedEntries(path)).toEqual([
      { route: '/', text: 'Home\nWelcome\nLogo' },
      { route: '/about', text: 'About' },
    ]);
  });

  it('throws when the file does not contain a JSON array', () => {
    const path = join(workspace, 'rendered.json');
    writeFileSync(path, JSON.stringify({ route: '/' }));

    expect(() => loadRenderedEntries(path)).toThrow(/must contain a JSON array/);
  });

  it('throws when an entry is missing a route', () => {
    const path = join(workspace, 'rendered.json');
    writeFileSync(path, JSON.stringify([{ innerText: 'Home' }]));

    expect(() => loadRenderedEntries(path)).toThrow(/missing "route"/);
  });
});

describe('extractRenderedEntries', () => {
  it('visits every route and scrapes innerText, description, and labels via buildRenderedText', async () => {
    mockPage.evaluate.mockResolvedValue({
      innerText: 'Home page',
      description: 'A portfolio',
      labels: ['Logo'],
    });

    const entries = await extractRenderedEntries('http://localhost:4173', ['/', '/about']);

    expect(mockPage.goto).toHaveBeenCalledWith('http://localhost:4173/', { waitUntil: 'networkidle' });
    expect(mockPage.goto).toHaveBeenCalledWith('http://localhost:4173/about', { waitUntil: 'networkidle' });
    expect(entries).toEqual([
      { route: '/', text: 'Home page\nA portfolio\nLogo' },
      { route: '/about', text: 'Home page\nA portfolio\nLogo' },
    ]);
    expect(mockBrowser.close).toHaveBeenCalled();
  });

  it('closes the browser even when scraping throws', async () => {
    mockPage.goto.mockRejectedValue(new Error('navigation failed'));

    await expect(extractRenderedEntries('http://localhost:4173', ['/'])).rejects.toThrow('navigation failed');
    expect(mockBrowser.close).toHaveBeenCalled();
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

  describe('source mode with DIFF (unchanged behaviour)', () => {
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

  describe('source mode, whole-checkout glob (no DIFF)', () => {
    it('checks every git-tracked file matching EXTENSIONS, read straight off disk', async () => {
      delete process.env.DIFF;
      delete process.env.BRANCH;
      delete process.env.GITHUB_ORG;
      delete process.env.GH_TOKEN;
      process.env.EXTENSIONS = 'md';
      writeFileSync(join(workspace, 'good.md'), 'clean text');
      writeFileSync(join(workspace, 'bad.md'), 'a wrod here');

      execSync.mockImplementation((command) => {
        if (command === 'git ls-files') {
          return 'good.md\nbad.md\nREADME.txt\n';
        }
        const tempPath = command.match(/"([^"]+)"$/)[1];
        const content = readFileSync(tempPath, 'utf-8');
        return content.includes('wrod') ? `${tempPath}:1:3 - Unknown word (wrod)\n` : '';
      });

      const result = await run();

      expect(result).toHaveLength(1);
      expect(result[0].file).toBe('bad.md');
    });
  });

  describe('rendered mode', () => {
    it('checks pre-extracted text from RENDERED_CONTENT_PATH without touching a browser', async () => {
      delete process.env.DIFF;
      delete process.env.BRANCH;
      delete process.env.GITHUB_ORG;
      delete process.env.GH_TOKEN;
      process.env.SPELLCHECK_MODE = 'rendered';
      process.env.RENDERED_CONTENT_PATH = 'rendered.json';
      writeFileSync(
        join(workspace, 'rendered.json'),
        JSON.stringify([
          { route: '/', innerText: 'a wrod on the homepage', description: '', labels: [] },
          { route: '/about', innerText: 'clean text', description: '', labels: [] },
        ])
      );

      execSync.mockImplementation((command) => {
        const tempPath = command.match(/"([^"]+)"$/)[1];
        const content = readFileSync(tempPath, 'utf-8');
        return content.includes('wrod') ? `${tempPath}:1:3 - Unknown word (wrod)\n` : '';
      });

      const result = await run();

      expect(result).toHaveLength(1);
      expect(result[0].file).toBe('/');
      expect(mockBrowser.newPage).not.toHaveBeenCalled();
    });

    it('drives its own browser when RENDERED_CONTENT_PATH is not given', async () => {
      delete process.env.DIFF;
      delete process.env.BRANCH;
      delete process.env.GITHUB_ORG;
      delete process.env.GH_TOKEN;
      process.env.SPELLCHECK_MODE = 'rendered';
      process.env.BASE_URL = 'http://localhost:4173';
      process.env.ROUTES = '/';
      mockPage.evaluate.mockResolvedValue({ innerText: 'clean text', description: '', labels: [] });
      execSync.mockReturnValue('');

      const result = await run();

      expect(result).toEqual([]);
      expect(mockBrowser.newPage).toHaveBeenCalled();
      expect(mockBrowser.close).toHaveBeenCalled();
    });
  });
});
