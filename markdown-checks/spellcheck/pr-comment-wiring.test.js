import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { parse } from "yaml";

// The PR comment is wired in action.yml, not in index.js, so a typo in the
// wiring (wrong KIND, a step id that does not exist, commenting that cannot be
// turned off) would only show up on a live PR. Pin the wiring here.
const doc = parse(readFileSync(new URL("./action.yml", import.meta.url), "utf-8"));
const steps = doc.runs.steps;
const commentStep = steps.find((step) => step.id === "comment");

describe("action.yml PR comment wiring", () => {
  it("delegates to notifications/pr-comment with KIND spellcheck", () => {
    expect(commentStep?.uses, "no step with id 'comment' that uses a pr-comment action").toBe(
      "alcash55/ac-composite-actions/notifications/pr-comment@main",
    );
    expect(commentStep.with.KIND).toBe("spellcheck");
  });

  it("feeds it the output of the check step, and only runs after that step succeeded", () => {
    const checkStep = steps.find((step) => step.id === "spellcheck");

    expect(checkStep, "check step 'spellcheck' is missing").toBeDefined();
    expect(commentStep.with.DATA).toContain("steps.spellcheck.outputs");
    expect(commentStep.if).toContain("steps.spellcheck.outcome == 'success'");
  });

  it("can be turned off, and is on by default", () => {
    expect(doc.inputs.COMMENT_ON_PR.default).toBe("true");
    expect(commentStep.with.COMMENT_ON_PR).toBe("${{ inputs.COMMENT_ON_PR }}");
  });

  it("forwards every input pr-comment needs to find the PR", () => {
    for (const name of ["GH_TOKEN", "GITHUB_ORG", "PR_NUMBER"]) {
      expect(doc.inputs[name], `action.yml does not declare input ${name}`).toBeDefined();
      expect(commentStep.with[name]).toBe(`\${{ inputs.${name} }}`);
    }
  });
});
