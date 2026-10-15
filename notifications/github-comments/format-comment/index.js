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

const CSPELL_LINE = /^.*?:(\d+):\d+\s+-\s+(?:Unknown|Forbidden) word \((.+?)\)(?:\s+Suggestions: \[(.*)\])?\s*$/;

const MAX_SUGGESTIONS = 3;

/**
 * Pulls { word, lines, suggestions } out of raw `cspell lint --show-suggestions`
 * output. cspell prints
 * `path:line:col - Unknown word (word) Suggestions: [best*, second, third]`;
 * the `*` marks its preferred fix. A word with no suggestions has no
 * `Suggestions:` part. Anything else (summary lines, a future format change)
 * is ignored here and handled by the caller.
 * @param {string} output
 * @returns {{ word: string, lines: number[], suggestions: string[] }[]} unique words in first-seen order
 */
export function parseCspellOutput(output) {
  const byWord = new Map();

  for (const rawLine of String(output ?? '').split('\n')) {
    const match = CSPELL_LINE.exec(rawLine.trim());
    if (!match) {
      continue;
    }
    const [, line, word, rawSuggestions] = match;
    const entry = byWord.get(word) ?? { word, lines: [], suggestions: [] };
    entry.lines.push(Number(line));
    if (entry.suggestions.length === 0 && rawSuggestions) {
      entry.suggestions = rawSuggestions
        .split(',')
        .map((suggestion) => suggestion.trim().replace(/\*$/, ''))
        .filter(Boolean)
        .slice(0, MAX_SUGGESTIONS);
    }
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

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;
const MAX_LINKS_PER_WORD = 5;

/**
 * Builds a link to a line of a file at a commit, or null when it cannot be
 * made safely. A filename is PR content, so each path segment is
 * percent-encoded (including the characters encodeURIComponent leaves alone
 * that would end a markdown link), and a path that could climb out of the
 * blob URL or that is not a repo path (a rendered-mode route) gets no link.
 * @param {{ repo?: string, sha?: string }} context
 * @param {string} file - repo-relative path
 * @param {number} line
 * @returns {string | null}
 */
export function lineUrl({ repo, sha } = {}, file, line) {
  if (!REPO_PATTERN.test(repo ?? '') || !SHA_PATTERN.test(sha ?? '')) {
    return null;
  }

  const path = String(file ?? '');
  const segments = path.split('/');
  if (!path || path.startsWith('/') || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }

  const encoded = segments
    .map((segment) =>
      encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    )
    .join('/');

  return `https://github.com/${repo}/blob/${sha}/${encoded}#L${Number(line)}`;
}

/**
 * @param {unknown} data - SPELL_ERRORS: array of { file, output }
 * @param {{ repo?: string, sha?: string }} [context] - where file:line links point; none means plain text
 * @returns {string} markdown, '' when there are no spelling errors
 */
export function formatSpellcheck(data, context = {}) {
  if (!Array.isArray(data) || data.length === 0) {
    return '';
  }

  // One entry per word per file, each naming its own file and line. A flat
  // list reads better than a heading per file, since most files have one or
  // two typos and every entry stays self-contained when someone quotes it.
  const blocks = [];
  let wordCount = 0;

  for (const { file, output } of data) {
    const words = parseCspellOutput(output);

    if (words.length === 0) {
      // Format we do not recognise: show cspell's own text rather than nothing.
      const raw = String(output ?? '').trim().slice(0, 1000).replace(/`{3,}/g, '` ` `');
      blocks.push(`- ${codeSpan(file)}:\n\n\`\`\`text\n${raw}\n\`\`\`\n`);
      continue;
    }

    for (const { word, lines, suggestions } of words) {
      wordCount += 1;
      const places = lines.slice(0, MAX_LINKS_PER_WORD).map((line) => {
        const label = codeSpan(`${file}:${line}`);
        const url = lineUrl(context, file, line);
        return url ? `[${label}](${url})` : label;
      });
      const more = lines.length > MAX_LINKS_PER_WORD ? `, ...and ${lines.length - MAX_LINKS_PER_WORD} more` : '';
      const fix = suggestions.length ? ` → ${suggestions.map((s) => codeSpan(s, 80)).join(', ')}` : '';
      blocks.push(`- ${codeSpan(word, 80)}${fix}: ${places.join(', ')}${more}`);
    }
  }

  return joinWithinLimit(
    [
      '## Spelling errors',
      '',
      `Found ${wordCount || 'some'} misspelled word(s) in ${data.length} file(s). Fix them or add real terms to the project dictionary.`,
      '',
    ],
    blocks,
    'misspelling(s)'
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
 * @param {unknown} data - the ats-check outputs: { ATS_SCORE, ATS_REPORT, ATS_PASSED, ATS_RESUME }
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
  // The heading above already carries the score, so drop the report's own
  // "Overall Score" line. ats-check's log and report output keep it.
  const body = report.replace(/^# .*\n+/, '').replace(/^\*\*Overall Score: .*\*\*\n+/m, '');

  // Name the resume: one PR can carry several ATS comments, one per PDF.
  const resume = cleanText(data.ATS_RESUME, 100);
  const subject = resume ? ` (${escapeText(resume, 100)})` : '';

  return [`## ATS check${subject}: ${passed ? 'passed' : 'needs work'} (${score}/100)`, '', body]
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
 * @param {{ repo?: string, sha?: string }} [context] - for file:line links
 * @returns {string} comment body, '' for a clean run
 */
export function formatComment(kind, rawData, context = {}) {
  const formatter = FORMATTERS[kind];

  if (!formatter) {
    throw new Error(`KIND must be one of ${KINDS.join(', ')}, received "${kind}"`);
  }

  if (!rawData || !rawData.trim()) {
    return '';
  }

  return formatter(parseJson(rawData, kind), context);
}

export function run(env = process.env) {
  const body = formatComment(env.KIND, env.DATA, { repo: env.REPO, sha: env.SHA });
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
