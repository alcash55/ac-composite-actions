import { readFileSync } from "fs";
import { join } from "path";
import * as core from "@actions/core";

const DEFAULT_TAGS = ["wcag2a", "wcag2aa"];

/**
 * Reads and validates every environment variable this action depends on.
 * Exactly one of two sources is required:
 *
 * - RESULTS_PATH: a JSON file of axe results a consumer's own e2e job
 *   already produced. No browser is installed for this path.
 * - BASE_URL + ROUTES: the action drives its own browser instead, for a
 *   consumer with no e2e infrastructure of its own.
 *
 * A missing pair of inputs throws rather than silently doing nothing — the
 * whole point of this action is to fail loudly when it cannot check
 * anything, not to report a clean run that never ran.
 * @returns {{ resultsPath: string|null, baseUrl: string|null, routes: string[], tags: string[] }}
 */
export function readConfig(env = process.env) {
  const resultsPath = env.RESULTS_PATH || null;
  const routes = (env.ROUTES || "").split(/\s+/).filter(Boolean);
  const baseUrl = env.BASE_URL || null;
  const tags = (env.TAGS || DEFAULT_TAGS.join(","))
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  if (!resultsPath && !(baseUrl && routes.length)) {
    throw new Error(
      "Needs either RESULTS_PATH (axe results a consumer's own e2e job already computed) or " +
        "both BASE_URL and ROUTES (so the action can drive its own browser)."
    );
  }

  return { resultsPath, baseUrl, routes, tags };
}

/**
 * Loads axe results a consumer's own e2e job already computed. Used instead
 * of driving a browser here when the caller already ran
 * @axe-core/playwright itself (e.g. against a `vite preview` build under its
 * own Playwright suite).
 *
 * Expected shape: a JSON array of { route, violations } per route, where
 * `violations` is exactly the array AxeBuilder(...).analyze() returns as
 * `results.violations` — this action never reshapes or reinterprets it, only
 * aggregates and reports.
 * @param {string} absolutePath
 * @returns {{ route: string, violations: object[] }[]}
 */
export function loadResultsEntries(absolutePath) {
  const raw = JSON.parse(readFileSync(absolutePath, "utf-8"));

  if (!Array.isArray(raw)) {
    throw new Error(`RESULTS_PATH must contain a JSON array, got ${typeof raw}`);
  }

  return raw.map((entry, index) => {
    if (!entry || !entry.route) {
      throw new Error(`Entry ${index} in ${absolutePath} is missing "route"`);
    }

    if (!Array.isArray(entry.violations)) {
      throw new Error(`Entry ${index} (${entry.route}) in ${absolutePath} is missing a "violations" array`);
    }

    return { route: entry.route, violations: entry.violations };
  });
}

/**
 * Drives its own browser to run @axe-core/playwright per route. This is the
 * path for a repo with no e2e infrastructure of its own — a repo already
 * running Playwright (e.g. against a `vite preview` build) should prefer
 * computing violations once in its own job and passing RESULTS_PATH instead,
 * so the browser is never installed twice.
 *
 * Both `playwright` and `@axe-core/playwright` are imported dynamically so
 * requiring this module (as the test suite does) never pays for loading
 * them, and so a consumer who never uses this path never needs the browser
 * binary — only `npx playwright install` (a separate, conditional composite
 * step) pays that cost.
 * @param {string} baseUrl
 * @param {string[]} routes
 * @param {string[]} tags
 * @returns {Promise<{ route: string, violations: object[] }[]>}
 */
export async function runAxeSelfDriven(baseUrl, routes, tags) {
  const { chromium } = await import("playwright");
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage();
    const entries = [];

    for (const route of routes) {
      await page.goto(new URL(route, baseUrl).toString(), { waitUntil: "networkidle" });
      const results = await new AxeBuilder({ page }).withTags(tags).analyze();
      entries.push({ route, violations: results.violations });
    }

    return entries;
  } finally {
    await browser.close();
  }
}

/**
 * Builds a human-readable summary of every violation, grouped by route —
 * the same shape as Portfolio's own accessibility.spec.ts failure message,
 * so a red run tells you what broke without opening a separate report.
 * @param {{ route: string, violations: object[] }[]} entries
 * @returns {string|null} null when every route is clean
 */
export function summarizeViolations(entries) {
  const withViolations = entries.filter((entry) => entry.violations.length > 0);

  if (withViolations.length === 0) {
    return null;
  }

  return withViolations
    .map((entry) => {
      const lines = entry.violations
        .map(
          (v) =>
            `  - [${v.impact ?? "unknown"}] ${v.id}: ${(v.nodes ?? []).length} node(s) -- ${v.help}${
              v.helpUrl ? ` (${v.helpUrl})` : ""
            }`
        )
        .join("\n");
      return `${entry.route}:\n${lines}`;
    })
    .join("\n\n");
}

/**
 * Writes the AXE_VIOLATIONS output. Always called, even when every route is
 * clean, so downstream steps can rely on valid JSON rather than an output
 * that only exists when there is something to report.
 * @param {{ route: string, violations: object[] }[]} entries
 */
export function setOutputs(entries) {
  core.setOutput("AXE_VIOLATIONS", JSON.stringify(entries));
}

export async function run() {
  const config = readConfig();
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();

  const entries = config.resultsPath
    ? loadResultsEntries(join(workspace, config.resultsPath))
    : await runAxeSelfDriven(config.baseUrl, config.routes, config.tags);

  for (const entry of entries) {
    if (entry.violations.length === 0) {
      core.info(`No axe violations for ${entry.route}`);
    } else {
      core.warning(`${entry.violations.length} axe violation(s) for ${entry.route}`);
    }
  }

  setOutputs(entries);
  return entries;
}

// Only self-execute as the action entrypoint; importing this module for tests
// must not launch a browser or touch the filesystem outside a test's control.
if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  try {
    await run();
  } catch (e) {
    core.setFailed(`Axe accessibility check action failed: ${e.message}`);
  }
}
