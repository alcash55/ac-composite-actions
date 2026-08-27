import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync } from 'fs';
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

// Only exercised by runAxeSelfDriven — every other test in this file never
// touches a browser, so the mocks just have to exist, not do anything
// useful by default.
const mockAnalyze = vi.fn();
const mockPage = {
  goto: vi.fn(),
};
const mockBrowser = {
  newPage: vi.fn(() => mockPage),
  close: vi.fn(),
};
vi.mock('playwright', () => ({
  chromium: { launch: vi.fn(() => mockBrowser) },
}));
vi.mock('@axe-core/playwright', () => ({
  default: vi.fn().mockImplementation(() => ({
    withTags: vi.fn().mockReturnThis(),
    analyze: mockAnalyze,
  })),
}));

import * as core from '@actions/core';
import {
  readConfig,
  loadResultsEntries,
  runAxeSelfDriven,
  summarizeViolations,
  setOutputs,
  run,
} from './index.js';

const VIOLATION = {
  id: 'image-alt',
  impact: 'critical',
  help: 'Images must have alternate text',
  helpUrl: 'https://dequeuniversity.com/rules/axe/image-alt',
  nodes: [{ target: ['img'] }],
};

let tmpDir;

beforeEach(() => {
  vi.clearAllMocks();
  mockPage.goto.mockResolvedValue(undefined);
  mockAnalyze.mockResolvedValue({ violations: [] });
  tmpDir = mkdtempSync(join(tmpdir(), 'axe-check-test-'));
});

// --- The output-name contract: action.yml's `value:` references the name
// index.js must set. If the two drift, the output is silently always empty
// — exactly the SPELL_ERRORS/CSPELL_ERRORS mismatch a previous sprint fixed
// in the spellcheck action, checked here the same way. ---
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

    setOutputs([{ route: '/', violations: [] }]);
    const setNames = core.setOutput.mock.calls.map(([name]) => name);

    for (const name of declaredNames) {
      expect(setNames).toContain(name);
    }
  });
});

describe('readConfig', () => {
  it('accepts RESULTS_PATH alone', () => {
    const config = readConfig({ RESULTS_PATH: 'axe-results.json' });
    expect(config.resultsPath).toBe('axe-results.json');
  });

  it('accepts BASE_URL + ROUTES alone', () => {
    const config = readConfig({ BASE_URL: 'https://example.com', ROUTES: '/ /about' });
    expect(config.baseUrl).toBe('https://example.com');
    expect(config.routes).toEqual(['/', '/about']);
  });

  it('defaults TAGS to wcag2a,wcag2aa', () => {
    const config = readConfig({ RESULTS_PATH: 'axe-results.json' });
    expect(config.tags).toEqual(['wcag2a', 'wcag2aa']);
  });

  it('splits a custom TAGS list', () => {
    const config = readConfig({ RESULTS_PATH: 'axe-results.json', TAGS: 'wcag2a, best-practice' });
    expect(config.tags).toEqual(['wcag2a', 'best-practice']);
  });

  it('throws when neither RESULTS_PATH nor BASE_URL+ROUTES is set', () => {
    expect(() => readConfig({})).toThrow(/Needs either RESULTS_PATH/);
  });

  it('throws when BASE_URL is set but ROUTES is empty', () => {
    expect(() => readConfig({ BASE_URL: 'https://example.com' })).toThrow(/Needs either RESULTS_PATH/);
  });

  it('throws when ROUTES is set but BASE_URL is empty', () => {
    expect(() => readConfig({ ROUTES: '/' })).toThrow(/Needs either RESULTS_PATH/);
  });
});

describe('loadResultsEntries', () => {
  it('loads a valid results file', () => {
    const filePath = join(tmpDir, 'axe-results.json');
    writeFileSync(filePath, JSON.stringify([{ route: '/', violations: [VIOLATION] }]));

    expect(loadResultsEntries(filePath)).toEqual([{ route: '/', violations: [VIOLATION] }]);
  });

  it('throws when the file is not a JSON array', () => {
    const filePath = join(tmpDir, 'axe-results.json');
    writeFileSync(filePath, JSON.stringify({ route: '/', violations: [] }));

    expect(() => loadResultsEntries(filePath)).toThrow(/must contain a JSON array/);
  });

  it('throws when an entry is missing "route"', () => {
    const filePath = join(tmpDir, 'axe-results.json');
    writeFileSync(filePath, JSON.stringify([{ violations: [] }]));

    expect(() => loadResultsEntries(filePath)).toThrow(/missing "route"/);
  });

  it('throws when an entry is missing a "violations" array', () => {
    const filePath = join(tmpDir, 'axe-results.json');
    writeFileSync(filePath, JSON.stringify([{ route: '/' }]));

    expect(() => loadResultsEntries(filePath)).toThrow(/missing a "violations" array/);
  });
});

describe('runAxeSelfDriven', () => {
  it('navigates to each route and collects analyze() results', async () => {
    mockAnalyze
      .mockResolvedValueOnce({ violations: [] })
      .mockResolvedValueOnce({ violations: [VIOLATION] });

    const entries = await runAxeSelfDriven('https://example.com', ['/', '/about'], ['wcag2a']);

    expect(mockPage.goto).toHaveBeenNthCalledWith(1, 'https://example.com/', { waitUntil: 'networkidle' });
    expect(mockPage.goto).toHaveBeenNthCalledWith(2, 'https://example.com/about', { waitUntil: 'networkidle' });
    expect(entries).toEqual([
      { route: '/', violations: [] },
      { route: '/about', violations: [VIOLATION] },
    ]);
  });

  it('closes the browser even when a route throws', async () => {
    mockPage.goto.mockRejectedValueOnce(new Error('navigation timeout'));

    await expect(runAxeSelfDriven('https://example.com', ['/'], ['wcag2a'])).rejects.toThrow(
      'navigation timeout'
    );
    expect(mockBrowser.close).toHaveBeenCalledOnce();
  });
});

describe('summarizeViolations', () => {
  it('returns null when every route is clean', () => {
    expect(summarizeViolations([{ route: '/', violations: [] }])).toBeNull();
  });

  it('lists impact, rule id, node count and help url per violation', () => {
    const summary = summarizeViolations([{ route: '/', violations: [VIOLATION] }]);
    expect(summary).toContain('/:');
    expect(summary).toContain('[critical] image-alt: 1 node(s)');
    expect(summary).toContain('Images must have alternate text');
    expect(summary).toContain('https://dequeuniversity.com/rules/axe/image-alt');
  });

  it('only lists routes that actually have violations', () => {
    const summary = summarizeViolations([
      { route: '/clean', violations: [] },
      { route: '/broken', violations: [VIOLATION] },
    ]);
    expect(summary).not.toContain('/clean');
    expect(summary).toContain('/broken');
  });
});

describe('run', () => {
  const originalWorkspace = process.env.GITHUB_WORKSPACE;

  afterEach(() => {
    process.env.GITHUB_WORKSPACE = originalWorkspace;
  });

  it('uses RESULTS_PATH when set, without touching the browser', async () => {
    const filePath = join(tmpDir, 'axe-results.json');
    writeFileSync(filePath, JSON.stringify([{ route: '/', violations: [] }]));
    process.env.GITHUB_WORKSPACE = tmpDir;
    process.env.RESULTS_PATH = 'axe-results.json';
    delete process.env.BASE_URL;
    delete process.env.ROUTES;

    const entries = await run();

    expect(entries).toEqual([{ route: '/', violations: [] }]);
    expect(mockBrowser.close).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('AXE_VIOLATIONS', JSON.stringify(entries));

    delete process.env.RESULTS_PATH;
  });

  it('drives its own browser when RESULTS_PATH is unset', async () => {
    delete process.env.RESULTS_PATH;
    process.env.BASE_URL = 'https://example.com';
    process.env.ROUTES = '/';
    mockAnalyze.mockResolvedValueOnce({ violations: [VIOLATION] });

    const entries = await run();

    expect(entries).toEqual([{ route: '/', violations: [VIOLATION] }]);
    expect(mockBrowser.close).toHaveBeenCalledOnce();

    delete process.env.BASE_URL;
    delete process.env.ROUTES;
  });
});
