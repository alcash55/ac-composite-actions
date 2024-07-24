/**
* fetches the most recent comment made by the GitHub bot in a pull request,
* filters comments based on a the text 'Markdown Checks', 'Broken Links', or 'Spell Check', and deletes the first matching comment.
*/


/**
* Represents a pull request comment
* @typedef {object} PullRequestComment
* @property {number} id - the id of the comment
* @property {string} body - body of the comment
* @property {string} user - user who wrote the comment
*/


import { Octokit } from '@octokit/rest';
import * as core from '@actions/core';


/**
* @type {string}
*/
const org = process.env.ORG;
/**
* @type {string[]}
*/
const [owner, repo] = org.split('/');
/**
* @type {number}
*/
const prNumber = parseInt(process.env.PR_NUMBER);
/**
* @type {string}
*/
const ghToken = process.env.GH_TOKEN;


const octokit = new Octokit({
 auth: ghToken,
});


/**
* Retrieves all comments found in PR.
* @see https://docs.github.com/en/rest/issues/comments?apiVersion=2022-11-28#list-issue-comments
* @async
* @function getAllComments
* @return {Promise<Array>}
*/
async function getAllComments() {
 try {
   const { data: comments } = await octokit.rest.issues.listComments({
     owner: owner,
     repo: repo,
     issue_number: prNumber,
   });


   if (!comments.length) {
     core.notice('No comments have been made');
     return [];
   } else {
     return comments;
   }
 } catch (e) {
   core.setFailed(`Action Failed with error: ${e}`);
   console.error('Error getting comments: ', e);
   return [];
 }
}


/**
* Take id from the most recent comment
* @function filterComments
* @param {PullRequestComment[]} commentList
* @return {number | undefined} - id of the comment that will be deleted, if no id return undefined
*/
export function filterComments(commentList) {
 const filteredCommentList = commentList.filter((comment) => {
   return [
     '# Markdown Checks',
     '# Broken Links',
     '# Spell Check',
     '# Too many errors to show full message, fix errors to show fill issue list',
   ].some((text) => {
     return comment.body?.includes(text);
   });
 });


 if (!filteredCommentList.length) {
   console.log('Comments array length: ', filteredCommentList.length);
   core.notice('No matching comments');
   process.exit();
 }


 const lastComment = filteredCommentList.pop()?.id;


 console.log('matching comment ID: ', lastComment);


 return lastComment;
}


/**
* Deletes the specified comment.
* @see https://docs.github.com/en/rest/issues/comments?apiVersion=2022-11-28#delete-an-issue-comment
* @async
* @function deleteComment
* @param {number} commentId - The ID of the comment to be deleted.
*/
export async function deleteComment(commentId) {
 try {
   await octokit.rest.issues.deleteComment({
     owner: owner,
     repo: repo,
     comment_id: commentId,
   });


   core.notice(`comment #${commentId} deleted`);
   console.log(`comment #${commentId} deleted`);
 } catch (e) {
   core.setFailed(`Action Failed with: ${e}`);
   console.error('Unable to delete comment: ', e);
 }
}


/**
* Delete Legacy comment.
* **Once New Static Analysis is completely adopted this will be removed**
* @param {PullRequestComment[]} commentList
*/
export async function deleteLegacyComment(commentList) {
 // get legacy comment id
 const filteredCommentList = commentList.filter((comment) => {
   return ['### **Style Errors**', '### **Bad Links**', '### **Filenames with Blanks**'].some(
     (text) => {
       return comment.body?.includes(text);
     },
   );
 });


 let lastComment;


 if (!filteredCommentList.length) {
   core.notice('No matching legacy comments');
   process.exit();
 } else {
   lastComment = filteredCommentList.pop();
 }


 // delete legacy comment
 try {
   await octokit.rest.issues.deleteComment({
     owner: owner,
     repo: repo,
     comment_id: lastComment.id,
   });


   core.notice(`Legacy comment #${lastComment.id} deleted`);
   console.log(`Legacy comment #${lastComment.id} deleted`);
 } catch (e) {
   core.setFailed(`Action Failed with error: ${e}`);
 }
}


try {
 const commentList = await getAllComments();


 if (commentList) {
   const mostRecentCommentId = filterComments(commentList);


   if (mostRecentCommentId) {
     await deleteComment(mostRecentCommentId);
     await deleteLegacyComment(commentList);
   }
 } else {
   console.log('No Pull Request Comments');
   core.notice('No Pull Request Comments');
 }
} catch (e) {
 core.setFailed(`Delete Comment Action Failed with error: ${e}`);
 console.log('Unable to delete old comment: ', e);
}