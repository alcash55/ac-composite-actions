// Runs the real cspell binary against the real .cspell.json — no mocks. This
// is the test for Item 2: the --config flag being commented out meant every
// word in the custom dictionary (Vite, vitejs, NCR, Voyix) reported as a
// misspelling. A mocked test can't catch that; only a real cspell run can.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spellCheckFile } from './index.js';

const CSPELL_CONFIG_PATH = new URL('../.cspell.json', import.meta.url).pathname;

describe('.cspell.json dictionary (real cspell binary)', () => {
  let cwdBefore;
  let workdir;

  beforeEach(() => {
    // spellCheckFile writes its temp file under process.cwd() so cspell's
    // "files" glob (matched relative to cwd) actually picks it up — see the
    // comment in index.js. The real action always runs with cwd inside the
    // checked-out repo, so a scratch subdirectory here reproduces that.
    cwdBefore = process.cwd();
    workdir = mkdtempSync(join(tmpdir(), 'cspell-dict-'));
    process.chdir(workdir);
  });

  afterEach(() => {
    process.chdir(cwdBefore);
    rmSync(workdir, { recursive: true, force: true });
  });

  it('does not flag words from the custom dictionary', () => {
    const result = spellCheckFile(
      'docs/stack.md',
      'We used Vite and vitejs to build the frontend for NCR Voyix.',
      CSPELL_CONFIG_PATH
    );

    expect(result).toBeNull();
  });

  it('still flags a genuine misspelling in the same run', () => {
    const result = spellCheckFile(
      'docs/typo.md',
      'This wrod is definitely mispelled.',
      CSPELL_CONFIG_PATH
    );

    expect(result).not.toBeNull();
    expect(result.output).toMatch(/wrod/);
  });
});
