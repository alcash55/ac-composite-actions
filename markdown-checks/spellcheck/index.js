import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";
// import cspellConfig from "./.cspell.json" assert { type: "json" };

/**
 * @type {string}
 */
const diff = process.env.DIFF;
/**
 * @type {string}
 */
const branch = process.env.BRANCH;
/**
 * @type {string}
 */
const org = process.env.GITHUB_ORG;
/**
 * @type {string[]}
 */
const [owner, repo] = org.split("/");

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
  let spellError = {};
  const cspellConfig = {
    version: "0.2",
    language: "en",

    words: [
      "mkdirp",
      "tsmerge",
      "githubusercontent",
      "streetsidesoftware",
      "vsmarketplacebadge",
      "visualstudio",
      "Voyix",
      "NCR",
    ],

    files: ["**/*.md", "**/*.mdx"],
  };

  try {
    // Temporarily write file content to a temporary file for cspell to read
    const tempFilePath = "tempFile.txt";
    writeFileSync(tempFilePath, fileContent, "utf-8");

    const spellCommand = `cspell lint --no-exit-code --config ${cspellConfig} ${tempFilePath}`;

    // Run cspell command synchronously
    const cspellOutput = execSync(spellCommand, {
      encoding: "utf-8",
    });

    spellError = { file: path, output: cspellOutput };

    // Remove temporary file
    unlinkSync(tempFilePath);
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

    if (!spellError) {
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
