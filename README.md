<<<<<<< Updated upstream
# AC-Composite Actions

## How to use

### markdown checks

#### spellcheck

### notifications

#### delete github comment

#### send github comment

#### send discord webhook message
=======
# AC-Composite Actions

## How to use

### ats-check

Parses a resume PDF and scores its ATS (Applicant Tracking System) compatibility using the [APILayer Resume Parser API](https://apilayer.com/marketplace/resume_parser-api).

#### Inputs

| Input | Required | Description |
|---|---|---|
| `RESUME` | ✅ | Path to the resume PDF, relative to the repo root |
| `RESUME_PARSER_API_KEY` | ✅ | APILayer Resume Parser API key |

#### Outputs

| Output | Description |
|---|---|
| `ATS_SCORE` | Overall ATS compatibility score (0–100) |
| `ATS_REPORT` | Detailed markdown report with score breakdown and recommendations |
| `ATS_PASSED` | `"true"` if the score is 70 or above, `"false"` otherwise |

#### Scoring rubric

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

#### Example usage

```yaml
- name: ATS Check
  id: ats_check
  uses: alcash55/ac-composite-actions/ats-check@main
  with:
    RESUME: resumes/my-resume.pdf
    RESUME_PARSER_API_KEY: ${{ secrets.RESUME_PARSER_API_KEY }}

- name: Post ATS Report as PR Comment
  uses: alcash55/ac-composite-actions/notifications@main
  with:
    MESSAGE: ${{ steps.ats_check.outputs.ATS_REPORT }}
    MESSAGE_TYPE: github
    PR_NUMBER: ${{ github.event.pull_request.number }}
    GITHUB_ORG: alcash55/ac-composite-actions
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

> **Setup:** Add your APILayer key as a repository secret named `RESUME_PARSER_API_KEY`. You can get a free key at [apilayer.com](https://apilayer.com/marketplace/resume_parser-api).

---

### markdown checks

#### spellcheck

### notifications

#### delete comment

#### send comment
>>>>>>> Stashed changes
