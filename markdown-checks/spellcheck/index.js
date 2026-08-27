import { execSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "fs";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";

const DEFAULT_EXTENSIONS = ["ts", "tsx", "html", "md", "mdx", "json"];

/**
 * Reads and validates every environment variable the action depends on. What
 * is required depends on SPELLCHECK_MODE:
 *
 * - `source` (default) with DIFF set: the original PR-diff behaviour —
 *   unchanged, still needs BRANCH/GITHUB_ORG/GH_TOKEN for the API fallback.
 * - `source` with DIFF unset: glob the whole checkout by EXTENSIONS instead
 *   of a PR's changed files. No PR context needed, so BRANCH/GITHUB_ORG/
 *   GH_TOKEN are not required.
 * - `rendered`: needs either RENDERED_CONTENT_PATH (text a consumer's own
 *   e2e job already scraped) or both BASE_URL and ROUTES (so the action
 *   extracts it itself).
 *
 * A missing required var throws rather than silently falling back to a
 * previous developer's repo/branch — the old defaults (`alcash55/Resume`,
 * `testAnalysis`) meant a misconfigured caller would spellcheck someone
 * else's content instead of failing loudly.
 * @returns {object}
 */
export function readConfig(env = process.env) {
  const mode = env.SPELLCHECK_MODE || "source";

  if (mode !== "source" && mode !== "rendered") {
    throw new Error(`SPELLCHECK_MODE must be "source" or "rendered", received "${mode}"`);
  }

  const cspellConfigPath = env.CSPELL_CONFIG_PATH ?? ".cspell.json";
  // The shared baseline only carries generic tool names; a consumer's own
  // proper nouns live in their own repo and are merged in via "import" —
  // see resolveCspellConfigPath.
  const dictionaryPath = env.DICTIONARY || null;

  if (mode === "rendered") {
    const renderedContentPath = env.RENDERED_CONTENT_PATH || null;
    const routes = (env.ROUTES || "").split(/\s+/).filter(Boolean);
    const baseUrl = env.BASE_URL || null;

    if (!renderedContentPath && !(baseUrl && routes.length)) {
      throw new Error(
        "Rendered mode needs either RENDERED_CONTENT_PATH (text a consumer's own e2e job " +
          "already extracted) or both BASE_URL and ROUTES (so the action can extract it itself)."
      );
    }

    return { mode, cspellConfigPath, dictionaryPath, renderedContentPath, routes, baseUrl };
  }

  // mode === "source"
  const diffFiles = (env.DIFF || "").split(" ").filter(Boolean);

  if (diffFiles.length) {
    const missing = ["BRANCH", "GITHUB_ORG", "GH_TOKEN"].filter((key) => !env[key]);

    if (missing.length) {
      throw new Error(`Missing required input(s): ${missing.join(", ")}`);
    }

    const [owner, repo] = env.GITHUB_ORG.split("/");

    if (!owner || !repo) {
      throw new Error(`GITHUB_ORG must be in "owner/repo" form, received "${env.GITHUB_ORG}"`);
    }

    return {
      mode,
      cspellConfigPath,
      dictionaryPath,
      files: diffFiles,
      branch: env.BRANCH,
      owner,
      repo,
      token: env.GH_TOKEN,
    };
  }

  // No DIFF: glob the whole checkout instead of a PR's changed files.
  const extensions = (env.EXTENSIONS || DEFAULT_EXTENSIONS.join(","))
    .split(",")
    .map((ext) => ext.trim().replace(/^\./, ""))
    .filter(Boolean);

  return { mode, cspellConfigPath, dictionaryPath, extensions };
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
 * Lists every file `git` is tracking in `workspace`, filtered to the given
 * extensions. Delegates to `git ls-files` rather than a hand-rolled directory
 * walk so `.gitignore`d paths (`node_modules`, build output, etc.) are
 * excluded for free — exactly what a "checkout" glob should mean.
 * @param {string} workspace - absolute path to the checked-out repository root
 * @param {string[]} extensions - extensions without a leading dot, e.g. ["md", "tsx"]
 * @returns {string[]} repo-relative paths, matching the extension list
 */
export function listCheckoutFiles(workspace, extensions) {
  const output = execSync("git ls-files", { cwd: workspace, encoding: "utf-8" });
  const pattern = new RegExp(`\\.(${extensions.join("|")})$`, "i");

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => pattern.test(file));
}

/**
 * Builds the effective cspell config path for a run. The shared baseline
 * covers generic tool names; a consumer's own proper nouns are merged in via
 * cspell's own "import" mechanism (which concatenates "words" across every
 * imported config) rather than this action re-implementing dictionary
 * merging — the consumer's file just needs its own `words`, nothing else.
 * @param {string} baseConfigPath - the shared markdown-checks/.cspell.json
 * @param {string | null} dictionaryPath - absolute path to a consumer-owned cspell config, or null
 * @returns {{ configPath: string, cleanup: () => void }}
 */
export function resolveCspellConfigPath(baseConfigPath, dictionaryPath) {
  if (!dictionaryPath) {
    return { configPath: baseConfigPath, cleanup: () => {} };
  }

  const mergedConfigPath = join(tmpdir(), `.spellcheck-merged-config-${randomUUID()}.json`);
  writeFileSync(
    mergedConfigPath,
    JSON.stringify({ version: "0.2", import: [baseConfigPath, dictionaryPath] }),
    "utf-8"
  );

  return {
    configPath: mergedConfigPath,
    cleanup: () => {
      if (existsSync(mergedConfigPath)) {
        unlinkSync(mergedConfigPath);
      }
    },
  };
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
 * @param {string} label - original repo-relative path (or route, in rendered mode), used for reporting
 * @param {string} fileContent
 * @param {string} cspellConfigPath
 * @returns {{ file: string, output: string } | null} null when the content is clean
 */
export function spellCheckFile(label, fileContent, cspellConfigPath) {
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

    // Report the real path (or route), not the temp file cspell actually saw.
    return { file: label, output: output.split(tempFilePath).join(label) };
  } finally {
    if (existsSync(tempFilePath)) {
      unlinkSync(tempFilePath);
    }
  }
}

/**
 * Joins the raw pieces scraped from a rendered route into the one blob cspell
 * checks. Shared between the two ways rendered-mode text reaches this action
 * (self-driven extraction and a consumer-supplied RENDERED_CONTENT_PATH) so
 * both paths are held to exactly the same definition of "visible text."
 * @param {{ innerText?: string, description?: string, labels?: string[] }} scraped
 * @returns {string}
 */
export function buildRenderedText({ innerText = "", description = "", labels = [] }) {
  return [innerText, description, ...labels].filter(Boolean).join("\n");
}

/**
 * Loads pre-extracted rendered text a consumer's own e2e job already scraped.
 * Used instead of driving a browser here when the caller already has one
 * running (e.g. a Playwright e2e suite that boots `vite preview` in CI).
 *
 * Expected shape: a JSON array of
 *   { route, innerText, description, labels }
 * per route, matching exactly what extractRenderedEntries would have scraped
 * itself — see buildRenderedText for how the four fields combine.
 * @param {string} absolutePath
 * @returns {{ route: string, text: string }[]}
 */
export function loadRenderedEntries(absolutePath) {
  const raw = JSON.parse(readFileSync(absolutePath, "utf-8"));

  if (!Array.isArray(raw)) {
    throw new Error(`RENDERED_CONTENT_PATH must contain a JSON array, got ${typeof raw}`);
  }

  return raw.map((entry, index) => {
    if (!entry || !entry.route) {
      throw new Error(`Entry ${index} in ${absolutePath} is missing "route"`);
    }

    return { route: entry.route, text: buildRenderedText(entry) };
  });
}

/**
 * Drives its own browser to scrape rendered text per route. This is the path
 * for a repo with no e2e infrastructure of its own — everything else (a repo
 * already running Playwright, e.g. against a `vite preview` build) should
 * prefer scraping once in its own job and passing RENDERED_CONTENT_PATH
 * instead, so the browser is never installed twice.
 *
 * `playwright` is imported dynamically so requiring this module (as the test
 * suite does) never pays for loading it, and so a consumer who never uses
 * this path never needs the browser binary — only `npx playwright install`
 * (a separate, conditional composite step) pays that cost.
 * @param {string} baseUrl
 * @param {string[]} routes
 * @returns {Promise<{ route: string, text: string }[]>}
 */
export async function extractRenderedEntries(baseUrl, routes) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage();
    const entries = [];

    for (const route of routes) {
      await page.goto(new URL(route, baseUrl).toString(), { waitUntil: "networkidle" });

      const scraped = await page.evaluate(() => ({
        innerText: document.body.innerText,
        description: document.querySelector('meta[name="description"]')?.content ?? "",
        labels: Array.from(document.querySelectorAll("[alt], [aria-label], [title]")).flatMap((el) =>
          [el.getAttribute("alt"), el.getAttribute("aria-label"), el.getAttribute("title")].filter(Boolean)
        ),
      }));

      entries.push({ route, text: buildRenderedText(scraped) });
    }

    return entries;
  } finally {
    await browser.close();
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

/**
 * The original PR-diff check: one cspell run per changed file, content
 * resolved from the checkout (falling back to the GitHub API).
 * @param {ReturnType<typeof readConfig>} config
 * @param {string} cspellConfigPath
 * @returns {Promise<{ file: string, output: string }[]>}
 */
async function runSourceDiff(config, cspellConfigPath) {
  const octokit = new Octokit({ auth: config.token });
  const spellErrors = [];

  for (const filePath of config.files) {
    const fileContent = await getFileContent(octokit, config, filePath);
    const result = spellCheckFile(filePath, fileContent, cspellConfigPath);

    if (result) {
      spellErrors.push(result);
    } else {
      core.info(`No spell errors for ${filePath}`);
    }
  }

  return spellErrors;
}

/**
 * The whole-checkout scan: every tracked file matching config.extensions,
 * for callers that want more than a PR's changed files (e.g. a scheduled
 * run with no PR context at all).
 * @param {ReturnType<typeof readConfig>} config
 * @param {string} cspellConfigPath
 * @returns {{ file: string, output: string }[]}
 */
function runSourceGlob(config, cspellConfigPath) {
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const files = listCheckoutFiles(workspace, config.extensions);
  const spellErrors = [];

  for (const filePath of files) {
    const fileContent = readFileFromDisk(workspace, filePath);

    if (fileContent === null) {
      // git ls-files raced with a delete; skip rather than fail the whole run.
      continue;
    }

    const result = spellCheckFile(filePath, fileContent, cspellConfigPath);

    if (result) {
      spellErrors.push(result);
    } else {
      core.info(`No spell errors for ${filePath}`);
    }
  }

  return spellErrors;
}

/**
 * The rendered-site scan: cspell against text scraped per route, either
 * supplied by the caller or extracted here. See extractRenderedEntries and
 * loadRenderedEntries for the two sources.
 * @param {ReturnType<typeof readConfig>} config
 * @param {string} cspellConfigPath
 * @returns {Promise<{ file: string, output: string }[]>}
 */
async function runRendered(config, cspellConfigPath) {
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const entries = config.renderedContentPath
    ? loadRenderedEntries(join(workspace, config.renderedContentPath))
    : await extractRenderedEntries(config.baseUrl, config.routes);

  const spellErrors = [];

  for (const { route, text } of entries) {
    const result = spellCheckFile(route, text, cspellConfigPath);

    if (result) {
      spellErrors.push(result);
    } else {
      core.info(`No spell errors for ${route}`);
    }
  }

  return spellErrors;
}

export async function run() {
  const config = readConfig();
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const dictionaryAbsPath = config.dictionaryPath ? join(workspace, config.dictionaryPath) : null;
  const { configPath, cleanup } = resolveCspellConfigPath(config.cspellConfigPath, dictionaryAbsPath);

  try {
    let spellErrors;

    if (config.mode === "rendered") {
      spellErrors = await runRendered(config, configPath);
    } else if (config.files) {
      spellErrors = await runSourceDiff(config, configPath);
    } else {
      spellErrors = runSourceGlob(config, configPath);
    }

    setOutputs(spellErrors);
    return spellErrors;
  } finally {
    cleanup();
  }
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
