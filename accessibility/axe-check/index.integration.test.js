// Real Chromium and the real @axe-core/playwright, unlike index.test.js's
// mocked runAxeSelfDriven tests. Those mocks proved the call plumbing but not
// that a page from a browser.newPage()-style context actually satisfies
// AxeBuilder.analyze(). The regression in issue #27 only surfaced against
// the real package, where analyze() opens its own blank page via
// page.context().newPage(), and Playwright refuses that on an owned,
// single-page context ("Please use browser.newContext()"). This file guards
// against that regression coming back.
//
// Skipped in CI: ci.yml never installs a browser for this action's test job
// (its own header says the suite should never hit anything real), so
// Chromium is not available there. Run this locally with
// `npx playwright install chromium` done once, via `yarn test`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'http';
import { runAxeSelfDriven } from './index.js';

const FIXTURE_HTML = `<!doctype html>
<html>
  <head><title>axe-check fixture</title></head>
  <body>
    <img src="missing-alt.png">
    <h1>axe-check fixture page</h1>
  </body>
</html>`;

describe.skipIf(process.env.CI)('runAxeSelfDriven (real browser)', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('drives a real page and reports the fixture violation without throwing', async () => {
    const entries = await runAxeSelfDriven(baseUrl, ['/'], ['wcag2a', 'wcag2aa']);

    expect(entries).toHaveLength(1);
    expect(entries[0].route).toBe('/');
    expect(entries[0].violations.some((v) => v.id === 'image-alt')).toBe(true);
  }, 30000);
});
