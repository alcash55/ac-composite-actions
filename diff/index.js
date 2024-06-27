import { Octokit } from '@octokit/rest';
import * as core from '@actions/core';


/**
* @type {number}
*/
const prNumber = parseInt(process.env.PR_NUM);
/**
* @type {string}
*/
const ghRepo = process.env.REPO;
const [owner, repo] = ghRepo.split('/');


const octokit = new Octokit({
 auth: process.env.GITHUB_TOKEN,
});


/**
* Retrieves the list of files in the pull request, checks their validity, and sets outputs.
* @async
* @see https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#list-pull-requests-files
* @returns {Promise<string[]>}
*/
async function getChangedFilenames() {
 try {
   const { data: response } = await octokit.rest.pulls.listFiles({
     owner: owner,
     repo: repo,
     pull_number: prNumber,
   });


   const filenames = response
     .filter(({ status }) => status !== 'removed')
     .map((file) => file.filename);


   return filenames;
 } catch (e) {
   core.setFailed(`Error making request to get files: ${e}`);
   return [];
 }
}


/**
* Checks the validity of file names and sorts based on working and error files.
* @param {string[]} files - Array of file names.
* @returns
*/
export function categorizeFiles(files) {
 let errorFiles = [];
 let workingFiles = [];


 for (const file of files) {
   // Check for spaces
   if (!file.match(/^\S+$/)) {
     errorFiles.push(file);


     // Check that all files are markdown files
   } else if (file.toLowerCase().endsWith('.md')) {
     workingFiles.push(file);
   }
 }


 return { workingFiles, errorFiles };
}


/**
* Formats error messages for files with invalid names.
* @param {string[]} errorFiles - Array of file names with errors.
*/
export function formatErrorMsg(errorFiles) {
 let structure = '';
 let title = '# Broken Links\n';


 for (const errorFile of errorFiles) {
   structure +=
     '- Error: File names cannot have spaces in or around the name\n' +
     '\t- File Name: ' +
     errorFile +
     '\n\n\n';
 }
 return title + structure;
}


try {
 const filenames = await getChangedFilenames();


 if (!filenames.length) {
   core.notice('No Added/Changed files In Diff');
   process.exit();
 } else {
   core.setOutput('ALL_FILES', filenames);
 }


 // sort working files vs error files
 const { errorFiles, workingFiles } = categorizeFiles(filenames);


 if (errorFiles.length) {
   const errorMessage = formatErrorMsg(errorFiles);
   core.setOutput('ERROR_FILES', errorMessage);
 } else {
   core.notice('No Error Files In Diff');
   core.setOutput('ERROR_FILES', ' ');
 }


 if (workingFiles.length) {
   console.log('Working files:\n', workingFiles.join('\n'));
   core.setOutput('DIFF', workingFiles.join(' '));
 } else {
   core.notice('No Working Files In Diff');
   core.setOutput('DIFF', ' ');
 }
} catch (e) {
 core.setFailed(`Diff Action Failed with error: ${e}`);
 console.log('Error: ', e);
}