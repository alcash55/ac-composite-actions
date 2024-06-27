import checks from './checks.js';
import * as readline from 'readline';
import * as fs from 'fs';
import * as core from '@actions/core';


/**
* @type {string}
*/
const ghRepo = process.env.REPO;
const [owner, repo] = ghRepo.split('/');
/**
* @type {string}
*/
const branchRef = process.env.CURRENT_BRANCH ?? 'main'
const files = process.env.DIFF;
const filePaths = files.split(' ');
const errors = [];


/**
* @async
* @param {string} filePath - File path relative to this current file ex.) ../implementing/charitable_donations/creating_charitable_donations_revenue_item.md
* @param {{ regex: RegExp, message: string, severity: 'warning' | 'error', type: string }[]} checks
*/
async function runChecks(filePath, checks) {
 if (!fs.existsSync(filePath)) {
   console.error(filePath, ' does not exist');
   return [];
 }


 const fileStream = fs.createReadStream(filePath);


 const rl = readline.createInterface({
   input: fileStream,
   crlfDelay: Infinity,
 });


 let issues = [];
 let lineNumber = 1;


 for await (const line of rl) {
   for (const check of checks) {
     if (line.match(check.regex)) {
       issues.push({
         severity: check.severity,
         file: filePath,
         line: lineNumber,
         message: check.message,
         type: check.type,
       });
     }
   }
   lineNumber++;
 }
 return issues;
}


/**
* Formats all markdown errors into a string to be sent in the pull request comment
* @param {{severity: string, file: string, line: number, message: string, type: string}[]} checkErrors - JSON containing error data from markdown-checks
* @return {string} - formatted msg of all markdown errors
*/
function formatComment(checkErrors) {
 let markdownErrors = '# Markdown Checks\n';


 for (const error of checkErrors) {
   const file = error.file.slice(3);
   const link = `https://github.com/${owner}/${repo}/blob/${branchRef}/${file}`;


   markdownErrors +=
     ' - ' +
     error.severity +
     ': ' +
     error.message +
     '\n\t - File Name: <a href=' +
     link +
     '>' +
     file +
     '</a>\n\t' +
     ' - Line Number: ' +
     error.line +
     '\n\t' +
     ' - Issue Type: ' +
     error.type +
     '\n\n\n';
 }


 return markdownErrors;
}


try {
 if (!filePaths) {
   console.log('No files');
   core.setOutput('MARKDOWN_ERRORS', '');
 } else {
   for (const filePath of filePaths) {
     console.log(filePath);
     const newErrors = await runChecks('../' + filePath, checks);


     if (newErrors) {
       errors.push(...newErrors);
     }
   }


   if (errors.length > 0) {
     core.setOutput('MARKDOWN_ERRORS', formatComment(errors));
   } else {
     core.setOutput('MARKDOWN_ERRORS', '');
   }
 }
} catch (e) {
 console.log('Unable to run checks on files: ', e);
}
