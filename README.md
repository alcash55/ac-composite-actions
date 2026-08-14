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

## Contributing

See [`agents.md`](./agents.md) for the composite action template, the rules that apply to every
action here, and the checklist for adding a new one.
