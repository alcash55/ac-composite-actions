import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

// The wiring lives in action.yml, so a wrong gate or a lost input only shows up on a
// live PR. These read the file as text, which needs no YAML parser in this package.
const action = readFileSync(new URL('./action.yml', import.meta.url), 'utf-8');

/** The `if:` line of the step named `name`. */
function stepGate(name) {
  const at = action.indexOf(`- name: ${name}`);
  expect(at, `step "${name}" is missing`).toBeGreaterThan(-1);
  const rest = action.slice(at);
  const gate = rest.match(/\n\s+if: (.+)/);
  return gate ? gate[1] : '';
}

describe('pr-comment action.yml', () => {
  it('comments on a pull request event', () => {
    expect(stepGate('Format PR comment')).toContain("github.event_name == 'pull_request'");
  });

  it('comments from a workflow_run reporter when the caller names the pull request', () => {
    // A reporter runs outside the PR event. Its PR number comes from a verified artifact.
    expect(stepGate('Format PR comment')).toContain("inputs.PR_NUMBER != ''");
  });

  it('still honors the COMMENT_ON_PR opt-out for both paths', () => {
    expect(stepGate('Format PR comment')).toMatch(/^\$\{\{ inputs\.COMMENT_ON_PR == 'true' &&/);
  });

  it('declares FAIL_ON_ERROR, off by default, and hands it to the upsert script', () => {
    expect(action).toMatch(/\n {2}FAIL_ON_ERROR:\n(?:.*\n)*? {4}default: "false"/);
    expect(action).toContain('FAIL_ON_ERROR: ${{ inputs.FAIL_ON_ERROR }}');
  });

  it('lets the upsert step fail the job only when FAIL_ON_ERROR is true', () => {
    const upsert = action.slice(action.indexOf('- name: Upsert PR comment'));
    expect(upsert).toContain("continue-on-error: ${{ inputs.FAIL_ON_ERROR != 'true' }}");
  });
});
