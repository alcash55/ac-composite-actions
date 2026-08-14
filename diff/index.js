import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';

/**
 * Default set of extensions treated as "working" files when FILE_EXTENSIONS is
 * not supplied. Kept as the historical default so existing callers are unaffected.
 * @type {string}
 */
const DEFAULT_EXTENSIONS = 'md,mdx';

/**
 * Reads and validates every environment variable the action depends on.
 * Throws with an actionable message rather than letting the failure surface
 * later as an unhelpful `undefined.split` style error.
 * @returns {{ owner: string, repo: string, prNumber: number, token: string, extensions: string[] }}
 */
export function readConfig(env = process.env) {
  const missing = ['PR_NUMBER', 'GITHUB_ORG', 'GH_TOKEN'].filter((key) => !env[key]);

  if (missing.length) {
    throw new Error(`Missing required input(s): ${missing.join(', ')}`);
  }

  // Matched strictly rather than parsed: parseInt('12abc') is 12 and
  // parseInt('1.5') is 1, either of which would target the wrong pull request.
  const rawPrNumber = String(env.PR_NUMBER).trim();

  if (!/^[1-9]\d*$/.test(rawPrNumber)) {
    throw new Error(`PR_NUMBER must be a positive integer, received "${env.PR_NUMBER}"`);
  }

  const prNumber = Number.parseInt(rawPrNumber, 10);

  const [owner, repo] = env.GITHUB_ORG.split('/');

  if (!owner || !repo) {
    throw new Error(`GITHUB_ORG must be in "owner/repo" form, received "${env.GITHUB_ORG}"`);
  }

  return {
    owner,
    repo,
    prNumber,
    token: env.GH_TOKEN,
    extensions: parseExtensions(env.FILE_EXTENSIONS ?? DEFAULT_EXTENSIONS),
  };
}

/**
 * Normalizes a comma/space delimited extension list into lowercase, dot-prefixed
 * extensions. Accepts "md, .MDX" and yields ['.md', '.mdx'].
 * @param {string} raw
 * @returns {string[]}
 */
export function parseExtensions(raw) {
  const extensions = raw
    .split(/[,\s]+/)
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean)
    .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));

  if (!extensions.length) {
    throw new Error(`FILE_EXTENSIONS did not contain any extensions, received "${raw}"`);
  }

  return [...new Set(extensions)];
}

/**
 * Retrieves every file in the pull request. Paginates, because the underlying
 * endpoint returns only 30 files per page by default — a large PR would
 * otherwise be silently truncated.
 * @see https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#list-pull-requests-files
 * @param {Octokit} octokit
 * @param {{ owner: string, repo: string, prNumber: number }} config
 * @returns {Promise<string[]>} Filenames of every added/modified/renamed file.
 */
export async function getChangedFilenames(octokit, { owner, repo, prNumber }) {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  return files.filter(({ status }) => status !== 'removed').map((file) => file.filename);
}

/**
 * Splits the changed files into the ones we can process and the ones with names
 * we reject. Files that are valid but not of an interesting extension are
 * dropped from both lists.
 * @param {string[]} files - Array of file names.
 * @param {string[]} extensions - Lowercase, dot-prefixed extensions to keep.
 * @returns {{ workingFiles: string[], errorFiles: string[] }}
 */
export function categorizeFiles(files, extensions) {
  const errorFiles = [];
  const workingFiles = [];

  for (const file of files) {
    // Whitespace anywhere in the path breaks the space-delimited DIFF contract
    // that downstream actions consume, so these are reported rather than passed on.
    if (/\s/.test(file)) {
      errorFiles.push(file);
      continue;
    }

    if (extensions.some((ext) => file.toLowerCase().endsWith(ext))) {
      workingFiles.push(file);
    }
  }

  return { workingFiles, errorFiles };
}

/**
 * Formats the rejected file names as a markdown report suitable for a PR comment.
 * @param {string[]} errorFiles - Array of file names with errors.
 * @returns {string} Empty string when there is nothing to report.
 */
export function formatErrorMsg(errorFiles) {
  if (!errorFiles.length) {
    return '';
  }

  const body = errorFiles
    .map((file) => `- \`${file}\`\n  - File names cannot contain spaces`)
    .join('\n');

  return `# Invalid File Names\n\n${body}\n`;
}

/**
 * Writes every declared output. Always called, even on an empty diff, so callers
 * can rely on each output existing rather than resolving to an empty string
 * because the step bailed out early.
 * @param {{ allFiles: string[], workingFiles: string[], errorFiles: string[] }} results
 */
export function setOutputs({ allFiles, workingFiles, errorFiles }) {
  core.setOutput('ALL_FILES', allFiles.join(' '));
  core.setOutput('DIFF', workingFiles.join(' '));
  core.setOutput('ERROR_FILES', formatErrorMsg(errorFiles));
  core.setOutput('HAS_CHANGES', String(workingFiles.length > 0));
}

export async function run() {
  const config = readConfig();
  const octokit = new Octokit({ auth: config.token });

  const allFiles = await getChangedFilenames(octokit, config);

  if (!allFiles.length) {
    core.notice('No added/changed files in diff');
    setOutputs({ allFiles: [], workingFiles: [], errorFiles: [] });
    return;
  }

  const { workingFiles, errorFiles } = categorizeFiles(allFiles, config.extensions);

  core.info(`Changed files (${allFiles.length}):\n${allFiles.join('\n')}`);

  if (workingFiles.length) {
    core.info(`Matched files (${workingFiles.length}):\n${workingFiles.join('\n')}`);
  } else {
    core.notice(`No files matching ${config.extensions.join(', ')} in diff`);
  }

  if (errorFiles.length) {
    core.warning(`Skipped ${errorFiles.length} file(s) with invalid names`);
  }

  setOutputs({ allFiles, workingFiles, errorFiles });
}

// Only self-execute as the action entrypoint; importing this module for tests
// must not fire a live API request.
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  try {
    await run();
  } catch (e) {
    core.setFailed(`Diff action failed: ${e.message}`);
  }
}
