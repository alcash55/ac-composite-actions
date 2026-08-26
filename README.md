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
| [`markdown-checks/spellcheck`](#markdown-checksspellcheck) | ⚠️ Partial | Spellchecks changed markdown with cspell |
| [`notifications`](#notifications) | 🚧 Incomplete | Posts a PR comment or Discord message |
| [`notifications/discord-messages`](#notificationsdiscord-messages) | ✅ Ready | Sends a Discord webhook message |
| [`format-message`](#format-message) | 🚧 Stub | Formats a spellcheck result into a comment body |

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

---

## `markdown-checks/spellcheck`

Runs [cspell](https://cspell.org/) over the markdown files in `DIFF`, fetching each file's
content from the GitHub API at the given branch.

> ⚠️ Works, but rough: the action's `if:` guard is malformed and the temporary file it writes for
> cspell is never cleaned up. Project-specific words go in `markdown-checks/.cspell.json`.

### Inputs

| Input | Required | Description |
|---|---|---|
| `DIFF` | ✅ | Space delimited list of files to check — pair with the `diff` action's `DIFF` output |
| `BRANCH` | ✅ | Ref the content should be read from |
| `GITHUB_ORG` | ✅ | `<owner>/<repo>` |
| `GH_TOKEN` | ✅ | Token for the actor triggering the workflow |

### Outputs

| Output | Description |
|---|---|
| `SPELL_ERRORS` | cspell output for each file with spelling issues |

---

## `notifications`

Intended as one entry point for both PR comments and Discord messages, switching on
`MESSAGE_TYPE`.

> 🚧 **Not usable yet.** The `sendGithubMessage`, `deleteGithubMessage` and `discordMessage`
> scripts in `notifications/package.json` are empty stubs (`"bun"`, `"bun "`), so every step in
> this action currently fails. Use
> [`notifications/discord-messages`](#notificationsdiscord-messages) for Discord in the meantime.
>
> Most of the delete path already exists in `notifications/github-comments/delete-comment/index.js`
> — it finds the previous bot comment on the PR and removes it. It just is not wired to a script.

### Inputs

| Input | Required | Description |
|---|---|---|
| `MESSAGE` | ✅ | Message to send |
| `MESSAGE_TYPE` | ✅ | `github` or `discord` |
| `GITHUB_ORG` | — | `<owner>/<repo>` — required when `MESSAGE_TYPE` is `github` |
| `PR_NUMBER` | — | Pull request number — required when `MESSAGE_TYPE` is `github` |
| `GH_TOKEN` | — | Token — required when `MESSAGE_TYPE` is `github` |

### To finish it

1. Point `deleteGithubMessage` at the existing `github-comments/delete-comment/index.js`.
2. Add the matching `github-comments/send-comment/index.js` and point `sendGithubMessage` at it.
3. Wire the Discord branch to `notifications/discord-messages` instead of the empty
   `discordMessage` script.
4. Declare `MESSAGE` in the step `env:` — it is currently accepted as an input but never passed
   through to any script.

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

Turns a raw spellcheck result into a formatted comment body.

> 🚧 **Stub.** `formatSpell()` has an empty `try` block and always returns an empty string, so
> `FORMATTED_MESSAGE` is always empty.

| Input | Required | Description |
|---|---|---|
| `SPELL_MESSAGE` | ✅ | Unformatted spellcheck output |

| Output | Description |
|---|---|
| `FORMATTED_MESSAGE` | Formatted message for the target channel |

---

## Reusable workflows

Called with `uses:` at the job level rather than the step level.

### `resume-analysis.yml`

Chains diff → spellcheck → ATS check → format → PR comment.

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

> Depends on `notifications` and `format-message`, so the final comment step does not work yet.

### `portfolio-message.yml`

Sends a Discord webhook message. Inputs: `MESSAGE`, `WEBHOOK_URL`, `avatar_url`.

### `accessibility-analysis.yml`

Placeholder — the job only echoes a string.

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
