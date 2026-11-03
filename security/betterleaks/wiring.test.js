import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Both actions post their comment through notifications/pr-comment, like every other
// checker. They once ran the format and upsert scripts by hand, which meant three
// copies of the same two steps. These keep a fourth from growing back.
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf-8');
const scan = read('./action.yml');
const reporter = read('./comment/action.yml');
const PR_COMMENT = 'alcash55/ac-composite-actions/notifications/pr-comment@main';

describe('scan action.yml', () => {
  it('posts findings through pr-comment with KIND secrets', () => {
    assert.match(scan, new RegExp(`uses: ${PR_COMMENT}`));
    assert.match(scan, /KIND: secrets/);
    assert.match(scan, /DATA: \$\{\{ steps\.scan\.outputs\.FINDINGS \}\}/);
  });

  it('forwards the inputs pr-comment needs', () => {
    for (const name of ['COMMENT_ON_PR', 'GH_TOKEN', 'GITHUB_ORG', 'PR_NUMBER']) {
      assert.match(scan, new RegExp(`${name}: \\$\\{\\{ inputs\\.${name} \\}\\}`), name);
    }
  });

  it('does not call the format or upsert scripts itself', () => {
    assert.doesNotMatch(scan, /format-comment|upsert-comment/);
  });
});

describe('comment action.yml', () => {
  it('verifies the artifact, then posts through pr-comment with KIND secrets', () => {
    assert.match(reporter, /dist\/comment\.js/);
    assert.match(reporter, new RegExp(`uses: ${PR_COMMENT}`));
    assert.match(reporter, /KIND: secrets/);
  });

  it('hands pr-comment only what the verify step produced', () => {
    assert.match(reporter, /DATA: \$\{\{ steps\.verify\.outputs\.DATA \}\}/);
    assert.match(reporter, /PR_NUMBER: \$\{\{ steps\.verify\.outputs\.PR_NUMBER \}\}/);
  });

  it('fails the job when the comment cannot be written', () => {
    assert.match(reporter, /FAIL_ON_ERROR: "true"/);
  });

  it('does not call the format or upsert scripts itself', () => {
    assert.doesNotMatch(reporter, /format-comment|upsert-comment/);
  });
});
