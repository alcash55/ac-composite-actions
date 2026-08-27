import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { parse } from 'yaml';

vi.mock('@actions/core', () => ({
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  error: vi.fn(),
}));

import * as core from '@actions/core';
import { formatSpell, run, MAX_COMMENT_LENGTH } from './index.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// Required: the output-name contract that the CSPELL_ERRORS/SPELL_ERRORS
// mismatch in the sibling spellcheck action would have caught.
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

describe('formatSpell', () => {
  it('returns an empty string for an empty/undefined message rather than throwing', () => {
    expect(formatSpell('')).toBe('');
    expect(formatSpell(undefined)).toBe('');
  });

  it('returns an empty string for an empty error array', () => {
    expect(formatSpell('[]')).toBe('');
  });

  it('returns an empty string and logs rather than throwing on invalid JSON', () => {
    expect(formatSpell('not json')).toBe('');
    expect(core.error).toHaveBeenCalled();
  });

  it('renders a "# Spell Check" heading with one section per file', () => {
    const message = formatSpell(
      JSON.stringify([
        { file: 'docs/a.md', output: "a.md:1:1 - Unknown word (wrod)" },
        { file: 'docs/b.md', output: "b.md:2:3 - Unknown word (mispelled)" },
      ])
    );

    expect(message.startsWith('# Spell Check')).toBe(true);
    expect(message).toContain('docs/a.md');
    expect(message).toContain('docs/b.md');
    expect(message).toContain('wrod');
    expect(message).toContain('mispelled');
  });

  // The overflow heading must match one of delete-comment's filter prefixes
  // verbatim, or a later run can never find and remove this comment.
  it('switches to the "too many errors" heading once the body would be too large', () => {
    const hugeErrors = Array.from({ length: 50 }, (_, i) => ({
      file: `docs/file-${i}.md`,
      output: 'x'.repeat(2000),
    }));

    const message = formatSpell(JSON.stringify(hugeErrors));

    expect(message.startsWith('# Too many errors to show full message, fix errors to show fill issue list')).toBe(
      true
    );
    expect(message.length).toBeLessThan(MAX_COMMENT_LENGTH);
    // Every file is still named, even though its cspell output was dropped.
    expect(message).toContain('docs/file-0.md');
    expect(message).toContain('docs/file-49.md');
  });

  it('never produces a body over the GitHub comment size limit', () => {
    const hugeErrors = Array.from({ length: 200 }, (_, i) => ({
      file: `docs/file-${i}.md`,
      output: 'x'.repeat(5000),
    }));

    const message = formatSpell(JSON.stringify(hugeErrors));

    expect(message.length).toBeLessThanOrEqual(MAX_COMMENT_LENGTH);
  });
});

describe('run', () => {
  it('reads SPELL_MESSAGE and sets FORMATTED_MESSAGE', () => {
    const original = process.env.SPELL_MESSAGE;
    process.env.SPELL_MESSAGE = JSON.stringify([{ file: 'a.md', output: 'bad word' }]);

    try {
      const result = run();

      expect(result).toContain('# Spell Check');
      expect(core.setOutput).toHaveBeenCalledWith('FORMATTED_MESSAGE', result);
    } finally {
      process.env.SPELL_MESSAGE = original;
    }
  });

  it('sets FORMATTED_MESSAGE to an empty string rather than skipping the output when clean', () => {
    const original = process.env.SPELL_MESSAGE;
    process.env.SPELL_MESSAGE = '[]';

    try {
      run();

      expect(core.setOutput).toHaveBeenCalledWith('FORMATTED_MESSAGE', '');
    } finally {
      process.env.SPELL_MESSAGE = original;
    }
  });
});
