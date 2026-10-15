# Betterleaks rollout

The rollout covers the 13 owned repositories updated in 2026, including the
ApexFitness fork. Older demos, coursework, and the older tutorial fork are excluded.

[Shared implementation PR #110](https://github.com/alcash55/ac-composite-actions/pull/110)
adds the scanner, reporter, and the shared repository's own workflows. Its first
hosted scan and all CI checks passed. The 12 consumer PRs below add only two
workflow files each. Consumers pin an immutable shared workflow revision, which
in turn pins the scanner and reporter action revision.

| Consumer | Rollout PR | Initial hosted PR scan |
|---|---|---|
| alcash55 | [#5](https://github.com/alcash55/alcash55/pull/5) | [Passed](https://github.com/alcash55/alcash55/actions/runs/38705073852) |
| apexfitnessnyc | [#2](https://github.com/alcash55/apexfitnessnyc/pull/2) | [Passed](https://github.com/alcash55/apexfitnessnyc/actions/runs/38704995118) |
| clipper | [#60](https://github.com/alcash55/clipper/pull/60) | [Passed](https://github.com/alcash55/clipper/actions/runs/38705017381) |
| Golem-Miners | [#166](https://github.com/alcash55/Golem-Miners/pull/166) | [Passed](https://github.com/alcash55/Golem-Miners/actions/runs/38705007995) |
| homelab | [#2](https://github.com/alcash55/homelab/pull/2) | [Passed](https://github.com/alcash55/homelab/actions/runs/38705029326) |
| House | [#1](https://github.com/alcash55/House/pull/1) | [Passed](https://github.com/alcash55/House/actions/runs/38705081501) |
| Little-Town | [#130](https://github.com/alcash55/Little-Town/pull/130) | [Passed](https://github.com/alcash55/Little-Town/actions/runs/38705049409) |
| obsidian-vault | [#2](https://github.com/alcash55/obsidian-vault/pull/2) | [Passed](https://github.com/alcash55/obsidian-vault/actions/runs/38704965858) |
| Portfolio | [#126](https://github.com/alcash55/Portfolio/pull/126) | [Passed](https://github.com/alcash55/Portfolio/actions/runs/38704984976) |
| Resume | [#28](https://github.com/alcash55/Resume/pull/28) | [Passed](https://github.com/alcash55/Resume/actions/runs/38704974439) |
| Royalty-VS-Code-Theme | [#8](https://github.com/alcash55/Royalty-VS-Code-Theme/pull/8) | [Passed](https://github.com/alcash55/Royalty-VS-Code-Theme/actions/runs/38705060376) |
| WildyBingo | [#35](https://github.com/alcash55/WildyBingo/pull/35) | [Passed](https://github.com/alcash55/WildyBingo/actions/runs/38705037376) |

## Comment validation

[Temporary validation PR #111](https://github.com/alcash55/ac-composite-actions/pull/111)
was closed without merging, and its test branch was deleted. GitHub push
protection rejected a fabricated AWS fixture, so the live test used a harmless
sentinel and a test-only scanner rule instead. No secret protection was disabled.

- The [first hosted scan](https://github.com/alcash55/ac-composite-actions/actions/runs/38705428766)
  failed on a finding and uploaded a redacted artifact.
- The trusted bundled reporter read that real artifact, verified its source run
  and current PR head through GitHub, and posted one redacted comment.
- A [second hosted finding scan](https://github.com/alcash55/ac-composite-actions/actions/runs/38705720037)
  updated the same comment ID. Replaying the earlier result after the push was skipped.
- A [clean hosted scan](https://github.com/alcash55/ac-composite-actions/actions/runs/38705794769)
  produced an empty result. The reporter removed the finding comment.

The reporter bundles and PR API behavior were exercised against hosted artifacts.
Automatic `workflow_run` scheduling can only be verified after each reporter file
reaches the consumer's default branch. The validation did not merge workflows or
change default-branch settings to enable it early.

## Activation and baselines

All rollout PRs remain open. Merge the shared implementation first, then the
consumer PRs. The consumer merge pushes trigger full-history scans; PR scans only
prove the added commits are clean. Review each first full scan and rotate any live
credential found in history. Do not add a blanket allowlist to make it pass.

Portfolio already had a local full-history baseline of zero findings across 575
reachable commits at `77db6e23aed55e031b68c40c992f85af662d27a6`. That scan took
44.1 seconds, and a clean recent-commit diff took 0.8 seconds, excluding download.
The other consumers' first default-branch full scans remain pending their merges.
