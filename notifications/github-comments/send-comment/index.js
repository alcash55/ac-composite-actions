/**
 * Posts MESSAGE as a new comment on the pull request identified by ORG/PR_NUMBER.
 * Paired with ../delete-comment, which removes the previous run's comment first
 * so a PR only ever carries one live analysis comment at a time.
 */

import { Octokit } from '@octokit/rest';
import * as core from '@actions/core';

/**
 * Reads and validates the environment variables this script depends on.
 * @returns {{ owner: string, repo: string, prNumber: number, token: string, message: string }}
 */
export function readConfig(env = process.env) {
  const missing = ['ORG', 'PR_NUMBER', 'GH_TOKEN'].filter((key) => !env[key]);

  if (missing.length) {
    throw new Error(`Missing required input(s): ${missing.join(', ')}`);
  }

  const [owner, repo] = env.ORG.split('/');

  if (!owner || !repo) {
    throw new Error(`ORG must be in "owner/repo" form, received "${env.ORG}"`);
  }

  const prNumber = Number.parseInt(env.PR_NUMBER, 10);

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`PR_NUMBER must be a positive integer, received "${env.PR_NUMBER}"`);
  }

  return { owner, repo, prNumber, token: env.GH_TOKEN, message: env.MESSAGE ?? '' };
}

/**
 * Posts a new issue comment on the pull request.
 * @see https://docs.github.com/en/rest/issues/comments?apiVersion=2022-11-28#create-an-issue-comment
 * @param {InstanceType<typeof Octokit>} octokit
 * @param {{ owner: string, repo: string, prNumber: number, message: string }} config
 * @returns {Promise<number>} the id of the created comment
 */
export async function postComment(octokit, { owner, repo, prNumber, message }) {
  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: message,
  });

  core.notice(`comment #${data.id} created`);

  return data.id;
}

export async function run() {
  const config = readConfig();

  // The composite action's `if:` already skips this step when MESSAGE is
  // empty; guarded again here since this script can also be invoked directly.
  if (!config.message) {
    core.notice('MESSAGE is empty, nothing to post');
    return undefined;
  }

  const octokit = new Octokit({ auth: config.token });

  return postComment(octokit, config);
}

// Only self-execute as the action entrypoint; importing this module for tests
// must not fire a live API request.
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  try {
    await run();
  } catch (e) {
    core.setFailed(`Send Comment Action Failed with error: ${e.message}`);
  }
}
