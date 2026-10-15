import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Every test file mocking '@actions/core' needs the same full shape, because
// on Bun < 1.2 the first mock of a specifier wins for the whole process.
// See the note in send-comment/index.test.js (#21).
const core = {
  notice: mock(() => {}),
  info: mock(() => {}),
  setFailed: mock(() => {}),
  warning: mock(() => {}),
  setOutput: mock(() => {}),
};

mock.module('@actions/core', () => core);

const { markerFor, markerName, slugify, readConfig, findMarked, upsertComment, describeError, run } = await import('./index.js');
const { formatComment } = await import('../format-comment/index.js');

const MARKER = '<!-- ac-composite-actions:spellcheck -->';

const VALID_ENV = {
  ORG: 'alcash55/Resume',
  PR_NUMBER: '7',
  GH_TOKEN: 'ghp_token',
  MARKER: 'spellcheck',
  MESSAGE: '## Spelling errors',
};

/** A fake octokit that records calls and serves a fixed comment list. */
function fakeOctokit(comments) {
  const calls = { create: [], update: [], remove: [] };
  return {
    calls,
    paginate: mock(async () => comments),
    rest: {
      issues: {
        listComments: () => {},
        createComment: mock(async (args) => {
          calls.create.push(args);
          return { data: { id: 99 } };
        }),
        updateComment: mock(async (args) => {
          calls.update.push(args);
          return { data: {} };
        }),
        deleteComment: mock(async (args) => {
          calls.remove.push(args);
        }),
      },
    },
  };
}

const CONFIG = { owner: 'a', repo: 'b', prNumber: 7, marker: MARKER, message: '## Spelling errors\n- `wrod`' };

describe('secret finding comment lifecycle', () => {
  it('fails a dedicated reporter when commenting is unavailable', async () => {
    await run({ FAIL_ON_ERROR: 'true' });
    expect(core.setFailed).toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalled();
  });
  it('creates a redacted comment, updates the same comment, then removes it on a clean rerun', async () => {
    const marker = markerFor('secrets');
    const data = [{ file: 'fixture.env', line: 1, rule: 'aws-access-token', commit: 'abc123', match: 'never-publish-this' }];
    const config = { ...CONFIG, marker, message: formatComment('secrets', JSON.stringify(data)) };
    const first = fakeOctokit([]);
    expect(await upsertComment(first, config)).toBe('created');
    const body = first.calls.create[0].body;
    expect(body).toContain('[REDACTED]');
    expect(body).toContain('fixture.env');
    expect(body).not.toContain('never-publish-this');

    const existing = [{ id: 99, body }, { id: 100, body: `${MARKER}\nUnrelated spellcheck` }];
    const second = fakeOctokit(existing);
    const changed = formatComment('secrets', JSON.stringify([{ ...data[0], line: 3 }]));
    expect(await upsertComment(second, { ...config, message: changed })).toBe('updated');
    expect(second.calls.update[0].comment_id).toBe(99);
    expect(second.calls.create).toHaveLength(0);

    const clean = fakeOctokit(existing);
    expect(await upsertComment(clean, { ...config, message: formatComment('secrets', '[]') })).toBe('deleted');
    expect(clean.calls.remove.map((call) => call.comment_id)).toEqual([99]);
  });
});

beforeEach(() => {
  core.notice.mockClear();
  core.warning.mockClear();
  core.setFailed.mockClear();
});

describe('markerFor', () => {
  it('builds the hidden marker from the check name', () => {
    expect(markerFor('axe')).toBe('<!-- ac-composite-actions:axe -->');
  });

  it.each(['', 'Axe', 'a b', 'x-->', undefined])('rejects %p, which could break out of the HTML comment', (key) => {
    expect(() => markerFor(key)).toThrow('MARKER must match [a-z0-9-]+');
  });
});

describe('readConfig', () => {
  it('parses a valid environment', () => {
    expect(readConfig(VALID_ENV)).toEqual({
      owner: 'alcash55',
      repo: 'Resume',
      prNumber: 7,
      token: 'ghp_token',
      marker: MARKER,
      message: '## Spelling errors',
    });
  });

  it('allows an empty MESSAGE, which means the check is clean', () => {
    expect(readConfig({ ...VALID_ENV, MESSAGE: '' }).message).toBe('');
  });

  it('names every missing variable', () => {
    expect(() => readConfig({ ORG: 'a/b' })).toThrow('Missing required input(s): PR_NUMBER, GH_TOKEN, MARKER');
  });

  it('rejects a PR number that is not a positive integer', () => {
    expect(() => readConfig({ ...VALID_ENV, PR_NUMBER: 'abc' })).toThrow(
      'PR_NUMBER must be a positive integer, received "abc"'
    );
  });
});

describe('findMarked', () => {
  it('matches only comments that start with the marker', () => {
    const comments = [
      { id: 1, body: `${MARKER}\nreal` },
      // A PR author pasting the marker into their own comment must not be adopted.
      { id: 2, body: `quoting ${MARKER} in prose` },
      { id: 3, body: '<!-- ac-composite-actions:axe -->\nother check' },
      { id: 4, body: null },
    ];

    expect(findMarked(comments, MARKER).map((c) => c.id)).toEqual([1]);
  });
});

describe('upsertComment', () => {
  it('creates the comment with the marker on the first line when none exists', async () => {
    const octokit = fakeOctokit([{ id: 1, body: 'unrelated' }]);

    const result = await upsertComment(octokit, CONFIG);

    expect(result).toBe('created');
    expect(octokit.calls.create).toEqual([
      { owner: 'a', repo: 'b', issue_number: 7, body: `${MARKER}\n## Spelling errors\n- \`wrod\`` },
    ]);
  });

  it('updates the existing comment in place instead of posting a second one', async () => {
    const octokit = fakeOctokit([{ id: 5, body: `${MARKER}\nold errors` }]);

    const result = await upsertComment(octokit, CONFIG);

    expect(result).toBe('updated');
    expect(octokit.calls.update).toEqual([
      { owner: 'a', repo: 'b', comment_id: 5, body: `${MARKER}\n## Spelling errors\n- \`wrod\`` },
    ]);
    expect(octokit.calls.create).toEqual([]);
  });

  it('does not touch the API when the body has not changed', async () => {
    const octokit = fakeOctokit([{ id: 5, body: `${MARKER}\n${CONFIG.message}` }]);

    expect(await upsertComment(octokit, CONFIG)).toBe('unchanged');
    expect(octokit.calls.update).toEqual([]);
  });

  // The clobber case from the brief: spellcheck and axe share a PR.
  it('leaves another check\'s comment alone', async () => {
    const octokit = fakeOctokit([
      { id: 8, body: '<!-- ac-composite-actions:axe -->\n## Accessibility violations' },
      { id: 9, body: `${MARKER}\nold spelling` },
    ]);

    await upsertComment(octokit, CONFIG);

    expect(octokit.calls.update.map((c) => c.comment_id)).toEqual([9]);
    expect(octokit.calls.remove).toEqual([]);
  });

  it('deletes the stale comment when the check comes back clean', async () => {
    const octokit = fakeOctokit([{ id: 5, body: `${MARKER}\nold errors` }]);

    const result = await upsertComment(octokit, { ...CONFIG, message: '' });

    expect(result).toBe('deleted');
    expect(octokit.calls.remove).toEqual([{ owner: 'a', repo: 'b', comment_id: 5 }]);
  });

  it('does nothing on a clean run when there is no old comment', async () => {
    const octokit = fakeOctokit([{ id: 1, body: 'unrelated' }]);

    expect(await upsertComment(octokit, { ...CONFIG, message: '' })).toBe('unchanged');
    expect(octokit.calls.remove).toEqual([]);
    expect(octokit.calls.create).toEqual([]);
  });

  it('collapses duplicates left by a race down to one comment', async () => {
    const octokit = fakeOctokit([
      { id: 5, body: `${MARKER}\na` },
      { id: 6, body: `${MARKER}\nb` },
    ]);

    await upsertComment(octokit, CONFIG);

    expect(octokit.calls.remove.map((c) => c.comment_id)).toEqual([6]);
    expect(octokit.calls.update.map((c) => c.comment_id)).toEqual([5]);
  });
});

describe('describeError', () => {
  it('points a 403 at the pull-requests permission and fork PRs', () => {
    const text = describeError({ status: 403, message: 'Resource not accessible by integration' });

    expect(text).toContain('Resource not accessible by integration');
    expect(text).toContain('pull-requests: write');
    expect(text).toContain('forks');
  });

  it('passes other errors through', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });
});

describe('run never fails the step', () => {
  it('warns instead of failing when the config is incomplete', async () => {
    const result = await run({ ORG: 'a/b' });

    expect(result).toBeUndefined();
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledTimes(1);
    expect(core.warning.mock.calls[0][0]).toContain('Missing required input(s)');
  });
});

describe('slugify', () => {
  it('lowercases and collapses everything outside [a-z0-9] into single hyphens', () => {
    expect(slugify('Full Stack_Resume (v2).pdf')).toBe('full-stack-resume-v2-pdf');
    expect(slugify('--front/end--')).toBe('front-end');
  });

  it('returns an empty string when nothing usable is left', () => {
    expect(slugify('***')).toBe('');
  });
});

describe('markerName and COMMENT_KEY', () => {
  it('keeps the plain kind without a key, so existing comments keep their marker', () => {
    expect(markerName('ats')).toBe('ats');
    expect(markerName('ats', '  ')).toBe('ats');
  });

  it('appends the slugified key to the kind', () => {
    expect(markerName('ats', 'FullStack')).toBe('ats-fullstack');
  });

  it('rejects a key with nothing usable in it and names the value', () => {
    expect(() => markerName('ats', '***')).toThrow('COMMENT_KEY needs at least one letter or digit, received "***"');
  });

  it('builds the marker from MARKER and COMMENT_KEY in the environment', () => {
    expect(readConfig({ ...VALID_ENV, MARKER: 'ats', COMMENT_KEY: 'frontend' }).marker).toBe(
      '<!-- ac-composite-actions:ats-frontend -->'
    );
  });

  it('gives three resumes three comments that do not touch each other', async () => {
    // alcash55/Resume runs ats-check once per PDF on the same PR.
    const resumes = ['fullstack', 'frontend', 'backend'];
    const existing = resumes.map((name, index) => ({
      id: index + 1,
      body: `<!-- ac-composite-actions:ats-${name} -->\n## ATS check (${name}.pdf): needs work (50/100)`,
    }));
    // A comment from before COMMENT_KEY existed stays alone.
    existing.push({ id: 9, body: '<!-- ac-composite-actions:ats -->\nold' });
    const octokit = fakeOctokit(existing);

    const config = readConfig({ ...VALID_ENV, MARKER: 'ats', COMMENT_KEY: 'frontend', MESSAGE: '## ATS check (frontend.pdf): passed (90/100)' });
    const result = await upsertComment(octokit, config);

    expect(result).toBe('updated');
    expect(octokit.calls.update.map((call) => call.comment_id), 'only the frontend comment (id 2) should change').toEqual([2]);
    expect(octokit.calls.remove).toEqual([]);
    expect(octokit.calls.create).toEqual([]);
  });

  it('collapses duplicates of a keyed marker without touching the other keys', async () => {
    const octokit = fakeOctokit([
      { id: 1, body: '<!-- ac-composite-actions:ats-backend -->\na' },
      { id: 2, body: '<!-- ac-composite-actions:ats-frontend -->\nb' },
      { id: 3, body: '<!-- ac-composite-actions:ats-backend -->\nc' },
    ]);

    await upsertComment(octokit, readConfig({ ...VALID_ENV, MARKER: 'ats', COMMENT_KEY: 'backend', MESSAGE: 'new' }));

    expect(octokit.calls.remove.map((call) => call.comment_id), 'the second backend comment should be collapsed').toEqual([3]);
    expect(octokit.calls.update.map((call) => call.comment_id)).toEqual([1]);
  });

  it('does not let the plain ats marker adopt a keyed comment', () => {
    const comments = [{ id: 1, body: '<!-- ac-composite-actions:ats-fullstack -->\nx' }];

    expect(findMarked(comments, markerFor('ats'))).toEqual([]);
  });
});
