# agents.md — ac-composite-actions

Guidelines for AI agents working in this repo. This is a library of reusable GitHub Actions composite actions and reusable workflows, consumed by other repos via `uses: alcash55/ac-composite-actions/<action>@main`.

---

## Repository Layout

```
ac-composite-actions/
├── ats-check/            # Parse resume PDF + score ATS compatibility
├── diff/                 # Get PR diff
├── format-message/       # Format a notification message
├── markdown-checks/
│   └── spellcheck/       # Spellcheck markdown diffs
├── notifications/        # Send GitHub PR comments or Discord webhooks
├── .github/
│   └── workflows/
│       ├── resume-analysis.yml      # Reusable: diff + spellcheck + ATS check + notify
│       ├── accessibility-analysis.yml
│       └── portfolio-message.yml
├── package.json
└── yarn.lock
```

Each top-level directory is one composite action. The directory name is its identifier in `uses:` references.

---

## Composite Action Structure

Every action has an `action.yml`:

```yaml
name: My Action
description: What this action does

inputs:
  MY_INPUT:
    description: What this input is for
    required: true
  OPTIONAL_INPUT:
    required: false
    default: "some-default"

outputs:
  MY_OUTPUT:
    description: What this output contains
    value: ${{ steps.my_step.outputs.MY_OUTPUT }}

runs:
  using: "composite"
  steps:
    - name: Do the thing
      id: my_step          # required on any step that sets outputs
      shell: bash          # always specify explicitly — composite actions have no default
      run: |
        echo "MY_OUTPUT=some-value" >> $GITHUB_OUTPUT
      env:
        MY_INPUT: ${{ inputs.MY_INPUT }}  # pass inputs via env, not inline interpolation
```

### Critical rules

- Always `using: "composite"`.
- Always `shell: bash` on every `run:` step — there is no default shell in composite actions.
- Pass inputs to scripts via `env:` — never interpolate directly into `run:` strings (injection risk).
- Use `echo "KEY=value" >> $GITHUB_OUTPUT` for outputs. Never use the deprecated `::set-output::` syntax.

---

## Multi-line Outputs

For multi-line values (e.g., markdown reports):

```bash
{
  echo "REPORT<<EOF"
  cat report.md
  echo "EOF"
} >> $GITHUB_OUTPUT
```

---

## Reusable Workflows (`workflow_call`)

Workflows consumed by other repos use `workflow_call`:

```yaml
on:
  workflow_call:
    inputs:
      SOME_INPUT:
        required: true
        type: string        # string, boolean, or number only
    secrets:
      MY_SECRET:
        required: true
```

Secrets passed via `workflow_call` must be explicitly forwarded to action steps in `with:` — they are not automatically available as env vars.

---

## Chaining Action Outputs

```yaml
steps:
  - name: Step A
    id: step_a
    uses: alcash55/ac-composite-actions/action-a@main
    with:
      INPUT: ${{ inputs.SOME_INPUT }}

  - name: Step B
    uses: alcash55/ac-composite-actions/action-b@main
    with:
      PREV_OUTPUT: ${{ steps.step_a.outputs.A_OUTPUT }}
```

`id:` is required on any step whose outputs you reference downstream.

---

## Adding a New Action

1. Create `<action-name>/action.yml` following the template above.
2. If the action runs a script, add it under `<action-name>/src/` and call it from the step's `run:`.
3. Update the root `README.md` with inputs, outputs table, and an example usage block.
4. If wiring it into a reusable workflow, add the step in the appropriate `.github/workflows/*.yml`.

### Breaking changes

This repo is consumed at `@main` by other repos — there are no versioned releases. Removing or renaming an input/output is immediately breaking. Prefer additive changes: new optional inputs with defaults, keep old outputs alongside new ones.

---

## Node.js Scripts (`@actions/core`)

For actions with non-trivial logic, use Node.js with `@actions/core`:

```ts
import * as core from "@actions/core";

const myInput = core.getInput("MY_INPUT", { required: true });
core.setOutput("MY_OUTPUT", result);
core.info("Log message");
core.setFailed("Something went wrong"); // exits with failure code
```

Run `yarn` inside the action directory before calling the script in the step.

---

## Common Mistakes

| Mistake | Fix |
|---|---|
| Missing `shell: bash` | Add to every `run:` step |
| Using `::set-output::` | Use `echo "KEY=val" >> $GITHUB_OUTPUT` |
| Secrets not forwarded to called actions | Explicitly wire via `with:` |
| Missing `id:` on a step that sets outputs | Add `id: step_name` |
| Interpolating secrets directly in `run:` | Pass via `env:` on the step |
