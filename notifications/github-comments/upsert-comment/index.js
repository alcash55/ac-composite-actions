/**
 * Keeps exactly one comment per check on a pull request, found by a hidden
 * marker (`<!-- ac-composite-actions:<MARKER> -->`) on its first line.
 *
 * - MESSAGE set: update the marked comment in place, or create it.
 * - MESSAGE empty: the check is clean, so delete the marked comment.
 *
 * delete-comment finds "the last bot comment with a known heading", which
 * lets two checks delete each other's comments. A marker per check gives each
 * one its own comment and leaves everything else alone.
 *
 * This script never fails the step. A fork PR gets a read-only token, and a
 * missing comment must not turn a passing check red, so every error becomes
 * a warning.
 */

import { Octokit } from '@octokit/rest';
import * as core from '@actions/core';

const MARKER_PREFIX = '<!-- ac-composite-actions:';

/**
 * @param {string} key - check name, lowercase letters, digits, and hyphens
 * @returns {string}
 */
export function markerFor(key) {
  if (!/^[a-z0-9-]+$/.test(key ?? '')) {
    throw new Error(`MARKER must match [a-z0-9-]+, received "${key}"`);
  }
  return `${MARKER_PREFIX}${key} -->`;
}

/**
 * Turns free text (a resume filename, a route name) into a marker-safe slug:
 * lowercase letters, digits, single hyphens. Capped so a long path cannot
 * make the marker unwieldy.
 * @param {unknown} value
 * @returns {string} '' when nothing usable is left
 */
export function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

/**
 * Combines the check name with an optional COMMENT_KEY, so one check run
 * several times on a PR (three resumes, two axe sites) gets one comment each.
 * @param {string} kind
 * @param {string} [commentKey]
 * @returns {string} the marker name, e.g. `ats-fullstack`
 */
export function markerName(kind, commentKey = '') {
  if (!commentKey.trim()) {
    return kind;
  }
  const slug = slugify(commentKey);
  if (!slug) {
    throw new Error(`COMMENT_KEY needs at least one letter or digit, received "${commentKey}"`);
  }
  return `${kind}-${slug}`;
}

/**
 * Reads and validates the environment variables this script depends on.
 * @returns {{ owner: string, repo: string, prNumber: number, token: string, marker: string, message: string, headSha?: string }}
 */
export function readConfig(env = process.env) {
  const missing = ['ORG', 'PR_NUMBER', 'GH_TOKEN', 'MARKER'].filter((key) => !env[key]);

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

  if (env.HEAD_SHA && !/^[a-f0-9]{40}$/i.test(env.HEAD_SHA)) {
    throw new Error('HEAD_SHA must be a full commit SHA');
  }

  return {
    owner,
    repo,
    prNumber,
    token: env.GH_TOKEN,
    marker: markerFor(markerName(env.MARKER, env.COMMENT_KEY ?? '')),
    message: (env.MESSAGE ?? '').trim(),
    ...(env.HEAD_SHA ? { headSha: env.HEAD_SHA.toLowerCase() } : {}),
  };
}

/**
 * Comments that carry this marker. Matching the start of the body, not
 * anywhere in it, means a PR author who pastes the marker into their own
 * comment, or into a filename the check echoes back, cannot get it adopted.
 * @param {{ id: number, body?: string | null }[]} comments
 * @param {string} marker
 * @returns {{ id: number, body?: string | null }[]}
 */
export function findMarked(comments, marker) {
  return comments.filter((comment) => comment.body?.startsWith(marker));
}

/**
 * Applies the upsert. Split from run() so tests can hand it a fake octokit.
 * @param {InstanceType<typeof Octokit>} octokit
 * @param {ReturnType<typeof readConfig>} config
 * @returns {Promise<'created' | 'updated' | 'deleted' | 'unchanged' | 'stale'>}
 */
export async function upsertComment(octokit, { owner, repo, prNumber, marker, message, headSha }) {
  // Paginate: a busy PR passes the 30 comments a bare listComments returns,
  // and the marked comment would silently stop being found.
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });

  // A slow run for an earlier push must not overwrite or delete newer results.
  // Check after reading comments, immediately before any writes. Caller-side
  // concurrency cancellation also prevents superseded runs from publishing.
  if (headSha) {
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    if (pr.state !== 'open' || pr.head.sha !== headSha) {
      core.notice(`Skipped results for superseded commit ${headSha}`);
      return 'stale';
    }
  }

  const [current, ...duplicates] = findMarked(comments, marker);

  for (const duplicate of duplicates) {
    await octokit.rest.issues.deleteComment({ owner, repo, comment_id: duplicate.id });
    core.notice(`duplicate comment #${duplicate.id} deleted`);
  }

  if (!message) {
    if (!current) {
      return 'unchanged';
    }
    await octokit.rest.issues.deleteComment({ owner, repo, comment_id: current.id });
    core.notice(`comment #${current.id} deleted, the check is clean`);
    return 'deleted';
  }

  const body = `${marker}\n${message}${headSha ? `\n\n_Checked commit: \`${headSha}\`._` : ''}`;

  if (!current) {
    const { data } = await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
    core.notice(`comment #${data.id} created`);
    return 'created';
  }

  if (current.body === body) {
    return 'unchanged';
  }

  await octokit.rest.issues.updateComment({ owner, repo, comment_id: current.id, body });
  core.notice(`comment #${current.id} updated`);
  return 'updated';
}

/**
 * Explains the usual reasons the GitHub API refuses us, so the warning says
 * what to change instead of just "Resource not accessible by integration".
 * @param {{ status?: number, message?: string }} error
 * @returns {string}
 */
export function describeError(error) {
  if (error?.status === 403 || error?.status === 404) {
    return (
      `${error.message}. The token cannot write PR comments. Grant the calling job ` +
      '`pull-requests: write`; PRs from forks get a read-only token and cannot comment.'
    );
  }
  return error?.message ?? String(error);
}

export async function run(env = process.env) {
  try {
    const config = readConfig(env);
    const octokit = new Octokit({ auth: config.token });
    return await upsertComment(octokit, config);
  } catch (e) {
    core.warning(`Skipped the PR comment: ${describeError(e)}`);
    return undefined;
  }
}

// Only self-execute as the action entrypoint; importing this module for tests
// must not fire a live API request.
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  await run();
}
