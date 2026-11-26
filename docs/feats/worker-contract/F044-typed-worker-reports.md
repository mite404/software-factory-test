# F044-typed-worker-reports

## Status

- Goal: parse every worker report once, against one typed contract, where it enters the factory.
- Outcome: Malformed worker reports go back to the same worker instead of stalling the queue
- Initial priority: P1
- Effort: Small
- Risk: risky; the parser sits on the acceptance path, and a wrong parse could accept or drop a
  candidate.
- Depends on: none.
- Planned at: `6eda5a9845dd02a62e50afff7c0c4a71de7ddc7f`, 2026-11-26.
- Local path: `docs/feats/worker-contract/F044-typed-worker-reports.md`

## Why this matters

The worker report is the only typed hand-off from a worker to the factory, but its contract exists
only as prose in the worker brief. Each consumer checks the fields it happens to read, so a bad
report fails late and far from its cause. A missing `insight` becomes `""` at acceptance, and the
ticket's dependents then stall at admission with `dependency insight: <id>` until someone runs
`record-insight`.

## Current state

At `6eda5a9`:

- The brief states the contract as an inline JSON example (`factory/native.ts:2500`), and
  `factory/native.test.ts:423` asserts that brief string byte for byte.
- `currentReport` (`native.ts:1844-1849`) does `object(JSON.parse(...))` and returns the report
  only when `report.attempt === attempt`. A non-numeric `attempt` (for example `"1"`) is ignored
  forever, which looks like a running worker until the 30-minute suspicion nudge. Invalid JSON
  throws out of reconcile.
- Callers: `native.ts:2974` (pre-upgrade repair, `?? {}`), `3008` (preflight `blocked`), `3900`
  (post-review acceptance), `3974` (settle).
- Field checks are scattered: `kind` at `3976`/`3989` (anything else throws the generic
  "Invalid worker report"), `reason` through `text()` at `3981`, `insight` falls back to `""` at
  `3489`, `summary` through `publicSummary` at `3492`, `revision` compared to HEAD at `2983` and
  in `candidate()`.
- `rejectedBy` is `"gate" | "review" | "merge"` (`persistence.ts:218`), mapped to stop reasons in
  `rejectionReasons` (`persistence.ts:148`). `factory/pipeline.ts:8` already names a `report` step
  with actor `model`.

Observed contract: the four real reports from the F041-F043 runs. They live in the coordinator
orb at `.amp/in/orb-backup/factory-enforcement-run/repo/.git/factory/` as
`enforce-human-capped-resume`, `F041-merge-proof-paths`, `F042-restricted-foreman-tools` and
`F043-installed-policy-identity` `.report.json`, 530-817 bytes each. All four have exactly
`attempt` (number), `kind: "candidate"`, `revision` (40 hex), `insight` (string) and `summary`
(string). No real `blocked` report has been observed; the brief is the only source for that shape.

## Approach

Replace `currentReport`'s untyped object with one parser that returns
`null` (no file, or a well-formed report for another attempt),
`{ kind: "candidate", attempt, revision, insight, summary? }`,
`{ kind: "blocked", attempt, reason }`, or a malformed result that names the bad field. Every
caller reads the typed result, so the scattered checks and the `insight` fallback go away. The
brief's JSON example is generated from the same module, so prompt and parser cannot drift.

A malformed report for the current attempt goes back to the same worker as repair feedback that
names the field, through the existing rejection path with a new `rejectedBy: "report"`. It never
throws out of reconcile and never accepts. There is no `failed` kind: the gate decides failure,
not the worker.

## Scope

- In: the parser, its callers, the brief example, `rejectedBy: "report"` and its stop reason,
  tests, and the README's worker-report contract.
- Out: changing what workers are asked to write, report storage location, or gate and review
  behavior.
- Out: the coordinator's queue and runtime records; setup failures return to the coordinator.

## Steps

1. **Parse reports at entry**. Make `currentReport` return a typed union: required nonempty
   `insight` and `reason`, 40-hex `revision`, integer `attempt`, optional `summary`; ignore and
   do not persist unknown keys; keep the existing 1000-character `insight` cap.
2. **Route malformed reports to repair**. Send a malformed current-attempt report, including
   invalid JSON or a non-integer `attempt`, to the same worker through the rejection path with
   `rejectedBy: "report"` and feedback naming the field; delete the per-caller checks.
3. **Generate the brief example**. Build the brief's report JSON from the same module as the
   parser so `native.test.ts:423` still passes unchanged, or update that assertion only if the
   text must change.
4. **Prove with real reports**. Add the four real reports verbatim as test fixtures and show they
   parse to accepted candidates.

Illustrative queue entry, not authorization to change the coordinator queue or dispatch work.

```json
{
  "id": "F044-typed-worker-reports",
  "brief": "Implement docs/feats/worker-contract/F044-typed-worker-reports.md",
  "after": [],
  "size": "small",
  "risky": true,
  "steps": [
    "Parse reports at entry",
    "Route malformed reports to repair",
    "Generate the brief example",
    "Prove with real reports"
  ]
}
```

## Test plan

- The four real reports, copied byte for byte, each parse and reach acceptance through the
  existing native lifecycle test path.
- A `blocked` report built from the brief's own example parses to `blocked` with its reason.
- Malformed reports that today stall or throw are each returned to the same worker, naming the
  field, with attempt unchanged before the rejection and the thread unchanged: missing `insight`,
  empty `insight`, `attempt: "1"`, a 39-hex `revision`, `kind: "failed"`, invalid JSON.
- A well-formed report for an older attempt is still ignored, not rejected.
- An extra unknown key does not reject and does not appear in persisted state or the feed.
- No accepted run ends with an empty `insight` from a parsed report.
- Full configured gate and the required cold post-graft review on the exact candidate.

## Why this approach?

- Without this structure: each consumer validates only what it reads. Bad reports either throw
  out of reconcile, sit unread as a fake "running" worker, or accept with an empty insight that
  blocks dependents later. The repeat-mistakes rule "code against the observed contract" stays
  review-only.
- This buys: one entry point owns the contract, so the brief, the parser, and the tests share one
  source, and a worker's mistake costs that worker one repair instead of a Foreman diagnosis.

## Files You'll Touch

| Path                           | Role              | Contains                               | Edit or Read |
| ------------------------------ | ----------------- | -------------------------------------- | ------------ |
| `factory/native.ts`            | Coordinator       | Parser, callers, brief example         | Edit         |
| `factory/persistence.ts`       | Durable types     | `rejectedBy`, `rejectionReasons`       | Edit         |
| `factory/native.test.ts`       | Lifecycle proof   | Real-report fixtures, malformed cases  | Edit         |
| `factory/lanes.test.ts`        | Lane proof        | Report writes in two-lane runs         | Read         |
| `factory/review.test.ts`       | Review proof      | Report writes before review            | Read         |
| `factory/dashboard.ts`         | Feed              | Rejection reason projection            | Read         |
| `web/derive.ts`                | Reason sentences  | Fixed sentence per stop reason code    | Edit         |
| `factory/README.md`            | Operator contract | Worker report fields and failures      | Edit         |

Build order: parser and its unit cases, callers and rejection routing, brief generation, then
fixtures, reason sentence and README. `web/derive.ts` needs only the new reason's sentence.

## Initial state / preflight

Not run while authoring. The coordinator runs these before dispatch.

| Command                                                  | Expected result / action                        |
| -------------------------------------------------------- | ----------------------------------------------- |
| `git rev-parse HEAD`                                     | Record; explain drift from `6eda5a9`.           |
| `git status --short`                                     | Account for existing edits; preserve them.      |
| `git diff --stat 6eda5a9..HEAD -- factory/ web/derive.ts` | Revalidate the line numbers above.             |
| `ls <factory dir>/*.report.json`                         | The four real reports are present to copy.      |
| `bun install --frozen-lockfile`                          | Succeeds.                                       |
| `bun run lint:ci && bun run typecheck`                   | No errors.                                      |
| `bun run format:check`                                   | Passes.                                         |
| `bun test`                                               | Baseline passes; record the count.              |
| `bun run fallow:ci`                                      | Passes without suppressions.                    |

The coordinator must give the worker the four real reports, for example by copying them into the
worktree's test fixtures before dispatch, because the worker cannot read the private factory
directory.

## Done when

- [ ] `currentReport` returns a typed union and no caller reads untyped report fields.
- [ ] Each malformed case in the test plan goes back to the same worker with feedback naming the
      field, and none throws out of reconcile or accepts.
- [ ] The four real reports, copied verbatim, are committed fixtures that parse and accept.
- [ ] The brief's report example comes from the parser's module.
- [ ] The exact clean candidate passes the full gate and required cold post-graft review.
