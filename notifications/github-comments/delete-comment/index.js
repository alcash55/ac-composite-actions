/**
* fetches the most recent comment made by the GitHub bot in a pull request,
* filters comments based on a the text 'Markdown Checks', 'Broken Links', or 'Spell Check', and deletes the first matching comment.
*/

/**
* Represents a pull request comment
* @typedef {object} PullRequestComment
* @property {number} id - the id of the comment
* @property {string} body - body of the comment
* @property {string} user - user who wrote the comment
*/

import { Octokit } from '@octokit/rest';
import * as core from '@actions/core';

const CURRENT_HEADINGS = [
  '# Markdown Checks',
  '# Broken Links',
  '# Spell Check',
  '# Too many errors to show full message, fix errors to show fill issue list',
];

const LEGACY_HEADINGS = ['### **Style Errors**', '### **Bad Links**', '### **Filenames with Blanks**'];

/**
* Reads and validates the environment variables this script depends on.
* @returns {{ owner: string, repo: string, prNumber: number, token: string }}
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

  return { owner, repo, prNumber, token: env.GH_TOKEN };
}

/**
* Retrieves all comments found in PR.
* @see https://docs.github.com/en/rest/issues/comments?apiVersion=2022-11-28#list-issue-comments
* @async
* @param {InstanceType<typeof Octokit>} octokit
* @param {{ owner: string, repo: string, prNumber: number }} config
* @return {Promise<PullRequestComment[]>}
*/
export async function getAllComments(octokit, { owner, repo, prNumber }) {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
  });

  if (!comments.length) {
    core.notice('No comments have been made');
  }

  return comments;
}

/**
* Finds the most recent comment matching one of our own headings.
*
* A first-ever run on a PR has no previous comment by definition — that is
* the normal, expected case, not a failure, so this returns `undefined`
* rather than exiting the process. Exiting here previously killed the whole
* action before the "send comment" step could run at all.
* @function filterComments
* @param {PullRequestComment[]} commentList
* @return {number | undefined} - id of the comment that will be deleted, if no id return undefined
*/
export function filterComments(commentList) {
  const filteredCommentList = commentList.filter((comment) =>
    CURRENT_HEADINGS.some((text) => comment.body?.includes(text))
  );

  if (!filteredCommentList.length) {
    core.notice('No matching comments');
    return undefined;
  }

  const lastComment = filteredCommentList.pop()?.id;

  core.info(`matching comment ID: ${lastComment}`);

  return lastComment;
}

/**
* Finds the most recent comment matching a legacy (pre-rewrite) heading.
* Same "no match is normal" rule as {@link filterComments}.
* @param {PullRequestComment[]} commentList
* @return {number | undefined}
*/
export function filterLegacyComments(commentList) {
  const filteredCommentList = commentList.filter((comment) =>
    LEGACY_HEADINGS.some((text) => comment.body?.includes(text))
  );

  if (!filteredCommentList.length) {
    core.notice('No matching legacy comments');
    return undefined;
  }

  return filteredCommentList.pop()?.id;
}

/**
* Deletes the specified comment.
* @see https://docs.github.com/en/rest/issues/comments?apiVersion=2022-11-28#delete-an-issue-comment
* @async
* @param {InstanceType<typeof Octokit>} octokit
* @param {{ owner: string, repo: string }} config
* @param {number} commentId - The ID of the comment to be deleted.
*/
export async function deleteComment(octokit, { owner, repo }, commentId) {
  await octokit.rest.issues.deleteComment({ owner, repo, comment_id: commentId });
  core.notice(`comment #${commentId} deleted`);
}

export async function run() {
  const config = readConfig();
  const octokit = new Octokit({ auth: config.token });

  const commentList = await getAllComments(octokit, config);

  const mostRecentCommentId = filterComments(commentList);
  if (mostRecentCommentId) {
    await deleteComment(octokit, config, mostRecentCommentId);
  }

  // Independent of whether a current-style comment was found — a PR can be
  // mid-migration and have only a legacy comment, or only a current one.
  // **Once New Static Analysis is completely adopted this will be removed**
  const legacyCommentId = filterLegacyComments(commentList);
  if (legacyCommentId) {
    await deleteComment(octokit, config, legacyCommentId);
    core.notice(`Legacy comment #${legacyCommentId} deleted`);
  }
}

// Only self-execute as the action entrypoint; importing this module for tests
// must not fire a live API request.
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  try {
    await run();
  } catch (e) {
    core.setFailed(`Delete Comment Action Failed with error: ${e.message}`);
  }
}
