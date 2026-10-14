import { describe, it, expect, mock } from 'bun:test';
import { readFileSync } from 'node:fs';

// Same full core shape as the other test files in this package (#21).
const core = {
  notice: mock(() => {}),
  info: mock(() => {}),
  setFailed: mock(() => {}),
  warning: mock(() => {}),
  setOutput: mock(() => {}),
};

mock.module('@actions/core', () => core);

const {
  cleanText,
  codeSpan,
  escapeText,
  safeUrl,
  parseCspellOutput,
  lineUrl,
  formatSpellcheck,
  formatAxe,
  formatAts,
  formatComment,
  run,
  MAX_BODY_LENGTH,
} = await import('./index.js');

describe('codeSpan', () => {
  it('wraps plain text in single backticks', () => {
    expect(codeSpan('docs/a.md')).toBe('`docs/a.md`');
  });

  it('uses a longer fence so a backtick in the text cannot close the span early', () => {
    expect(codeSpan('a`b')).toBe('``a`b``');
    expect(codeSpan('a``b')).toBe('```a``b```');
  });

  it('pads text that starts or ends with a backtick', () => {
    expect(codeSpan('`x')).toBe('`` `x ``');
  });

  it('flattens line breaks so a filename cannot start a new block', () => {
    expect(codeSpan('a\n# heading\r\nb')).toBe('`a # heading b`');
  });

  it('truncates long values', () => {
    expect(codeSpan('x'.repeat(500), 20)).toBe(`\`${'x'.repeat(19)}…\``);
  });
});

describe('escapeText', () => {
  it('escapes markdown and HTML so help text renders literally', () => {
    expect(escapeText('<img src=x onerror=1> *bold* [link](u) | a_b')).toBe(
      '\\<img src=x onerror=1\\> \\*bold\\* \\[link\\](u) \\| a\\_b'
    );
  });

  it('breaks @mentions so the comment cannot ping someone', () => {
    expect(escapeText('@octocat')).toBe('@​octocat');
  });
});

describe('safeUrl', () => {
  it('keeps an https link', () => {
    expect(safeUrl('https://dequeuniversity.com/rules/axe/image-alt')).toBe(
      'https://dequeuniversity.com/rules/axe/image-alt'
    );
  });

  it.each(['javascript:alert(1)', 'http://example.com', 'not a url', undefined])('drops %p', (value) => {
    expect(safeUrl(value)).toBeNull();
  });

  it('percent-encodes characters that would end the markdown link', () => {
    expect(safeUrl('https://example.com/a)b(c')).toBe('https://example.com/a%29b%28c');
  });
});

// Captured from the real spellcheck action script (cspell 10.3.3 with
// --show-suggestions) run over a README with typos. Not hand-written, so a
// cspell format change shows up here first. See the "Suggestions: []" line:
// a nonsense word gets an empty list.
const REAL = JSON.parse(readFileSync(new URL('./cspell-real-output.fixture.json', import.meta.url), 'utf-8'));
const CONTEXT = { repo: 'alcash55/Resume', sha: 'abc1234def' };

describe('parseCspellOutput', () => {
  it('reads words, lines, and the top 3 suggestions from real cspell output', () => {
    expect(parseCspellOutput(REAL[0].output)).toEqual([
      { word: 'recieve', lines: [3, 5], suggestions: ['receive', 'relieve', 'received'] },
      { word: 'seperate', lines: [3], suggestions: ['separate', 'septate', 'serrate'] },
      { word: 'wrod', lines: [3], suggestions: ['word', 'wood', 'Wood'] },
      { word: 'definately', lines: [5], suggestions: ['definitely', 'defiantly', 'definably'] },
      { word: 'xqzvbnmkjhgfdsa', lines: [7], suggestions: [] },
    ]);
  });

  it('still reads a line from cspell run without suggestions', () => {
    expect(parseCspellOutput('a.md:2:4 - Unknown word (wrod)\nCSpell: Files checked: 1')).toEqual([
      { word: 'wrod', lines: [2], suggestions: [] },
    ]);
  });

  it('returns nothing for text it does not recognise', () => {
    expect(parseCspellOutput('something else entirely')).toEqual([]);
  });
});

describe('lineUrl', () => {
  it('links to the line at the commit', () => {
    expect(lineUrl(CONTEXT, 'docs/a.md', 12)).toBe('https://github.com/alcash55/Resume/blob/abc1234def/docs/a.md#L12');
  });

  it('encodes characters in a filename that could end the markdown link or the URL', () => {
    expect(lineUrl(CONTEXT, 'a b/(x)[1]#?.md', 3)).toBe(
      'https://github.com/alcash55/Resume/blob/abc1234def/a%20b/%28x%29%5B1%5D%23%3F.md#L3'
    );
  });

  it.each([
    ['no repo', { sha: 'abc1234def' }, 'a.md'],
    ['no sha', { repo: 'a/b' }, 'a.md'],
    ['a repo with a path in it', { repo: 'a/b/../c', sha: 'abc1234def' }, 'a.md'],
    ['a sha that is not hex', { repo: 'a/b', sha: 'main' }, 'a.md'],
    ['a rendered-mode route', CONTEXT, '/about'],
    ['a path that climbs out', CONTEXT, 'docs/../../x.md'],
  ])('returns null for %s', (_name, context, file) => {
    expect(lineUrl(context, file, 1)).toBeNull();
  });
});

describe('formatSpellcheck', () => {
  const link = (line) => `[\`README.md:${line}\`](https://github.com/alcash55/Resume/blob/abc1234def/README.md#L${line})`;

  it('renders real cspell output as one entry per word with suggestions and file:line links', () => {
    expect(formatSpellcheck(REAL, CONTEXT)).toBe(
      [
        '## Spelling errors',
        '',
        'Found 5 misspelled word(s) in 1 file(s). Fix them or add real terms to the project dictionary.',
        '',
        `- \`recieve\` → \`receive\`, \`relieve\`, \`received\`: ${link(3)}, ${link(5)}`,
        `- \`seperate\` → \`separate\`, \`septate\`, \`serrate\`: ${link(3)}`,
        `- \`wrod\` → \`word\`, \`wood\`, \`Wood\`: ${link(3)}`,
        `- \`definately\` → \`definitely\`, \`defiantly\`, \`definably\`: ${link(5)}`,
        `- \`xqzvbnmkjhgfdsa\`: ${link(7)}`,
      ].join('\n')
    );
  });

  it('shows plain file:line text, no link, when the repo or commit is missing', () => {
    const body = formatSpellcheck([{ file: 'README.md', output: 'README.md:3:3 - Unknown word (wrod) Suggestions: [word*]' }]);

    expect(body).toContain('- `wrod` → `word`: `README.md:3`');
    expect(body).not.toContain('](');
  });

  it('returns an empty body when the run is clean', () => {
    expect(formatSpellcheck([], CONTEXT)).toBe('');
  });

  it('names each file in its own entries when several files have typos', () => {
    const body = formatSpellcheck(
      [
        { file: 'a.md', output: 'a.md:1:1 - Unknown word (aa) Suggestions: []' },
        { file: 'b.md', output: 'b.md:2:1 - Unknown word (bb) Suggestions: []' },
      ],
      CONTEXT
    );

    expect(body).toContain('[`a.md:1`](https://github.com/alcash55/Resume/blob/abc1234def/a.md#L1)');
    expect(body).toContain('[`b.md:2`](https://github.com/alcash55/Resume/blob/abc1234def/b.md#L2)');
  });

  it('keeps a hostile filename inside its code span and its URL', () => {
    const body = formatSpellcheck(
      [{ file: 'x`](evil)<!-- m -->.md', output: 'x:4:1 - Unknown word (a)' }],
      CONTEXT
    );

    // The label is a code span with a fence longer than the backtick inside it.
    expect(body).toContain('[``x`](evil)<!-- m -->.md:4``](https://github.com/');
    // In the URL the brackets, parens, angle brackets, and spaces are percent-encoded.
    expect(body).toContain('/blob/abc1234def/x%60%5D%28evil%29%3C%21--%20m%20--%3E.md#L4)');
    expect(body.startsWith('## Spelling errors')).toBe(true);
  });

  it('drops the link, keeps the text, for a filename with an empty path segment', () => {
    const body = formatSpellcheck([{ file: 'a//b.md', output: 'x:4:1 - Unknown word (a)' }], CONTEXT);

    expect(body).toContain('- `a`: `a//b.md:4`');
  });

  it('falls back to the raw cspell text when it cannot parse it', () => {
    const body = formatSpellcheck([{ file: 'a.md', output: 'cspell changed its format' }], CONTEXT);

    expect(body).toContain('```text\ncspell changed its format\n```');
  });

  it('truncates under the GitHub size limit and says how many entries were dropped', () => {
    const many = Array.from({ length: 4000 }, (_, i) => ({
      file: `docs/file-${i}.md`,
      output: `f:1:1 - Unknown word (word${i}) Suggestions: [a*, b, c]`,
    }));

    const body = formatSpellcheck(many, CONTEXT);

    expect(body.length).toBeLessThanOrEqual(MAX_BODY_LENGTH);
    expect(body).toMatch(/_\d+ more misspelling\(s\) not shown/);
  });
});

describe('formatAxe', () => {
  const violation = {
    id: 'image-alt',
    impact: 'critical',
    help: 'Images must have alternate text',
    helpUrl: 'https://dequeuniversity.com/rules/axe/image-alt',
    nodes: [{ target: ['img.hero'] }, { target: ['#a', '.b'] }, { target: [['iframe', 'img']] }, { target: ['img.four'] }],
  };

  it('shows rule, impact, count, help link, and the first selectors per route', () => {
    expect(formatAxe([{ route: '/about', violations: [violation] }, { route: '/', violations: [] }])).toBe(
      [
        '## Accessibility violations',
        '',
        'axe found 1 violation(s) on 1 route(s).',
        '',
        '### `/about`',
        '',
        '- **critical** `image-alt`: Images must have alternate text ([docs](https://dequeuniversity.com/rules/axe/image-alt)), 4 element(s)',
        '  - `img.hero`',
        '  - `#a .b`',
        '  - `iframe img`',
        '  - ...and 1 more',
        '',
      ].join('\n')
    );
  });

  it('returns an empty body when no route has violations', () => {
    expect(formatAxe([{ route: '/', violations: [] }])).toBe('');
    expect(formatAxe([])).toBe('');
  });

  it('escapes help text and drops a non-https help link', () => {
    const body = formatAxe([
      {
        route: '/',
        violations: [{ id: 'x', impact: null, help: '<script>@bob', helpUrl: 'javascript:alert(1)', nodes: [] }],
      },
    ]);

    expect(body).toContain('**unknown** `x`: \\<script\\>@​bob, 0 element(s)');
    expect(body).not.toContain('javascript:');
    expect(body).not.toContain('<script>');
  });
});

describe('formatAts', () => {
  const report =
    '# ATS Compatibility Report ✅ PASSED\n\n**Overall Score: 85/100**\n\n## Score Breakdown\n\n| Category | Score |\n|---|---|\n| Skills | 15/15 |\n\n_Passing threshold: 70/100_';

  it('puts the verdict and score in one heading and keeps the rest of the report', () => {
    expect(formatAts({ ATS_SCORE: '85', ATS_PASSED: 'true', ATS_REPORT: report })).toBe(
      '## ATS check: passed (85/100)\n\n## Score Breakdown\n\n| Category | Score |\n|---|---|\n| Skills | 15/15 |\n\n_Passing threshold: 70/100_'
    );
  });

  it('shows the score once, not again in an Overall Score line', () => {
    const body = formatAts({ ATS_SCORE: '50', ATS_PASSED: 'false', ATS_REPORT: report.replace(/85/g, '50') });

    expect(body).toContain('## ATS check: needs work (50/100)');
    expect(body).not.toContain('Overall Score');
    expect(body.match(/50\/100/g)).toHaveLength(1);
  });

  it('names what was wrong when the data is unusable', () => {
    expect(() => formatAts({ ATS_SCORE: 'abc', ATS_REPORT: '' })).toThrow(
      'ATS data needs a numeric ATS_SCORE and a non-empty ATS_REPORT. Received score abc, report length 0'
    );
  });
});

describe('formatComment', () => {
  it('rejects an unknown kind and lists the valid ones', () => {
    expect(() => formatComment('nope', '[]')).toThrow('KIND must be one of spellcheck, axe, ats, received "nope"');
  });

  it('treats empty data as a clean run', () => {
    expect(formatComment('spellcheck', '')).toBe('');
  });

  it('names the kind and the input when the JSON is bad', () => {
    expect(() => formatComment('axe', '{oops')).toThrow(/DATA for axe was not valid JSON .* Received: \{oops/);
  });
});

describe('run', () => {
  it('writes the body to the BODY output', () => {
    const body = run({ KIND: 'spellcheck', DATA: JSON.stringify([{ file: 'a.md', output: 'a:1:1 - Unknown word (zz)' }]) });

    expect(core.setOutput).toHaveBeenCalledWith('BODY', body);
    expect(body).toContain('`zz`');
  });
});

describe('cleanText', () => {
  it('strips control characters', () => {
    expect(cleanText('a\u0000b\u001bc')).toBe('a b c');
  });
});
