import { execSync } from "child_process";
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";

/**
 * @type {string}
 */
const diff = process.env.DIFF ?? "frontend/src/content/education.mdx";
/**
 * @type {string}
 */
const branch = process.env.BRANCH ?? "testAnalysis";
/**
 * @type {string}
 */
const org = process.env.GITHUB_ORG ?? "alcash55/Resume";
/**
 * @type {string[]}
 */
const [owner, repo] = org.split("/");
/**
 * @type {string}
 */
const cspellConfig = process.env.CSPELL_CONFIG_PATH ?? ".cspell.json";

const octokit = new Octokit({
  auth: process.env.GH_TOKEN,
});

/**
 * Fetch file content using GitHub API
 * @see https://octokit.github.io/rest.js/v20#repos-get-content
 * @param {string} path
 * @returns {Promise<string>}
 */
async function getFileContent(path) {
  try {
    const { data } = await octokit.repos.getContent({
      owner: owner,
      repo: repo,
      path: path,
      ref: branch,
    });

    // Decode content from base64
    const fileContent = Buffer.from(data.content, "base64").toString("utf-8");
    return fileContent;
  } catch (error) {
    console.error("Error fetching file content:", error);
    throw error;
  }
}

/**
 * Run cspell and check spelling issues
 * @see https://github.com/streetsidesoftware/cspell-cli?tab=readme-ov-file#lint
 * @param {string} fileContent
 * @param {string} path
 * @returns {object}
 */
function spellCheck(path, fileContent) {
  let spellError = [];

  try {
    // Temporarily write file content to a temporary file for cspell to read
    const tempFilePath = "tempFile.md";
    writeFileSync(tempFilePath, fileContent, "utf-8");

    const file = readFileSync(tempFilePath, "utf-8");
    console.log(file);

    // const spellCommand = `cspell lint --no-exit-code --config ${cspellConfig} ${tempFilePath}`;

    const spellCommand = `cspell lint --no-exit-code ${tempFilePath}`;

    // Run cspell command synchronously
    const cspellOutput = execSync(spellCommand, {
      encoding: "utf-8",
    });

    if (!cspellOutput) {
      console.log("error: ", cspellOutput);
      console.log(`No errors in file: ${path}`);
    } else {
      spellError.push({ file: path, output: cspellOutput });
    }

    // Remove temporary file
    // unlinkSync(tempFilePath);
  } catch (error) {
    console.error("Error running cspell:", error);
    throw error;
  } finally {
    return spellError;
  }
}

try {
  const files = diff.split(" ");
  /**
   * @type {string[]}
   */
  const spellErrors = [];

  for (const filePath of files) {
    const fileContent = await getFileContent(filePath);
    const spellError = spellCheck(filePath, fileContent);

    if (!spellError.length) {
      console.log(`No spell errors for ${filePath}`);
    } else {
      spellErrors.push(spellError);
    }
  }

  if (spellErrors.length) {
    core.setOutput("SPELL_ERRORS", spellErrors);
  }
} catch (e) {
  console.log(`Unable to check spelling: ${e}`);
}
