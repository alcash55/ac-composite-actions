// Runs the real cspell binary against the real .cspell.json — no mocks. This
// is the test for Item 2: the --config flag being commented out meant every
// word in the custom dictionary (Vite, vitejs) reported as a misspelling. A
// mocked test can't catch that; only a real cspell run can.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spellCheckFile, resolveCspellConfigPath } from './index.js';

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

  it('does not flag words from the shared dictionary', () => {
    const result = spellCheckFile(
      'docs/stack.md',
      'We used Vite and vitejs to build the frontend.',
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

  // The dictionary moved into the consuming repo (Sprint 19): the shared
  // baseline no longer carries any project's proper nouns (it used to carry
  // "vsmarketplacebadge"/"visualstudio", words belonging to an entirely
  // different project — see markdown-checks/.cspell.json history). A
  // consumer supplies its own via DICTIONARY, merged in through cspell's own
  // "import", not replacing the shared baseline.
  it('flags a project-specific proper noun by default, but not once a consumer dictionary adds it', () => {
    const withoutDictionary = spellCheckFile(
      'docs/employer.md',
      'I worked at NCR Voyix.',
      CSPELL_CONFIG_PATH
    );
    expect(withoutDictionary).not.toBeNull();

    const consumerDictionaryPath = join(workdir, 'consumer.cspell.json');
    writeFileSync(consumerDictionaryPath, JSON.stringify({ words: ['Voyix', 'NCR'] }));

    const { configPath, cleanup } = resolveCspellConfigPath(CSPELL_CONFIG_PATH, consumerDictionaryPath);
    try {
      const withDictionary = spellCheckFile('docs/employer.md', 'I worked at NCR Voyix.', configPath);
      expect(withDictionary).toBeNull();

      // The shared baseline's own words still apply — import merges rather
      // than replaces.
      const stillHasSharedWords = spellCheckFile('docs/stack.md', 'We used Vite and vitejs.', configPath);
      expect(stillHasSharedWords).toBeNull();

      // The negative control, and the reason it is not optional: every other
      // assertion in this block expects null, and a config cspell fails to
      // apply at all *also* produces null — it reports "0 files checked" and
      // exits clean rather than erroring. Without a case that expects a real
      // failure, this test would pass identically whether the merge works or
      // whether the merged config silently matches nothing, which is exactly
      // the fault the temp-file-under-cwd comment in index.js describes. A
      // genuine misspelling still being flagged is what separates "the
      // dictionary was applied" from "nothing was checked".
      const realTypo = spellCheckFile('docs/typo.md', 'This wrod is still wrong.', configPath);
      expect(realTypo, 'merged config checked nothing at all').not.toBeNull();
      expect(realTypo.output).toMatch(/wrod/);
    } finally {
      cleanup();
    }
  });
});
