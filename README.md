# AC-Composite Actions

Reusable GitHub Actions composite actions and workflows, shared across my other repos.

Everything here is consumed at `@main` — there are no tagged releases, so a change to an
action takes effect immediately for every repo that uses it.

```yaml
- uses: alcash55/ac-composite-actions/<action>@main
```

## Actions at a glance

| Action | Status | What it does |
|---|---|---|
| [`diff`](#diff) | ✅ Ready | Lists the files changed in a pull request |
| [`ats-check`](#ats-check) | ✅ Ready | Scores a resume PDF for ATS compatibility |
| [`markdown-checks/spellcheck`](#markdown-checksspellcheck) | ✅ Ready | Spellchecks changed markdown with cspell |
| [`accessibility/axe-check`](#accessibilityaxe-check) | ✅ Ready | Runs @axe-core/playwright's WCAG 2 A/AA ruleset |
| [`notifications`](#notifications) | ✅ Ready | Posts a PR comment or Discord message |
| [`notifications/discord-messages`](#notificationsdiscord-messages) | ✅ Ready | Sends a Discord webhook message |
| [`format-message`](#format-message) | ✅ Ready | Formats a spellcheck result into a comment body |

---

## `diff`

Lists every file added, modified, or renamed in a pull request, split into files that can be
processed downstream and files whose names are rejected. Deleted files are excluded so later
steps never try to read a path that no longer exists.

Results are paginated, so pull requests with more than 30 changed files are handled correctly.

### Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `PR_NUMBER` | ✅ | — | The number that identifies the pull request |
| `GITHUB_ORG` | ✅ | — | `<owner>/<repo>` |
| `GH_TOKEN` | ✅ | — | Token for the actor triggering the workflow |
| `FILE_EXTENSIONS` | — | `md,mdx` | Comma delimited extensions to keep in `DIFF` |

### Outputs

| Output | Description |
|---|---|
| `DIFF` | Space delimited list of changed files matching `FILE_EXTENSIONS` |
| `ALL_FILES` | Space delimited list of every added/modified/renamed file |
| `ERROR_FILES` | Markdown report of files rejected for invalid names — empty when there are none |
| `HAS_CHANGES` | `"true"` when `DIFF` is non-empty, otherwise `"false"` |

All four outputs are always set, including on an empty pull request. Gate later steps on
`HAS_CHANGES` rather than testing `DIFF` for emptiness.

### File name rules

A file whose path contains whitespace anywhere — including in a parent directory — is reported
in `ERROR_FILES` and kept out of `DIFF`. Downstream actions receive `DIFF` as a space delimited
list, so a path containing a space would silently split into two bad paths. Invalid names are a
warning, not a failure: the step still succeeds and the remaining files are processed.

### Example usage

```yaml
- name: 🔍 Get Diff
  id: diff
  uses: alcash55/ac-composite-actions/diff@main
  with:
    PR_NUMBER: ${{ github.event.pull_request.number }}
    GITHUB_ORG: ${{ github.repository }}
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

- name: Do something with the changed markdown
  if: steps.diff.outputs.HAS_CHANGES == 'true'
  shell: bash
  run: echo "${{ steps.diff.outputs.DIFF }}"
```

To collect something other than markdown, set `FILE_EXTENSIONS`:

```yaml
- uses: alcash55/ac-composite-actions/diff@main
  with:
    PR_NUMBER: ${{ github.event.pull_request.number }}
    GITHUB_ORG: ${{ github.repository }}
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    FILE_EXTENSIONS: ts,tsx
```

### Tests

```bash
cd diff
yarn
yarn test
```

---

## `ats-check`

Parses a resume PDF and scores its ATS (Applicant Tracking System) compatibility using the
[APILayer Resume Parser API](https://apilayer.com/marketplace/resume_parser-api).

### Inputs

| Input | Required | Description |
|---|---|---|
| `RESUME` | ✅ | Path to the resume PDF, relative to the repo root |
| `APILAYER_API_KEY` | ✅ | APILayer Resume Parser API key |

### Outputs

| Output | Description |
|---|---|
| `ATS_SCORE` | Overall ATS compatibility score (0–100) |
| `ATS_REPORT` | Detailed markdown report with score breakdown and recommendations |
| `ATS_PASSED` | `"true"` if the score is 70 or above, `"false"` otherwise |

### Scoring rubric

| Category | Points |
|---|---|
| Contact info (name, email, phone) | 15 |
| Work experience section | 20 |
| Education section | 15 |
| Skills section | 15 |
| Plain-text / parseable (no image-based content) | 10 |
| Date ranges on experience entries | 10 |
| Job titles on experience entries | 10 |
| Summary / objective section | 5 |

### Example usage

```yaml
- name: 🖨️ ATS Check
  id: ats_check
  uses: alcash55/ac-composite-actions/ats-check@main
  with:
    RESUME: resumes/my-resume.pdf
    APILAYER_API_KEY: ${{ secrets.APILAYER_API_KEY }}
```

> **Setup:** add your APILayer key as a repository secret named `APILAYER_API_KEY`. A free key is
> available at [apilayer.com](https://apilayer.com/marketplace/resume_parser-api).

### Tests

```bash
cd ats-check
yarn
yarn test
```

Covers `scoreResume` and `buildMarkdownReport` (pure functions) plus the `action.yml` output
contract. `parseResume` and the top-level script are not exercised here — they need a live call to
the resume parser API, which has no place in a unit suite.

---

## `markdown-checks/spellcheck`

Runs [cspell](https://cspell.org/) in one of two modes, selected by `SPELLCHECK_MODE`:

- **`source`** (default) — checks files in the checkout. With `DIFF` set, this is the original
  behaviour: one cspell run per file in `DIFF`, read straight off disk and falling back to the
  GitHub API only when a file isn't there (e.g. `BRANCH` names a ref other than the one the
  calling workflow checked out). With `DIFF` empty, it globs the whole checkout (via `git
  ls-files`, so `.gitignore`d paths are excluded) by `EXTENSIONS` instead — for a run with no PR
  context, e.g. scheduled.
- **`rendered`** — checks visible text scraped from a *running* site: `document.body.innerText`,
  the `<meta name="description">` content, and every `alt`/`aria-label`/`title` attribute, per
  route. On a React project this is the text a markdown glob never sees at all — hero copy,
  button labels, `alt` text. Less noisy than `source` too, since markup and identifiers are
  already excluded. Reads from either:
  - `RENDERED_CONTENT_PATH` — a JSON file a consumer's own e2e job already scraped (preferred when
    the consumer already runs Playwright, e.g. against a `vite preview` build — this way the
    browser is never installed twice), or
  - `BASE_URL` + `ROUTES` — the action drives its own browser instead, for a consumer with no e2e
    infrastructure of its own. Only this path installs a browser (`npx playwright install`,
    conditional on `SPELLCHECK_MODE == 'rendered'` with no `RENDERED_CONTENT_PATH`); every other
    combination skips it.

Project-specific words go in the *consumer's own* cspell config, passed via `DICTIONARY` — see
below. `markdown-checks/.cspell.json` is only the shared baseline (generic tool names); it does
not carry any one project's proper nouns.

### Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `SPELLCHECK_MODE` | — | `source` | `source` or `rendered` |
| `DIFF` | — | `""` | Space delimited files to check (`source` mode) — pair with the `diff` action's `DIFF` output. Empty means glob the whole checkout instead. |
| `EXTENSIONS` | — | `ts,tsx,html,md,mdx,json` | Comma delimited extensions to glob when `source` mode has no `DIFF` |
| `BRANCH` | — | `""` | Ref to read from (`source` mode with `DIFF`) |
| `GITHUB_ORG` | — | `""` | `<owner>/<repo>` (`source` mode with `DIFF`) |
| `GH_TOKEN` | — | `""` | Token for the actor triggering the workflow (`source` mode with `DIFF`) |
| `ROUTES` | — | `""` | Space delimited routes to check (`rendered` mode, with `BASE_URL`) |
| `BASE_URL` | — | `""` | Base URL of a running site (`rendered` mode, self-driven browser) |
| `RENDERED_CONTENT_PATH` | — | `""` | Path to pre-extracted `[{ route, innerText, description, labels }]` JSON (`rendered` mode, no browser needed) |
| `DICTIONARY` | — | `""` | Path to a consumer-owned cspell config, merged with the shared baseline via cspell's own `import` |

`DIFF`, `BRANCH`, `GITHUB_ORG`, and `GH_TOKEN` keep their original names and meaning — an existing
caller that sets all four and nothing else sees identical behaviour to before `SPELLCHECK_MODE`
and the other inputs existed.

### Outputs

| Output | Description |
|---|---|
| `SPELL_ERRORS` | JSON array of `{ file, output }` entries, one per file (or route, in `rendered` mode) with spelling issues. Always set, `"[]"` when there are none. |

### Tests

```bash
cd markdown-checks/spellcheck
yarn
yarn test
```

Includes a real (unmocked) run of the cspell binary against `.cspell.json` to confirm its
dictionary genuinely applies — and that a consumer-supplied `DICTIONARY` file merges in rather
than replacing it — alongside mocked unit tests for everything else, including a mocked
`playwright` for the self-driven rendered path.

---

## `accessibility/axe-check`

Runs [`@axe-core/playwright`](https://www.npmjs.com/package/@axe-core/playwright)'s WCAG 2 A/AA
ruleset, reading violations from either:

- `RESULTS_PATH` — a JSON file a consumer's own e2e job already computed (preferred when the
  consumer already runs `@axe-core/playwright` itself, e.g. against a `vite preview` build under
  its own Playwright suite — this way the browser is never installed twice), or
- `BASE_URL` + `ROUTES` — the action drives its own browser instead, for a consumer with no e2e
  infrastructure of its own. Only this path installs a browser (`npx playwright install`,
  conditional on `RESULTS_PATH` being unset); the other path skips it entirely.

Unlike `markdown-checks/spellcheck`, this action does not fail its own step on a violation — it
only reports `AXE_VIOLATIONS`. Whether that fails a job is a caller decision:
[`accessibility-analysis.yml`](#accessibility-analysisyml), the reusable workflow that wraps this
action, does gate on it, because a11y violations are a defect the check exists to catch, not a
style nit like a typo.

### Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `RESULTS_PATH` | — | `""` | Path to pre-computed `[{ route, violations }]` JSON (`violations` is exactly `AxeBuilder(...).analyze().violations`) — skips owning a browser |
| `ROUTES` | — | `""` | Space delimited routes to check (self-driven mode, with `BASE_URL`) |
| `BASE_URL` | — | `""` | Base URL of a running, reachable site (self-driven mode) |
| `TAGS` | — | `wcag2a,wcag2aa` | Comma delimited axe rule tags for self-driven mode |

### Outputs

| Output | Description |
|---|---|
| `AXE_VIOLATIONS` | JSON array of `{ route, violations }` entries, one per route checked. Always set, `"[]"` when every route is clean. |

### Example usage — consumer with no e2e infrastructure

```yaml
- uses: alcash55/ac-composite-actions/accessibility/axe-check@main
  with:
    BASE_URL: https://staging.example.com
    ROUTES: "/ /about /contact"
```

### Example usage — consumer that already runs `@axe-core/playwright`

A repo like Portfolio, whose own Playwright suite already runs `AxeBuilder` per route/theme and
asserts inline, would add one step after its e2e run that serializes what it already computed:

```yaml
- name: ♿ Axe Accessibility Check
  uses: alcash55/ac-composite-actions/accessibility/axe-check@main
  with:
    RESULTS_PATH: axe-results.json
```

### Tests

```bash
cd accessibility/axe-check
yarn
yarn test
```

Mocked unit tests, including a mocked `playwright` and `@axe-core/playwright` for the self-driven
path — the same pattern `markdown-checks/spellcheck` uses for its own self-driven rendered mode.

---

## `notifications`

One entry point for both PR comments and Discord messages, switching on `MESSAGE_TYPE`. For
`github`, it first deletes the previous run's bot comment (matched by heading — see
`github-comments/delete-comment`), then posts `MESSAGE` as a new comment, skipping the post when
`MESSAGE` is empty. For `discord`, it delegates to
[`notifications/discord-messages`](#notificationsdiscord-messages).

### Inputs

| Input | Required | Description |
|---|---|---|
| `MESSAGE` | ✅ | Message to send |
| `MESSAGE_TYPE` | ✅ | `github` or `discord` |
| `GITHUB_ORG` | — | `<owner>/<repo>` — required when `MESSAGE_TYPE` is `github` |
| `PR_NUMBER` | — | Pull request number — required when `MESSAGE_TYPE` is `github` |
| `GH_TOKEN` | — | Token — required when `MESSAGE_TYPE` is `github` |
| `WEBHOOK_URL` | — | Discord webhook URL — required when `MESSAGE_TYPE` is `discord` |

### Tests

```bash
cd notifications
bun install
bun test
```

---

## `notifications/discord-messages`

Sends a message to a Discord channel through a webhook.

### Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `WEBHOOK_URL` | ✅ | — | Discord webhook URL |
| `MESSAGE` | ✅ | — | Message to send |
| `USERNAME` | — | `GitHub Actions` | Name the message is posted under |
| `AVATAR_URL` | — | — | Avatar shown next to the message |

### Example usage

```yaml
- name: 📩 Send Discord Message
  uses: alcash55/ac-composite-actions/notifications/discord-messages@main
  with:
    WEBHOOK_URL: ${{ secrets.WEBHOOK_URL }}
    MESSAGE: "Deploy finished"
```

---

## `format-message`

Turns the `SPELL_ERRORS` JSON from `markdown-checks/spellcheck` into a `# Spell Check` markdown PR
comment, one section per file. Falls back to a `# Too many errors to show full message, fix errors
to show fill issue list` heading with just the file list when the full body would exceed GitHub's
65536 character comment limit.

| Input | Required | Description |
|---|---|---|
| `SPELL_MESSAGE` | ✅ | Unformatted spellcheck output (JSON array of `{ file, output }`) |

| Output | Description |
|---|---|
| `FORMATTED_MESSAGE` | Formatted message for the target channel, empty string when there's nothing to report |

### Tests

```bash
cd format-message
yarn
yarn test
```

---

## Reusable workflows

Called with `uses:` at the job level rather than the step level.

### `resume-analysis.yml`

Checks out the calling repo, then chains diff → spellcheck → ATS check → format → PR comment. On
any step failure, a best-effort "Notify Step Errors" step posts a `# Markdown Checks` comment
linking to the failed run.

```yaml
jobs:
  analysis:
    uses: alcash55/ac-composite-actions/.github/workflows/resume-analysis.yml@main
    with:
      RESUME: resumes/my-resume.pdf
      ORG: ${{ github.repository }}
      BRANCH: ${{ github.head_ref }}
      PR_NUMBER: ${{ github.event.pull_request.number }}
    secrets:
      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      APILAYER_API_KEY: ${{ secrets.APILAYER_API_KEY }}
```

### `portfolio-message.yml`

Sends a Discord webhook message. Inputs: `MESSAGE`, `WEBHOOK_URL`, `avatar_url`.

### `accessibility-analysis.yml`

Checks out the calling repo, runs [`accessibility/axe-check`](#accessibilityaxe-check), then fails
the job if any route came back with a violation. See that action's own docs for the
`RESULTS_PATH`-vs-`BASE_URL`/`ROUTES` split; this workflow forwards all four inputs unchanged.

```yaml
jobs:
  accessibility:
    uses: alcash55/ac-composite-actions/.github/workflows/accessibility-analysis.yml@main
    with:
      BASE_URL: https://staging.example.com
      ROUTES: "/ /about /contact"
```

---

## Versioning & releases

**Not yet in effect** — this section documents the process; no tags exist in this repo as of this
writing. Everything is still consumed at `@main` (see the note at the top of this file). This is
prepared so that turning it on later is a documentation lookup, not a design discussion.

### Why this matters

Every consumer references `@main`. A bad push to any action here breaks every consumer immediately,
with no way for a consumer to pin to a known-good state and upgrade on its own schedule. Tags fix
that, but only once they exist and consumers actually move to them — creating a tag today changes
nothing for existing callers until they update their `uses:` lines.

### Scheme

Standard [SemVer](https://semver.org) tags (`vX.Y.Z`), plus a moving major-version tag (`v1`) that
consumers pin to instead of a full version — the same convention as `actions/checkout@v4`.

- **Major (`vX`)** — any breaking change: a renamed or removed input/output, an input that becomes
  `required` where it wasn't, a change to an existing output's meaning or format that a consumer
  could be parsing. `agents.md` already commits this repo to additive changes for exactly this
  reason — a major bump should be rare.
- **Minor (`vX.Y`)** — new action, new optional input/output, backward-compatible behavior change.
- **Patch (`vX.Y.Z`)** — bug fixes with no interface change (e.g. this sprint's `SPELL_ERRORS` /
  `CSPELL_ERRORS` output-name fix would have been a patch, had tags existed).

### Maintaining the moving `v1` pointer

`v1` is a branch-like tag: it always points at the latest `v1.Y.Z` commit. Cut a normal annotated
tag for the release, then force-move `v1` to it:

```bash
git tag -a v1.2.0 -m "Release v1.2.0"
git push origin v1.2.0

git tag -f v1 v1.2.0
git push origin v1 --force
```

The `--force` push only ever moves `v1` to a commit that already has its own immutable `vX.Y.Z`
tag — consumers who pinned to `v1.2.0` directly are never affected by a later `v1` move.

### Migrating consumers from `@main` to `@v1`

Once the first `v1` tag exists, each consumer changes its `uses:` lines from:

```yaml
uses: alcash55/ac-composite-actions/diff@main
```

to:

```yaml
uses: alcash55/ac-composite-actions/diff@v1
```

No other changes needed for a same-major upgrade. A future breaking change ships as `v2`, and
consumers migrate to it on their own schedule by bumping that one tag reference — `@main` keeps
tracking the latest commit for anyone who hasn't moved yet, but the intent is for everyone to move
off it.

### Proposed starting version

**`v1.0.0`**, cut from `main` once the `backend` half of this sprint's chain-repair work
(`markdown-checks/spellcheck`, `format-message`, `notifications`) is merged — that is the first
point at which `resume-analysis.yml` actually runs end to end and produces a real PR comment,
which is a reasonable definition of "the public interface works as documented." Tagging now, while
that chain is still broken, would tag a known-broken state as `v1.0.0`.

Exact commands, to be run from `main` after that merge (**not run as part of this sprint** — see
below):

```bash
git checkout main && git pull
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
git tag v1 v1.0.0
git push origin v1
```

**These commands have not been run.** Tagging is a public interface promise to every consuming
repo and is Alex's call to make, not something to do as part of routine devops work.

## Contributing

See [`agents.md`](./agents.md) for the composite action template, the rules that apply to every
action here, and the checklist for adding a new one.

### CI

`.github/workflows/ci.yml` runs on every pull request and installs + tests each action directory
listed in its matrix. A directory is added to the matrix once it has a real, passing `test` script
(`yarn test` or `bun test`) — that's a one-line addition to the matrix `include:` list, nothing
else in the workflow changes. Directories without a runnable test script yet are deliberately left
out rather than wired in to fail (see the comments in `ci.yml` for which ones and why).
