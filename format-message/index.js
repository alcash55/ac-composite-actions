import * as core from '@actions/core';

/**
 * GitHub caps an issue/PR comment body at 65536 characters; requests over
 * that are rejected outright. Kept well under it so our own markdown
 * (headings, code fences) never pushes a borderline message over the edge.
 */
export const MAX_COMMENT_LENGTH = 60000;

/**
 * Formats the spellcheck action's SPELL_ERRORS output (a JSON array of
 * `{ file, output }`, see markdown-checks/spellcheck) into a GitHub PR
 * comment body.
 *
 * The heading must be one of the exact prefixes
 * `notifications/github-comments/delete-comment/index.js` filters on
 * (`# Markdown Checks`, `# Broken Links`, `# Spell Check`, or the overflow
 * string below) — otherwise a later run's delete step can never find this
 * comment to remove it before posting a fresh one.
 *
 * @param {string} rawMessage - SPELL_MESSAGE env var, a JSON array or empty string
 * @returns {string} markdown comment body, empty string when there is nothing to report
 */
export function formatSpell(rawMessage) {
  if (!rawMessage) {
    return '';
  }

  let spellErrors;

  try {
    spellErrors = JSON.parse(rawMessage);
  } catch (e) {
    core.error(`SPELL_MESSAGE was not valid JSON: ${e}`);
    return '';
  }

  if (!Array.isArray(spellErrors) || spellErrors.length === 0) {
    return '';
  }

  const sections = spellErrors.map(
    ({ file, output }) => `### \`${file}\`\n\n\`\`\`\n${String(output).trim()}\n\`\`\``
  );

  const body = [
    '# Spell Check',
    '',
    `Found spelling issues in ${spellErrors.length} file(s):`,
    '',
    sections.join('\n\n'),
    '',
  ].join('\n');

  if (body.length <= MAX_COMMENT_LENGTH) {
    return body;
  }

  // Overflow: the exact heading `delete-comment` filters on for this case —
  // a full per-file dump would risk exceeding GitHub's comment size limit.
  const fileList = spellErrors.map((e) => `- \`${e.file}\``).join('\n');

  return [
    '# Too many errors to show full message, fix errors to show fill issue list',
    '',
    `${spellErrors.length} file(s) have spelling issues:`,
    '',
    fileList,
    '',
  ].join('\n');
}

export function run() {
  const formattedMessage = formatSpell(process.env.SPELL_MESSAGE);
  core.setOutput('FORMATTED_MESSAGE', formattedMessage);
  return formattedMessage;
}

// Only self-execute as the action entrypoint; importing this module for tests
// must not fire this against a live environment.
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  try {
    run();
  } catch (e) {
    core.setFailed(`Format message action failed: ${e.message}`);
  }
}
