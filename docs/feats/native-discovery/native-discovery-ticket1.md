# native-discovery-ticket1

## Status

- Goal: turn bounded discovery evidence into coordinator-owned, duplicate-checked local work.
- Initial priority: P1
- Effort: Large
- Risk: elevated; invented work or ambiguous intake can duplicate dispatch and expand scope.
- Depends on: F12 validated definitions and F04 bounded lesson retrieval.
- Planned at: `e0ceef3f29e5884c0700be855edb9f28084966a4`, 2026-11-13.
- Local path: `docs/feats/native-discovery/native-discovery-ticket1.md`
- Backlog: F17. Local-only ticket; not implemented or authorized for external filing.

## Why this matters

An empty queue must not produce endless speculative tickets. Discovery needs evidence, a bounded
pass, and an explicit exhausted outcome before the factory can run unattended.

## Current state

`factory/native.ts` parses an operator-authored ticket manifest and dispatches ready entries.
Its native loop has no bounded discovery pass. Fixture trials are not native intake evidence.
PRD R2-R4 define modes, ticket ownership, and bug judgment; AC1-AC12 retain the acceptance contract.

## Approach

Extend the accepted definition and persistence contracts with one coordinator-owned discovery pass
per scope. Validate evidence before admitting work. Keep discovery identity separate from code
attempts, and reconcile interrupted or ambiguous intake before creating anything again.

## Scope

- In: native discovery, durable intake, scoped briefs, tests, and operator documentation.
- Out: changing user scope or permissions, automatic publishing, and frontend redesign.
- Allowed edits: `factory/` and the definition schema paths accepted by F12.
- Local trials file no external tickets. Future external filing needs its own explicit permission.

## Steps

1. **Define bounded discovery records**. Revalidate F12/F04 and model identity, evidence, and exhaustion.
2. **Run selected discovery mode**. Apply mode changes only to the next bounded pass.
3. **Admit only evidenced work**. Check duplicates, persist admission, and use the existing queue.
4. **Verify interrupted intake recovery**. Exercise cooldown, permission refusal, and revision gates.

## Test plan

- Use a cheap Luna fixture for each mode and an empty-result negative control.
- Reject unsupported bug claims; retain hypotheses as investigations without confirmed priority.
- Distinguish accessibility, cosmetic, and shared security findings through PRD R4 evidence.
- Deliver duplicate completion and restart during intake; admit work once without replacing owners.
- Change mode mid-pass, pause, and exhaust scope; no concurrent pass or premature rediscovery.
- Reuse the full configured gate and required cold review on the exact candidate.

## Why this approach?

Persisting admission before dispatch prevents a repeated discovery report from becoming a second
worker. Coordinator judgment keeps worker observations from silently expanding implementation scope.

## Files You'll Touch

| Path | Role | Contains | Edit or Read |
| --- | --- | --- | --- |
| `factory/native.ts` | Coordinator | Existing queue and dispatch | Edit |
| `factory/persistence.ts` | Durable state | Existing transition storage | Edit |
| `factory/plugin.ts` | Native adapter | Event and control boundary | Edit |
| `factory/native.test.ts` | Lifecycle proof | Restart and ownership checks | Edit |
| `factory/persistence.test.ts` | Storage proof | Atomic transitions | Edit |
| `factory/plugin.test.ts` | Adapter proof | Native event delivery | Edit |
| `factory/README.md` | Operator contract | Modes, evidence, and refusal | Edit |
| `docs/prd.md` | Requirements | R2-R4 and AC1-AC12 | Read |

Re-scope definition and lesson files after their dependencies land. Build durable transitions before
native execution and adapter delivery; do not introduce a second queue.

## Initial state / preflight

Implementation checks have not run for this ticket. Dependencies are still pending. Before
dispatch, record the accepted definition schema and lesson APIs rather than guessing their paths.

| Command | Expected result / action |
| --- | --- |
| `git rev-parse HEAD` | Record dispatch SHA and explain prerequisite drift. |
| `git status --short` | Preserve and account for existing edits. |
| `git diff --stat e0ceef3..HEAD -- factory/` | Revalidate accepted prerequisite changes. |
| `git diff -- factory/` | No unexplained unstaged implementation edits. |
| `git diff --cached -- factory/` | No unexplained staged implementation edits. |
| `bun --version` | Record toolchain version. |
| `bun install --frozen-lockfile` | Prepare the exact worktree. |
| `bash factory/checks.sh full` | Baseline full gates pass; otherwise return the blocker. |
| `git diff --check` | No whitespace errors. |

## Done when

- [ ] All modes enforce their evidence contract and bounded scope.
- [ ] Exhaustion, pause, mode changes, and cooldown cannot manufacture duplicate work.
- [ ] Restart and repeated intake preserve a single ticket and implementation owner.
- [ ] The exact candidate passes full gates and required independent review.
- [ ] Local fixture proof is distinguished from authorized native external filing.
