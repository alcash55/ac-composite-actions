/**
 * Turns a checker action's output (spellcheck, axe, ATS) into the markdown
 * body of its pull request comment. Pure formatting: the upsert-comment
 * script owns marker handling and talking to GitHub.
 *
 * An empty body means "this check is clean, remove your old comment".
 *
 * Filenames, words, selectors, and axe help text all come from the PR author
 * or the page under test. Every one goes through codeSpan or escapeText so it
 * cannot add markdown, HTML, a link, or an @mention to the comment.
 */

import * as core from '@actions/core';

/**
 * GitHub rejects comment bodies over 65536 characters. Same budget as
 * format-message, leaving room for the marker and the truncation notice.
 */
export const MAX_BODY_LENGTH = 60000;

const MAX_SELECTORS_PER_VIOLATION = 3;
const MAX_TEXT_LENGTH = 200;

/**
 * Collapses control characters and whitespace runs, and caps the length.
 * A value may not carry a line break, or it could start a new markdown block.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function cleanText(value, max = MAX_TEXT_LENGTH) {
  // eslint-disable-next-line no-control-regex
  const flat = String(value ?? '').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Wraps text in an inline code span that cannot be closed early. The fence
 * is one backtick longer than the longest backtick run inside the text.
 * Inside a code span markdown, HTML, and @mentions are all inert.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function codeSpan(value, max = MAX_TEXT_LENGTH) {
  const text = cleanText(value, max);
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text || ' '}${pad}${fence}`;
}

/**
 * Escapes free text (not code) so it renders as literal text: no markdown,
 * no HTML, no @mention pings.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function escapeText(value, max = MAX_TEXT_LENGTH) {
  return cleanText(value, max)
    .replace(/[\\`*_[\]<>|#~&]/g, (char) => `\\${char}`)
    .replace(/@/g, '@​');
}

/**
 * Only plain https links make it into the comment, so a crafted helpUrl
 * cannot smuggle in a javascript: link or break out of the link syntax.
 * @param {unknown} value
 * @returns {string | null}
 */
export function safeUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:') {
      return null;
    }
    // encodeURIComponent leaves ( and ) alone, which would end the link.
    return url.href.replace(/[()<>\s]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  } catch {
    return null;
  }
}

/**
 * Joins blocks until the budget runs out, then says how many were dropped.
 * @param {string[]} header
 * @param {string[]} blocks
 * @param {string} noun - what a dropped block is, for the notice
 * @param {number} [limit]
 * @returns {string}
 */
export function joinWithinLimit(header, blocks, noun, limit = MAX_BODY_LENGTH) {
  const lines = [...header];
  let length = lines.join('\n').length;
  let shown = 0;

  for (const block of blocks) {
    // Reserve room for the notice so appending it cannot push us over.
    if (length + block.length + 200 > limit) {
      break;
    }
    lines.push(block);
    length += block.length + 1;
    shown += 1;
  }

  if (shown < blocks.length) {
    lines.push(`_${blocks.length - shown} more ${noun} not shown. See the workflow run log for the full list._`);
  }

  return lines.join('\n');
}

const CSPELL_LINE = /^.*?:(\d+):\d+\s+-\s+(?:Unknown|Forbidden) word \((.+?)\)/;

/**
 * Pulls { word, line } pairs out of raw cspell output. cspell prints
 * `path:line:col - Unknown word (word)`; anything else (summary lines,
 * future format changes) is ignored here and handled by the caller.
 * @param {string} output
 * @returns {{ word: string, lines: number[] }[]} unique words in first-seen order
 */
export function parseCspellOutput(output) {
  const byWord = new Map();

  for (const rawLine of String(output ?? '').split('\n')) {
    const match = CSPELL_LINE.exec(rawLine.trim());
    if (!match) {
      continue;
    }
    const [, line, word] = match;
    const entry = byWord.get(word) ?? { word, lines: [] };
    entry.lines.push(Number(line));
    byWord.set(word, entry);
  }

  return [...byWord.values()];
}

function parseJson(raw, kind) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`DATA for ${kind} was not valid JSON (${error.message}). Received: ${cleanText(raw, 80)}`);
  }
}

/**
 * @param {unknown} data - SPELL_ERRORS: array of { file, output }
 * @returns {string} markdown, '' when there are no spelling errors
 */
export function formatSpellcheck(data) {
  if (!Array.isArray(data) || data.length === 0) {
    return '';
  }

  const blocks = data.map(({ file, output }) => {
    const words = parseCspellOutput(output);

    if (words.length === 0) {
      // Format we do not recognise: show cspell's own text rather than nothing.
      const raw = String(output ?? '').trim().slice(0, 1000).replace(/`{3,}/g, "'''");
      return `### ${codeSpan(file)}\n\n\`\`\`text\n${raw}\n\`\`\`\n`;
    }

    const items = words.map(({ word, lines }) => {
      const shownLines = lines.slice(0, 5).join(', ');
      const more = lines.length > 5 ? ', ...' : '';
      return `- ${codeSpan(word, 80)} (line ${shownLines}${more})`;
    });

    return `### ${codeSpan(file)}\n\n${items.join('\n')}\n`;
  });

  return joinWithinLimit(
    [
      '## Spelling errors',
      '',
      `Found misspelled words in ${data.length} file(s). Fix them or add real terms to the project dictionary.`,
      '',
    ],
    blocks,
    'file(s)'
  );
}

/**
 * @param {unknown} data - AXE_VIOLATIONS: array of { route, violations }
 * @returns {string} markdown, '' when no route has a violation
 */
export function formatAxe(data) {
  const routes = (Array.isArray(data) ? data : []).filter(
    (entry) => Array.isArray(entry?.violations) && entry.violations.length > 0
  );

  if (routes.length === 0) {
    return '';
  }

  const total = routes.reduce((sum, entry) => sum + entry.violations.length, 0);

  const blocks = routes.map((entry) => {
    const items = entry.violations.map((violation) => {
      const nodes = Array.isArray(violation.nodes) ? violation.nodes : [];
      const url = safeUrl(violation.helpUrl);
      const help = escapeText(violation.help ?? '');
      const link = url ? ` ([docs](${url}))` : '';
      const impact = escapeText(violation.impact ?? 'unknown', 20);
      const head = `- **${impact}** ${codeSpan(violation.id, 80)}: ${help}${link}, ${nodes.length} element(s)`;

      const selectors = nodes.slice(0, MAX_SELECTORS_PER_VIOLATION).map((node) => {
        const target = Array.isArray(node?.target) ? node.target.flat(Infinity).join(' ') : node?.target;
        return `  - ${codeSpan(target)}`;
      });
      const extra = nodes.length - MAX_SELECTORS_PER_VIOLATION;
      if (extra > 0) {
        selectors.push(`  - ...and ${extra} more`);
      }

      return [head, ...selectors].join('\n');
    });

    return `### ${codeSpan(entry.route)}\n\n${items.join('\n')}\n`;
  });

  return joinWithinLimit(
    ['## Accessibility violations', '', `axe found ${total} violation(s) on ${routes.length} route(s).`, ''],
    blocks,
    'route(s)'
  );
}

/**
 * @param {unknown} data - the ats-check outputs: { ATS_SCORE, ATS_REPORT, ATS_PASSED }
 * @returns {string} markdown, always non-empty: a passing score is still worth showing
 */
export function formatAts(data) {
  const score = Number(data?.ATS_SCORE);
  const report = typeof data?.ATS_REPORT === 'string' ? data.ATS_REPORT.trim() : '';

  if (!Number.isFinite(score) || !report) {
    throw new Error(
      `ATS data needs a numeric ATS_SCORE and a non-empty ATS_REPORT. Received score ${cleanText(data?.ATS_SCORE, 20)}, report length ${report.length}`
    );
  }

  const passed = String(data.ATS_PASSED) === 'true';
  // ats-check puts its own H1 on the report. Drop it so the comment has one
  // heading, with the verdict in it.
  const body = report.replace(/^# .*\n+/, '');

  return [`## ATS check: ${passed ? 'passed' : 'needs work'} (${score}/100)`, '', body]
    .join('\n')
    .slice(0, MAX_BODY_LENGTH);
}

const FORMATTERS = {
  spellcheck: formatSpellcheck,
  axe: formatAxe,
  ats: formatAts,
};

export const KINDS = Object.keys(FORMATTERS);

/**
 * @param {string} kind - one of {@link KINDS}
 * @param {string} rawData - the checker's JSON output
 * @returns {string} comment body, '' for a clean run
 */
export function formatComment(kind, rawData) {
  const formatter = FORMATTERS[kind];

  if (!formatter) {
    throw new Error(`KIND must be one of ${KINDS.join(', ')}, received "${kind}"`);
  }

  if (!rawData || !rawData.trim()) {
    return '';
  }

  return formatter(parseJson(rawData, kind));
}

export function run(env = process.env) {
  const body = formatComment(env.KIND, env.DATA);
  core.setOutput('BODY', body);
  return body;
}

// Only self-execute as the action entrypoint; importing for tests must not
// touch the environment.
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  try {
    run();
  } catch (e) {
    core.setFailed(`Format Comment failed: ${e.message}`);
  }
}
