import { describe, it, expect, mock, beforeEach } from 'bun:test';

const core = {
  notice: mock(() => {}),
  info: mock(() => {}),
  setFailed: mock(() => {}),
};

mock.module('@actions/core', () => core);

const { readConfig, getAllComments, filterComments, filterLegacyComments, deleteComment } =
  await import('./index.js');

const VALID_ENV = { ORG: 'alcash55/Resume', PR_NUMBER: '7', GH_TOKEN: 'ghp_token' };

beforeEach(() => {
  core.notice.mockClear();
  core.info.mockClear();
  core.setFailed.mockClear();
});

describe('readConfig', () => {
  it('parses a valid environment', () => {
    expect(readConfig(VALID_ENV)).toEqual({
      owner: 'alcash55',
      repo: 'Resume',
      prNumber: 7,
      token: 'ghp_token',
    });
  });

  it.each(['ORG', 'PR_NUMBER', 'GH_TOKEN'])('throws when %s is missing', (key) => {
    const env = { ...VALID_ENV };
    delete env[key];

    expect(() => readConfig(env)).toThrow(`Missing required input(s): ${key}`);
  });

  it('rejects a malformed ORG', () => {
    expect(() => readConfig({ ...VALID_ENV, ORG: 'alcash55' })).toThrow(/owner\/repo/);
  });

  it('rejects a non-numeric PR_NUMBER', () => {
    expect(() => readConfig({ ...VALID_ENV, PR_NUMBER: 'nope' })).toThrow(/PR_NUMBER/);
  });
});

describe('getAllComments', () => {
  it('returns the comments from a mocked Octokit', async () => {
    const octokit = {
      rest: {
        issues: {
          listComments: mock(async () => ({ data: [{ id: 1, body: '# Spell Check\n...' }] })),
        },
      },
    };

    const comments = await getAllComments(octokit, { owner: 'alcash55', repo: 'Resume', prNumber: 7 });

    expect(comments).toEqual([{ id: 1, body: '# Spell Check\n...' }]);
    expect(octokit.rest.issues.listComments).toHaveBeenCalledWith({
      owner: 'alcash55',
      repo: 'Resume',
      issue_number: 7,
    });
  });
});

describe('filterComments (the no-previous-comment path)', () => {
  // This is the exact bug class this sprint fixed: a first-ever run on a PR
  // has no previous comment by definition, so this must return normally
  // rather than call process.exit() and kill the rest of the action.
  it('returns undefined without exiting when nothing matches', () => {
    const result = filterComments([{ id: 1, body: 'unrelated comment' }]);

    expect(result).toBeUndefined();
    expect(core.notice).toHaveBeenCalledWith('No matching comments');
  });

  it('returns undefined without exiting on an empty comment list', () => {
    expect(filterComments([])).toBeUndefined();
  });

  it('returns the id of the most recent matching comment', () => {
    const result = filterComments([
      { id: 1, body: '# Spell Check\nold' },
      { id: 2, body: '# Spell Check\nnewer' },
      { id: 3, body: 'unrelated' },
    ]);

    expect(result).toBe(2);
  });

  it.each(['# Markdown Checks', '# Broken Links', '# Spell Check', '# Too many errors to show full message, fix errors to show fill issue list'])(
    'matches the "%s" heading',
    (heading) => {
      expect(filterComments([{ id: 9, body: `${heading}\nbody` }])).toBe(9);
    }
  );
});

describe('filterLegacyComments', () => {
  it('returns undefined without exiting when nothing matches', () => {
    expect(filterLegacyComments([{ id: 1, body: 'not legacy' }])).toBeUndefined();
    expect(core.notice).toHaveBeenCalledWith('No matching legacy comments');
  });

  it('matches a legacy heading', () => {
    expect(filterLegacyComments([{ id: 5, body: '### **Bad Links**\n...' }])).toBe(5);
  });
});

describe('deleteComment', () => {
  it('calls Octokit with the right ids and notices the result', async () => {
    const octokit = { rest: { issues: { deleteComment: mock(async () => {}) } } };

    await deleteComment(octokit, { owner: 'alcash55', repo: 'Resume' }, 42);

    expect(octokit.rest.issues.deleteComment).toHaveBeenCalledWith({
      owner: 'alcash55',
      repo: 'Resume',
      comment_id: 42,
    });
    expect(core.notice).toHaveBeenCalledWith('comment #42 deleted');
  });
});
