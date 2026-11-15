# F015-weekly-failure-audit

## Status

- Goal: once a week, collect every failed attempt, have Jev classify and rate each finding into
  fixed buckets, and hand the buckets to a Fable thread that audits the factory and the
  architecture of the app it builds.
- Initial priority: P1. Effort: Large. The operator filed this as a major feature and expects it
  to be complex.
- Risk: elevated; review findings leave the orb for a third-party API, and a new secret is read.
- Depends on: nothing unbuilt. The records it reads exist today.
- Planned at: `0b8a74de02ddff893669726f3759de98e19a4ebf`, 2026-11-15. Local only.

## Why this matters

Each rejection is handled alone and then forgotten. On 2026-11-15 two attempts at one ticket
were rejected for the same underlying mistake, a decision derived from the local clock, and
only a person reading both verdicts would see that. Repeated failures in one area are evidence
about the architecture, not about one worker. The operator asked for a weekly pass that makes
those patterns visible and audits against them.

## Current state

- Every cold review writes a verdict file in the private factory directory:
  `<ticket>-<attempt>-<revision>-post-graft.review.json`, with `kind` and a list of findings.
  Each finding has `severity`, `location`, `evidence` and `correction`.
- The events table records `rejected`, `escalated`, `review-verdict`, `review-stopped` and
  `blocked` with a time and ticket.
- A failed gate writes `<ticket>-<attempt>.log`. F008 turns its failure into a bounded excerpt.
- Nothing reads these records across tickets or keeps a category for them.
- Jev is TypeSafe's classification model. One request sends a `state` and a set of typed
  questions to `POST https://api.typesafe.ai/v1/systemone` with a bearer key, and returns one
  answer per question: `choice` with probabilities and confidence, `score` on an ordered
  rubric, or `noul`, the probability a statement is true. Questions are evaluated independently
  in one request. The service asks for backoff on `429` and `529`.
- The key is the project secret `JEV_API_KEY`. The TypeSafe SDK reads `TYPESAFE_API_KEY` by
  default, so the name is passed explicitly.

## Approach

Add one script, `factory/audit.ts`, with three stages.

**Collect.** Read verdict files and failure events from the last seven days, read-only. Produce
one record per finding with its ticket, attempt, revision, severity, location, evidence and
correction. A failed gate becomes one record carrying its excerpt.

**Classify.** Send each record to Jev as the state, in one request per record, with these
questions:

- a Choice for the area, from a fixed list kept in the script: lifecycle and recovery,
  persistence, time and clocks, delivery and idempotency, scheduling and watchdog, public
  projection and privacy, dashboard, tests and fixtures, documentation;
- a Choice for the kind of mistake: missing case, wrong assumption about an outside system,
  regression of working behavior, untested claim, misread requirement;
- a Choice for the layer the fix belongs in: record types, lifecycle rules, adapter, projection,
  page, test;
- a Score for impact on an ordered rubric from cosmetic to data loss or a stopped factory;
- a Noul for "none of the listed areas fits this finding".

Code decides the bucket: a record whose area confidence is under a threshold, or whose
none-fits probability is high, goes to an `unsorted` bucket instead of a guess. The thresholds
are named constants.

**Report.** Write a dated ledger to the private factory directory with every record, its
answers and probabilities, and a summary per bucket: count, tickets, mean impact and the files
named most often. Print the Fable brief: the summary, the ledger path and the instruction to
audit the buckets against the code and report which boundaries or concepts keep failing, with
evidence.

The Foreman runs the script weekly, starts one thread on `anthropic/claude-fable-5-2` with the
printed brief, and commits the returned report under `docs/audits/<date>.md`. The script
creates no thread and installs no schedule.

Call the API with `fetch`; no dependency is added. Retry `429` and `529` with backoff, a bounded
number of times. A record that cannot be classified is kept as `unsorted` with the reason, so
one failed request does not lose the week.

## Scope

- In: the script, its tests, the bucket lists, README and foreman.md.
- Out: starting the Fable thread or a schedule from code, acting on audit results, classifying
  transcripts, and changing review or acceptance.
- Out: sending anything but finding text to the API. Briefs, worker transcripts, secrets and
  full logs stay local.
- Preserve: factory state and verdict files are only read.

## Steps

1. **Collect the week's failures**. Read verdicts, failure events and gate excerpts for a date
   range into finding records, without writing to factory state.
2. **Classify with Jev**. Build the request for one record, send it with bounded backoff, and
   validate the typed answers.
3. **Bucket by confidence**. Assign each record to a bucket in code, sending low-confidence and
   none-fits records to `unsorted`.
4. **Write ledger and brief**. Write the dated ledger and print the Fable brief with the bucket
   summary.
5. **Prove one live run**. Run the script against the real records of the past week with the
   real key, and record the buckets it produced in workflow trials.
6. **Document the weekly pass**. Describe the Foreman's weekly steps, what leaves the orb, and
   the secret in the README and foreman.md.

## Test plan

With fixture verdict files and a real SQLite events table: the collector returns one record per
finding inside the range and none outside it, and leaves the state file's bytes unchanged. With
a stubbed `fetch`: the request holds only the finding text and the fixed questions; a `429`
followed by success classifies the record; repeated failure yields `unsorted` with a reason; a
low-confidence area and a high none-fits answer both yield `unsorted`; a malformed answer is
rejected at the boundary. The key never appears in the ledger, the brief or any thrown error. A
missing key stops the script before any request, with a message naming the variable.

## Why this approach?

- Without it: the same mistake is repaired ticket by ticket and its cause is never named. An
  LLM asked to sort a week of findings in one prompt returns prose that drifts between weeks.
- This buys: fixed buckets and typed answers make one week comparable with the next, and the
  probabilities let code refuse a weak classification instead of trusting it. Jev does the
  cheap sorting on each finding alone; Fable is asked the one question that needs reasoning,
  over a summary small enough to read in full. Keeping thread creation with the Foreman leaves
  one owner for every thread the factory starts.

## Files You'll Touch

| Path                      | Role       | Contains                                | Edit or Read |
| ------------------------- | ---------- | --------------------------------------- | ------------ |
| `factory/audit.ts`        | Script     | Collect, classify, bucket, report       | Create       |
| `factory/audit.test.ts`   | Tests      | Fixtures and stubbed `fetch`            | Create       |
| `factory/persistence.ts`  | Records    | Read-only events access                 | Read         |
| `factory/review.ts`       | Exemplar   | Verdict file shape and validation       | Read         |
| `factory/README.md`       | Operations | The weekly pass and what leaves the orb | Edit         |
| `factory/foreman.md`      | Operations | The Foreman's weekly steps              | Edit         |
| `docs/workflow-trials.md` | Evidence   | The live run                            | Edit         |

Build order: collector, request and validation, bucketing, ledger and brief, live run,
documents.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                                 | Expected result / action                        |
| ------------------------------------------------------- | ----------------------------------------------- |
| `git rev-parse HEAD && git status --short`              | Record the dispatch revision; clean tree.       |
| `git diff --stat 0b8a74d..HEAD -- factory/`             | Revalidate drift.                               |
| `git diff -- factory/ && git diff --cached -- factory/` | Preserve unrelated changes.                     |
| `test -n "$JEV_API_KEY" && echo present`                | `present`. Otherwise return to the Foreman.     |
| `ls factory/audit.ts`                                   | Absent.                                         |
| `GIT_CONFIG_GLOBAL=/dev/null bun test factory`          | Passes; CI runners have no global Git identity. |

The worker must not print the key. If it is absent in the worker's environment, that is a
Foreman-owned setup blocker: the secret was added on 2026-11-15 and running processes need a
restart to receive it.

## Done when

- [ ] One command produces a dated ledger and a Fable brief for a date range.
- [ ] Each finding carries an area, mistake kind, layer and impact with probabilities, or is
      `unsorted` with a reason.
- [ ] Only finding text is sent to the API; the key appears in no output.
- [ ] Factory state and verdict files are unchanged by a run.
- [ ] One live run over real records is recorded in workflow trials.
- [ ] Full gates, guard and fresh cold review pass on the exact candidate.

## Notes

- Finding text quotes this repository's code and file names. The operator chose TypeSafe as the
  classifier; this ticket sends findings there and nothing else.
- The bucket lists are a first guess. The first live run will show which buckets are empty or
  overloaded; change the lists in the script, not the approach.
- Jev answers each question in isolation, so the questions are kept narrow. Ranking buckets
  against each other is done in code and by the audit thread.
