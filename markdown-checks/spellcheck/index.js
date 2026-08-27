import { execSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";

/**
 * Reads and validates every environment variable the action depends on.
 * A missing required var throws rather than silently falling back to a
 * previous developer's repo/branch — the old defaults (`alcash55/Resume`,
 * `testAnalysis`) meant a misconfigured caller would spellcheck someone
 * else's content instead of failing loudly.
 * @returns {{ files: string[], branch: string, owner: string, repo: string, token: string, cspellConfigPath: string }}
 */
export function readConfig(env = process.env) {
  const missing = ["DIFF", "BRANCH", "GITHUB_ORG", "GH_TOKEN"].filter((key) => !env[key]);

  if (missing.length) {
    throw new Error(`Missing required input(s): ${missing.join(", ")}`);
  }

  const [owner, repo] = env.GITHUB_ORG.split("/");

  if (!owner || !repo) {
    throw new Error(`GITHUB_ORG must be in "owner/repo" form, received "${env.GITHUB_ORG}"`);
  }

  return {
    files: env.DIFF.split(" ").filter(Boolean),
    branch: env.BRANCH,
    owner,
    repo,
    token: env.GH_TOKEN,
    cspellConfigPath: env.CSPELL_CONFIG_PATH ?? ".cspell.json",
  };
}

/**
 * Reads a file straight off the runner's disk. The calling workflow checks the
 * repository out before this action runs, so the content is already there —
 * paying for a GitHub API request per file is unnecessary in the common case.
 * @param {string} workspace - absolute path to the checked-out repository root
 * @param {string} filePath - path relative to the repository root
 * @returns {string | null} file content, or null if the file is not on disk
 */
export function readFileFromDisk(workspace, filePath) {
  const absolutePath = join(workspace, filePath);
  return existsSync(absolutePath) ? readFileSync(absolutePath, "utf-8") : null;
}

/**
 * Fetches file content from the GitHub API. Kept as a fallback for the case
 * where BRANCH names a ref other than the one the calling workflow checked
 * out (e.g. spellchecking a different branch than the one running the
 * workflow) — the checkout on disk would not have that content at all.
 * @see https://octokit.github.io/rest.js/v20#repos-get-content
 * @param {InstanceType<typeof Octokit>} octokit
 * @param {{ owner: string, repo: string, path: string, ref: string }} params
 * @returns {Promise<string>}
 */
export async function fetchFileFromApi(octokit, { owner, repo, path, ref }) {
  const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
  return Buffer.from(data.content, "base64").toString("utf-8");
}

/**
 * Resolves a file's content, preferring the on-disk checkout and only calling
 * the GitHub API when the file is not present locally.
 * @param {InstanceType<typeof Octokit>} octokit
 * @param {{ owner: string, repo: string, branch: string }} config
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function getFileContent(octokit, config, filePath) {
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const onDisk = readFileFromDisk(workspace, filePath);

  if (onDisk !== null) {
    return onDisk;
  }

  core.info(`${filePath} not found in checkout, falling back to the GitHub API`);
  return fetchFileFromApi(octokit, {
    owner: config.owner,
    repo: config.repo,
    path: filePath,
    ref: config.branch,
  });
}

/**
 * Runs cspell against a single file's content and returns its raw report.
 * Isolated from spellCheckFile so tests can mock execSync without touching
 * the filesystem plumbing around it.
 * @param {string} tempFilePath
 * @param {string} cspellConfigPath
 * @returns {string} raw cspell output, empty string when clean
 */
export function runCspell(tempFilePath, cspellConfigPath) {
  return execSync(`cspell lint --no-exit-code --config "${cspellConfigPath}" "${tempFilePath}"`, {
    encoding: "utf-8",
  });
}

/**
 * Checks a single file's content for spelling issues.
 *
 * cspell only accepts real files, so content is written to a uniquely named
 * temp file per invocation (rather than a shared `tempFile.md`) so an error
 * partway through a run cannot leave one file's leftovers to be checked
 * against another file's name, and the file is always removed in `finally`
 * so nothing survives between files or between runs.
 * @param {string} filePath - original repo-relative path, used for reporting
 * @param {string} fileContent
 * @param {string} cspellConfigPath
 * @returns {{ file: string, output: string } | null} null when the file is clean
 */
export function spellCheckFile(filePath, fileContent, cspellConfigPath) {
  // Written under cwd (the action's own directory at runtime), not the OS temp
  // dir: .cspell.json restricts linting to a "files" glob ("**/*.md" etc.) that
  // is matched relative to cwd, so a file written outside that tree is silently
  // skipped — cspell reports "0 files checked" instead of an error.
  const tempFilePath = join(process.cwd(), `.spellcheck-tmp-${randomUUID()}.md`);

  try {
    writeFileSync(tempFilePath, fileContent, "utf-8");

    const output = runCspell(tempFilePath, cspellConfigPath);

    if (!output) {
      return null;
    }

    // Report the real path, not the temp file cspell actually saw.
    return { file: filePath, output: output.split(tempFilePath).join(filePath) };
  } finally {
    if (existsSync(tempFilePath)) {
      unlinkSync(tempFilePath);
    }
  }
}

/**
 * Writes the SPELL_ERRORS output. Always called, even when every file is
 * clean, so downstream steps can rely on valid JSON rather than an output
 * that only exists when there is something to report.
 * @param {{ file: string, output: string }[]} spellErrors
 */
export function setOutputs(spellErrors) {
  core.setOutput("SPELL_ERRORS", JSON.stringify(spellErrors));
}

export async function run() {
  const config = readConfig();
  const octokit = new Octokit({ auth: config.token });

  const spellErrors = [];

  for (const filePath of config.files) {
    const fileContent = await getFileContent(octokit, config, filePath);
    const result = spellCheckFile(filePath, fileContent, config.cspellConfigPath);

    if (result) {
      spellErrors.push(result);
    } else {
      core.info(`No spell errors for ${filePath}`);
    }
  }

  setOutputs(spellErrors);

  return spellErrors;
}

// Only self-execute as the action entrypoint; importing this module for tests
// must not fire a live API request or shell out to cspell.
if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  try {
    await run();
  } catch (e) {
    core.setFailed(`Spell check action failed: ${e.message}`);
  }
}
