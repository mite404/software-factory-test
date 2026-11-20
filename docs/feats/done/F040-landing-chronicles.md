# F040-landing-chronicles

## Status

- Goal: two narrative HTML artifacts per large or risky landing - a walkthrough with real proof
  and a changes summary with a data-flow flowchart - published by the Foreman with zero factory
  code.
- Initial priority: P2
- Effort: Small
- Risk: low; the ticket edits one documentation section. The procedure it documents touches
  public artifacts, so the privacy rules in that section are the blast radius.
- Depends on: nothing.
- Planned at: `a0703dd6c5f10e9017db5808b78fc1bf7bbb80e0`, 2026-11-19
- Supersedes: F039-landing-chronicles, re-cut for the light lane on 2026-11-20. F039 was
  admitted without a lane while the parked F028 run holds the main lane; an admitted queue row
  is frozen, so the lane cannot be repaired in place.
- Local path: `docs/feats/chronicle/F040-landing-chronicles.md`

## Why this matters

A landed ticket currently leaves a merge commit, a gate log and a review verdict - records built
for auditors, not readers. For the tickets that deserve it, the operator wants the Warp-style
pair: what the agent did, with proof that it works, and what data moved where. Building this as
factory machinery (proof binding at gate time, a new evidence kind, dashboard projection) was
designed and rejected at the checkpoint as too much surface for the value.

## Current state

`factory/README.md` documents `record-merge` and `record-landing` but no post-merge narrative
step. Queue entries already carry `size?: "small" | "medium" | "large"` and `risky?: boolean` in
the `Task` type in `factory/persistence.ts` (lines 81-82), and briefs are already Foreman-written
per ticket at admission. Retained records available after a landing: the gate log at
`.git/factory/<ticket>-<attempt>.log`, the post-graft review verdict JSON, the attempt report
JSON, the accepted base and revision on the run, and the merge commit recorded by
`record-merge`. The Foreman thread has an artifact tool that publishes documents and visuals.

## Approach

Add one `## Chronicle a landed ticket` section to `factory/README.md`, immediately after
`## Record a ticket landed outside the factory`. The section documents a manual procedure with
three parts, and no code changes anywhere.

Selection: a landed ticket gets a chronicle when its queue entry has `size: "large"` or
`risky: true`, or the operator names one by hand. Small, low-risk landings get none.

Proof capture: when the Foreman writes the admission brief for a qualifying ticket, it appends
this boilerplate paragraph:

> Proof capture for the landing chronicle: while you verify, keep the proof a reader needs to
> believe the change works. For UI changes, capture screenshots or short recordings of every
> affected state, default state first, at the sizes the ticket names. For backend or tooling
> changes, keep the command invocations and their decisive output excerpts. Attach these files
> to your completion message to the Foreman. The attachments feed a public narrative page:
> capture only what may be public, never private briefs, secrets, or runtime state.

Authoring and publishing: after `record-merge` succeeds for a qualifying ticket, the owning
Foreman spawns one chronicler child thread on the light-lane model (`moonshotai/kimi-k3`, low
effort). The chronicler reads only retained records - the accepted diff from base to merge
commit, the gate log, the review verdict, the report summary, and the worker's attached proof
media - and writes two self-contained HTML files (inline styles and scripts, no external or
localhost references, media embedded as data URLs or durable Amp attachment URLs):

1. `Walkthrough · <ticket>`: the narrative of what the agent did and why, embedding the proof
   media and quoting decisive gate-log excerpts with their log paths and revision shas.
2. `Changes · <ticket>`: what data moves where and why, with a flowchart and the load-bearing
   files called out.

The chronicler returns file paths; the Foreman publishes each file as a thread artifact with
exactly those stable titles, then links both artifacts in the ticket file at close-out and in
the merge report. Stable titles make republication idempotent. Chronicling runs after the merge
is recorded, so a chronicler failure never reopens the ticket, blocks the next dispatch, or
touches the PR. Private briefs, incident details, and Git-metadata report paths stay out of the
pages; the chronicler's input is the public-safe subset of retained records.

## Scope

- In: one new section in `factory/README.md`.
- Out: any code change. No packet schema, inbox, evidence kind, persistence, control, or
  dashboard changes; the gate-time proof-binding design remains the upgrade path if claim-only
  pages ever appear.
- Out: chronicling existing landed tickets; the procedure applies to landings after it lands.
- Out: per-ticket coverage for small, low-risk tickets.

## Steps

1. **Document selection and proof capture**. Write the selection rule and the exact brief
   boilerplate paragraph into the new section, and verify `size` and `risky` exist on `Task` in
   `factory/persistence.ts` with the documented spelling.
2. **Document the chronicler contract**. Write the chronicler thread's model, inputs, outputs,
   self-containment and privacy rules, and verify each retained-record path it names against
   the README's state documentation and the actual `.git/factory/` layout of a landed ticket.
3. **Document publish and close-out**. Write the stable artifact titles, the close-out and
   merge-report link targets, and the idempotency and failure-isolation rules.

Illustrative queue entry, not authorization to change the coordinator queue or dispatch work.
The `steps` values copy the bold labels above in order. The brief retains the full ticket
pointer.

```json
[
  {
    "id": "F040-landing-chronicles",
    "brief": "Implement docs/feats/chronicle/F040-landing-chronicles.md",
    "after": [],
    "size": "small",
    "steps": [
      "Document selection and proof capture",
      "Document the chronicler contract",
      "Document publish and close-out"
    ]
  }
]
```

Labels are public planned-work descriptions, not evidence of the worker's current step.

## Test plan

- `rg` every fact the new section asserts: `size`/`risky` on `Task` in
  `factory/persistence.ts`, the gate-log path pattern `.git/factory/<ticket>-<attempt>.log`,
  and the review report naming; each must match the source.
- Pick one already-landed qualifying ticket and confirm every retained record the chronicler
  contract names actually exists for it in the clone's `.git/factory/`.
- Run `bash factory/checks.sh guard` for Markdown width and the full configured gate.

## Why this approach?

- Without this structure: the proof-binding design adds a gate-time media pipeline, a new
  evidence kind, and dashboard projection to solve a presentation problem.
- This buys: the operator value (narrative, real proof, flowchart) at one documentation
  section, with failure isolation for free because authoring happens after the merge is
  recorded. Selection reuses queue fields that already exist, so no schema change.

## Files You'll Touch

| Path                                          | Role               | Contains                          | Edit or Read |
| --------------------------------------------- | ------------------ | --------------------------------- | ------------ |
| `factory/README.md`                           | Operator contract  | Landing and state documentation   | Edit         |
| `factory/persistence.ts`                      | Task field source  | `size`/`risky` definitions        | Read         |
| `.git/factory/` in the working clone          | Retained records   | Gate logs, review reports         | Read         |

Build order: read the sources, write the one section, verify, gate.

## Initial state / preflight

Checks were not run at authoring; the coordinator's dispatch preflight owns them.

| Command                                           | Expected result / action                                         |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| `git rev-parse HEAD`                              | Record dispatch revision; explain differences from planning SHA. |
| `git status --short`                              | Account for existing edits; preserve unrelated work.             |
| `git diff --stat a0703dd..HEAD -- factory/`       | Revalidate any relevant committed drift.                         |
| `git diff -- factory/`                            | No unaccounted unstaged implementation changes.                  |
| `git diff --cached -- factory/`                   | No unaccounted staged implementation changes.                    |
| `bun --version`                                   | Installed version supports the repository toolchain.             |
| `bun test`                                        | Baseline tests pass; record the actual outcome.                  |
| `bun run lint:ci`                                 | No strict lint errors.                                           |
| `bun run typecheck`                               | No type errors.                                                  |
| `bun run format:check`                            | Baseline formatting passes, including tracked config.            |
| `bun run fallow:ci`                               | Required Fallow gate passes without suppressions.                |
| `git diff --check`                                | No whitespace errors.                                            |

Relevant drift requires refreshed scoping, not a reset. Baseline/configuration failures are
coordinator-owned blockers. Do not expand worker edit scope or claim preflight passed without
logs.

## Done when

- [x] `factory/README.md` has the `## Chronicle a landed ticket` section covering the selection
  rule, the exact boilerplate paragraph, the chronicler contract, and publish/close-out.
- [x] Every path, field, and file name the section asserts was verified against the source by
  the worker's own commands, named in the report.
- [x] The section's lines stay within 100 columns and `bash factory/checks.sh guard` passes.
- [x] The exact clean candidate passes the full gate and the required cold post-graft review.
- [x] Changes stay within the agreed edit path; the original worker retains repair ownership.
