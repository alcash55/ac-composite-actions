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
| [`notifications/pr-comment`](#notificationspr-comment) | ✅ Ready | Upserts one PR comment per checker, found by a hidden marker |
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
| `ATS_THRESHOLD` | — | Minimum passing score, an integer from 0 to 100. Default `70`. Anything else fails the action with an error naming the value |
| `COMMENT_KEY` | — | Names this resume's PR comment. Defaults to the filename without its extension, so `resume/fullstack.pdf` owns the `ats-fullstack` comment and several resumes on one PR keep separate comments |
| `COMMENT_ON_PR` | — | `true` by default. Posts the score, verdict, and report as a PR comment. `false` turns it off |
| `GH_TOKEN`, `GITHUB_ORG`, `PR_NUMBER` | — | Comment target overrides, see [PR comments](#pr-comments-from-checker-actions) |

A score below the threshold sets `ATS_PASSED` to `false` and logs a warning. It does not fail the job.

### Outputs

| Output | Description |
|---|---|
| `ATS_SCORE` | Overall ATS compatibility score (0–100) |
| `ATS_REPORT` | Detailed markdown report with score breakdown and recommendations |
| `ATS_PASSED` | `"true"` if the score is at or above `ATS_THRESHOLD`, `"false"` otherwise |
| `ATS_RESUME` | File name of the scored resume, such as `fullstack.pdf` |

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

The parser API returns a null `name`, no summary, mangled dates, and invents entries (an
organization named `SUMMARY`). So when the PDF has a text layer (100 or more characters), the action
reads that text and the API only fills in when it has none.

- Name: 2 to 4 alphabetic words on one of the first 6 lines (ALL CAPS, and a first and last name on
  separate lines, both work). Summary: a `SUMMARY`, `PROFILE`, `OBJECTIVE` or `ABOUT` heading followed by text.
- Experience, education and skills each need their heading (`EXPERIENCE`, `EDUCATION`, `SKILLS`, and
  common variants) with text under it. A section ends at the next heading.
- Jobs: under the experience heading, a date range line (`8/2024 - 9/2026`, `Apr 2023 - Jun 2024`,
  `2021 - Present`, hyphen, en or em dash, or `to`) and a short capitalised job-title line are
  anchors. Anchors with no bullet between them form one job, a second range or title starts the next,
  and a bullet closes the job. Each job needs a range (10 points for all, 5 for some) and a title
  (same tiers). Education and leadership dates sit outside this section and never count.
- Years must run from 1990 through next year and the end may not precede the start.
- With no readable text layer, the API entries stand in, with the same year check.

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
| `GH_TOKEN` | — | `""` | Token for the actor triggering the workflow (`source` mode with `DIFF`). Also the token for the PR comment, falling back to the job's `GITHUB_TOKEN` |
| `ROUTES` | — | `""` | Space delimited routes to check (`rendered` mode, with `BASE_URL`) |
| `BASE_URL` | — | `""` | Base URL of a running site (`rendered` mode, self-driven browser) |
| `RENDERED_CONTENT_PATH` | — | `""` | Path to pre-extracted `[{ route, innerText, description, labels }]` JSON (`rendered` mode, no browser needed) |
| `DICTIONARY` | — | `""` | Path to a consumer-owned cspell config, merged with the shared baseline via cspell's own `import` |
| `COMMENT_ON_PR` | — | `true` | Post the result as a PR comment (see [PR comments](#pr-comments-from-checker-actions)). `false` turns it off |
| `PR_NUMBER` | — | the triggering PR | Pull request to comment on |

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
| `GH_TOKEN` | — | the job's `GITHUB_TOKEN` | Token that can write PR comments |
| `GITHUB_ORG` | — | the running repo | `<owner>/<repo>` to comment on |
| `COMMENT_ON_PR` | — | `true` | Post the result as a PR comment (see [PR comments](#pr-comments-from-checker-actions)). `false` turns it off |
| `PR_NUMBER` | — | the triggering PR | Pull request to comment on |

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
`MESSAGE` is empty. This path matches old comments by heading and skips comments that carry a
hidden marker (see [PR comments](#pr-comments-from-checker-actions)). For `discord`, it delegates to
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

## `notifications/pr-comment`

Turns a checker's output into one PR comment and keeps it current. `markdown-checks/spellcheck`,
`accessibility/axe-check`, and `ats-check` call it at the end of their own run, so a caller gets
the comment by adding nothing. Call it directly only to comment on output from your own check.

| Input | Required | Default | Description |
|---|---|---|---|
| `KIND` | ✅ | — | `spellcheck`, `axe`, `ats`, or `failure` (a workflow's failure notice). Also names the comment's hidden marker |
| `DATA` | ✅ | — | The checker's JSON output (`ats`: `toJSON(steps.<id>.outputs)`; `failure`: `{workflow, subject, run_url}`). Empty or clean removes the old comment |
| `COMMENT_KEY` | — | — | Slugified and appended to the marker (`KIND` `ats` + key `fullstack` = `ats-fullstack`), so one check run several times on a PR keeps one comment per run |
| `COMMENT_ON_PR` | — | `true` | `false` turns commenting off |
| `GH_TOKEN` | — | the job's `GITHUB_TOKEN` | Token that can write PR comments |
| `GITHUB_ORG` | — | the running repo | `<owner>/<repo>` |
| `PR_NUMBER` | — | the triggering PR | Pull request number |

It runs the committed `notifications/dist` bundles by relative path rather than through
`uses: .../notifications@main`, so the action and its scripts always come from the same ref.
Formatting lives in `github-comments/format-comment`, the marker upsert in
`github-comments/upsert-comment`.

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

## PR comments from checker actions

`markdown-checks/spellcheck`, `accessibility/axe-check`, and `ats-check` comment on the pull
request on their own, so the author sees what failed without opening the run log.

- **When:** only when the workflow runs on `pull_request` or `pull_request_target`, and
  `COMMENT_ON_PR` is not `false`.
  Callers must include the `synchronize` activity so pushes rerun the checks.
  Plain `pull_request:` includes it by default. If `types` is set explicitly,
  include `opened`, `reopened`, and `synchronize`. Avoid path filters that can
  skip a rerun needed to clear a previous result.
- **What:** spellcheck lists each misspelled word with up to 3 cspell suggestions and a `file:line` link to the line at the PR head commit (plain text when the repo or commit is unknown). axe lists each rule with
  impact, element count, help link, and the first three selectors, per route. ATS shows the score
  once in its heading, then the breakdown and recommendations. Long lists are cut under GitHub's size limit with a "N more not shown" line.
- **One comment per check, updated in place.** Each comment starts with a hidden marker, for example
  `<!-- ac-composite-actions:spellcheck -->`, and a later run edits that comment rather than posting
  another. The spellcheck and axe comments never touch each other. A check that runs more than
  once on a PR (a matrix over resumes, axe on two sites) sets `COMMENT_KEY` so each run gets its
  own marker, such as `<!-- ac-composite-actions:ats-fullstack -->`. `ats-check` does this by
  itself from the resume filename, and its heading names the file: `ATS check (fullstack.pdf):
  needs work (88/100)`. Spellcheck and axe take `COMMENT_KEY` but default to one shared comment.
- **A clean run removes the old comment** so fixed errors do not linger. ATS always keeps its comment,
  since a passing score is still the result. An empty source-mode diff also clears
  the previous spelling comment. A failed check does not count as a clean result.
- **Commit freshness:** each result names the PR head commit it checked, even when
  the score is unchanged. Before creating, updating, or deleting a comment, the
  reporter checks that the PR is still open at that commit. Superseded runs skip
  their writes. The API offers no atomic head-check-and-write operation, so callers
  should also cancel older runs using a concurrency group per PR and check. The
  resume workflow includes the resume path so matrix variants stay independent.
- **It never fails the check.** A missing permission, a fork PR, or an API error becomes a
  warning and the step goes on.
- **Size limit:** the checker output reaches the formatter as an environment variable, and Linux caps one at 128 KB. A larger result (thousands of misspelled files) makes the format step fail with `Argument list too long`, which is tolerated: the check stays green and the comment is not updated.
- **Permission:** the calling job needs `pull-requests: write` for the default `GITHUB_TOKEN`.
- **Escaping:** filenames, words, and selectors come from the PR, so they go inside code spans with
  a fence that cannot be closed early, and axe help text is escaped. Only `https` help links are kept.
- **Old comments:** `notifications` `delete-comment` skips marked comments, so it cannot delete them
  by a heading match.

```yaml
permissions:
  contents: read
  pull-requests: write
```

PRs from forks get a read-only `GITHUB_TOKEN` under `pull_request`, so they get the warning and no
comment. `pull_request_target` runs with write access, so use it only if you understand what it
exposes.

The reusable workflows differ: `resume-analysis.yml` keeps its single combined spelling comment and
turns the spellcheck comment off, and posts only the ATS comment on top. `accessibility-analysis.yml`
comments through axe-check.

---

## Reusable workflows

Called with `uses:` at the job level rather than the step level.

### `resume-analysis.yml`

Checks out the calling repo, then chains diff → spellcheck → ATS check → format → PR comment. The
combined comment carries the spelling errors, so spellcheck runs with `COMMENT_ON_PR: "false"` to
avoid posting them twice. The combined comment works for any caller that supplies `PR_NUMBER`.
The ATS check posts its own marked comment, named after the `RESUME` file, which needs a `pull_request` caller. Calling the workflow in a matrix over several PDFs gives one ATS comment per PDF. `ATS_THRESHOLD` (integer 0-100, default 70) sets the passing score; a lower score warns and does not fail the job. On
any step failure, a best-effort "Notify Step Errors" step posts a failure notice linking to the
failed run. Like the ATS comment it is keyed by `RESUME`, so each PDF in a matrix keeps its own
notice, and a passing re-run of that PDF removes it.

```yaml
jobs:
  analysis:
    uses: alcash55/ac-composite-actions/.github/workflows/resume-analysis.yml@main
    with:
      RESUME: resumes/my-resume.pdf
      ORG: ${{ github.repository }}
      BRANCH: ${{ github.head_ref }}
      PR_NUMBER: ${{ github.event.pull_request.number }}
      ATS_THRESHOLD: 80 # optional, default 70
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

It also takes `COMMENT_ON_PR` (default `true`). The violations are posted as a PR comment, so the
calling job needs `pull-requests: write`. This workflow declares no `permissions:` block of its own,
because a reusable workflow that asks for more than its caller grants fails at startup. A caller
without the permission gets a warning and no comment.

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

### Bundled `dist/`

`diff`, `ats-check`, `format-message`, `notifications`, and the `RESULTS_PATH` branch of
`accessibility/axe-check` run from a committed `dist/` bundle instead of installing at invocation
time — [`esbuild`](https://esbuild.github.io/) inlines each action's dependencies into one file, so
a consumer's job never pays for a network install in its critical path. Each bundled action's
`package.json` carries a `build` script (`yarn build`, or for `notifications`, `bun run build`)
that regenerates `dist/` from source; `ci.yml`'s `build-check` job runs that script on every PR and
fails if the committed bundle doesn't match a fresh one, so a source change without a rebuild can't
ship stale code.

`notifications` runs its bundle under `node`, not `bun`, and no longer sets up a bun runtime at
all: bundling inlines the real `undici` package `@actions/core` depends on, which is what let the
`ProxyAgent`-export gap in Bun's own built-in `undici` shim (fixed at runtime in #59 by pinning bun
to 1.1.38) happen in the first place. Once nothing in the bundle is bun-specific, there's no reason
to run it under bun.

`esbuild` over `@vercel/ncc`: ncc's default output for these actions ran past 380,000 lines because
it inlines every dynamically-imported package it can reach, including ones an action never actually
needs at runtime (see the `axe-check` carve-out below). `esbuild --minify` with the problem
dependencies marked `--external` keeps the same one-file-per-action shape at roughly 500 KB and
under 100 lines each — smaller than ncc's own `--minify` output, and every consumer of this repo
clones the difference.

esbuild's ESM output needs one fix `@vercel/ncc` didn't: a handful of these actions pull in
CommonJS dependencies (`@actions/http-client`'s `tunnel`, for one) that call the real `require` for
Node builtins like `net`. Plain ESM has no `require`, so each bundle's `build` script prepends a
one-line banner that recreates it via `createRequire(import.meta.url)` — a real `require` backed by
Node's own resolver, not a shim.

Two carve-outs, both for concrete reasons rather than left for later:

- **`accessibility/axe-check`'s self-driven mode** (`BASE_URL`/`ROUTES`, no `RESULTS_PATH`) still
  installs and runs from source. It dynamically imports `playwright` and `@axe-core/playwright` to
  drive a real browser, and a JS bundler has nothing useful to do with a browser driver package —
  the build script marks both `--external` so the bundle never tries. `RESULTS_PATH` (the path this
  action's own docs already recommend) never reaches that import at all, so it bundles cleanly and
  needs no install of its own.
- **`markdown-checks/spellcheck` isn't bundled at all.** It shells out to the `cspell` CLI
  (`execSync`) rather than importing it as a library, so `cspell` and its dictionaries stay a real
  install no matter what happens to this action's own thin JS glue (`@actions/core`,
  `@octokit/rest`) — there's nothing for a bundle to buy here, and bundling just the glue would add
  a second install path for no real savings, since `cspell` is the expensive part and is needed on
  every real invocation regardless of mode.

`notifications/discord-messages` needed no changes: it already delegates the whole send to a
pinned third-party action (`MineBartekSA/discord-webhook`) rather than running its own script, so
it never had an install step to remove.
