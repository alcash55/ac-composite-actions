import { describe, it, expect, mock } from 'bun:test';

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

describe('parseCspellOutput', () => {
  it('extracts each unique word with its line numbers', () => {
    const output = [
      '/tmp/x.md:3:5 - Unknown word (wrod)',
      '/tmp/x.md:9:1 - Unknown word (teh)',
      '/tmp/x.md:12:7 - Unknown word (wrod)',
      'CSpell: Files checked: 1, Issues found: 3 in 1 file.',
    ].join('\n');

    expect(parseCspellOutput(output)).toEqual([
      { word: 'wrod', lines: [3, 12] },
      { word: 'teh', lines: [9] },
    ]);
  });

  it('returns nothing for text it does not recognise', () => {
    expect(parseCspellOutput('something else entirely')).toEqual([]);
  });
});

describe('formatSpellcheck', () => {
  const data = [
    { file: 'docs/a.md', output: 'docs/a.md:3:5 - Unknown word (wrod)\ndocs/a.md:4:1 - Unknown word (teh)\n' },
    { file: 'README.md', output: 'README.md:1:1 - Unknown word (recieve)\n' },
  ];

  it('lists every misspelled word under its file', () => {
    expect(formatSpellcheck(data)).toBe(
      [
        '## Spelling errors',
        '',
        'Found misspelled words in 2 file(s). Fix them or add real terms to the project dictionary.',
        '',
        '### `docs/a.md`',
        '',
        '- `wrod` (line 3)',
        '- `teh` (line 4)',
        '',
        '### `README.md`',
        '',
        '- `recieve` (line 1)',
        '',
      ].join('\n')
    );
  });

  it('returns an empty body when the run is clean', () => {
    expect(formatSpellcheck([])).toBe('');
  });

  it('keeps a hostile filename inside its code span', () => {
    const body = formatSpellcheck([
      { file: 'x`\n<!-- ac-composite-actions:axe -->.md', output: 'x:1:1 - Unknown word (a)' },
    ]);

    expect(body).toContain('### ``x` <!-- ac-composite-actions:axe -->.md``');
    expect(body.startsWith('## Spelling errors')).toBe(true);
  });

  it('falls back to the raw cspell text when it cannot parse it', () => {
    const body = formatSpellcheck([{ file: 'a.md', output: 'cspell changed its format' }]);

    expect(body).toContain('```text\ncspell changed its format\n```');
  });

  it('truncates under the GitHub size limit and says how many files were dropped', () => {
    const many = Array.from({ length: 4000 }, (_, i) => ({
      file: `docs/file-${i}.md`,
      output: `f:1:1 - Unknown word (word${i})`,
    }));

    const body = formatSpellcheck(many);

    expect(body.length).toBeLessThanOrEqual(MAX_BODY_LENGTH);
    expect(body).toMatch(/_\d+ more file\(s\) not shown/);
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
  const report = '# ATS Compatibility Report ✅ PASSED\n\n**Overall Score: 85/100**\n\n## Score Breakdown\n';

  it('puts the verdict and score in one heading and keeps the report body', () => {
    expect(formatAts({ ATS_SCORE: '85', ATS_PASSED: 'true', ATS_REPORT: report })).toBe(
      '## ATS check: passed (85/100)\n\n**Overall Score: 85/100**\n\n## Score Breakdown'
    );
  });

  it('reports a failing score', () => {
    expect(formatAts({ ATS_SCORE: '40', ATS_PASSED: 'false', ATS_REPORT: report })).toContain(
      '## ATS check: needs work (40/100)'
    );
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
