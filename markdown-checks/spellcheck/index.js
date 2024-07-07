import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";
import cspellConfig from "./.cspell.json" assert { type: "json" };

/**
 * @type {string}
 */
const diff = process.env.DIFF;
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

// Function to fetch file content using GitHub API
async function getFileContent(path) {
  try {
    // Fetch file content using GitHub API
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: path,
    });

    // Decode content from base64
    const fileContent = Buffer.from(data.content, "base64").toString("utf-8");
    return fileContent;
  } catch (error) {
    console.error("Error fetching file content:", error);
    throw error;
  }
}

// Function to run cspell and check spelling issues
function spellCheck(fileContent) {
  let spellError = "";
  try {
    // Temporarily write file content to a temporary file for cspell to read
    const tempFilePath = "tempFile.txt";
    writeFileSync(tempFilePath, fileContent, "utf-8");

    const spellCommand = `cspell lint --no-exit-code --config ${cspellConfig} ${tempFilePath}`;

    // Run cspell command synchronously
    const cspellOutput = execSync(spellCommand, {
      encoding: "utf-8",
    });

    spellError = cspellOutput;

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
  const spellErrors = [];

  for (const filePath of files) {
    const fileContent = await getFileContent(filePath);
    const spellError = await spellCheck(fileContent);

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
