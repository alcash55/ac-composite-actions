import { describe, it, expect, mock, beforeEach } from 'bun:test';

const core = {
  notice: mock(() => {}),
  setFailed: mock(() => {}),
};

mock.module('@actions/core', () => core);

const { readConfig, postComment, run } = await import('./index.js');

const VALID_ENV = {
  ORG: 'alcash55/Resume',
  PR_NUMBER: '7',
  GH_TOKEN: 'ghp_token',
  MESSAGE: '# Spell Check\nsomething',
};

beforeEach(() => {
  core.notice.mockClear();
  core.setFailed.mockClear();
});

describe('readConfig', () => {
  it('parses a valid environment', () => {
    expect(readConfig(VALID_ENV)).toEqual({
      owner: 'alcash55',
      repo: 'Resume',
      prNumber: 7,
      token: 'ghp_token',
      message: '# Spell Check\nsomething',
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

  it('defaults message to an empty string rather than "undefined"', () => {
    const env = { ...VALID_ENV };
    delete env.MESSAGE;

    expect(readConfig(env).message).toBe('');
  });
});

describe('postComment', () => {
  it('creates a comment with the given body and returns its id', async () => {
    const octokit = {
      rest: { issues: { createComment: mock(async () => ({ data: { id: 99 } })) } },
    };

    const id = await postComment(octokit, {
      owner: 'alcash55',
      repo: 'Resume',
      prNumber: 7,
      message: '# Spell Check\nbody',
    });

    expect(id).toBe(99);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
      owner: 'alcash55',
      repo: 'Resume',
      issue_number: 7,
      body: '# Spell Check\nbody',
    });
    expect(core.notice).toHaveBeenCalledWith('comment #99 created');
  });
});

describe('run (MESSAGE passthrough)', () => {
  // Regression test for the sprint's Item 3: MESSAGE was accepted as an input
  // but never declared in any step's env:, so it never reached this script.
  it('does nothing and does not throw when MESSAGE is empty', async () => {
    const original = { ...process.env };
    Object.assign(process.env, VALID_ENV, { MESSAGE: '' });

    try {
      const result = await run();

      expect(result).toBeUndefined();
      expect(core.notice).toHaveBeenCalledWith('MESSAGE is empty, nothing to post');
    } finally {
      process.env = original;
    }
  });
});
