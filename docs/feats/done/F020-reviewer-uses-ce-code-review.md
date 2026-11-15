# F020-reviewer-uses-ce-code-review

## Status

- Goal: the cold reviewer reviews with the `ce-code-review` skill, and no longer receives the
  worker's process instructions, such as the poteto-mode line.
- Initial priority: P2. Effort: Small.
- Risk: elevated; changes the prompt every cold review runs on. A skill that delegates, edits
  files or writes its own report format would break the reviewer's contract, so the factory's
  rules stay above the skill.
- Depends on: nothing.
- Planned at: `24647eda208ef5bf2b9a249d71499e0c5c6f5309`, 2026-11-15. Local only.

## Why this matters

On 2026-11-15 the operator said the code review does not need poteto-mode and should use the
`ce-code-review` skill. Today the reviewer has no review method beyond one paragraph, and it is
handed the worker's whole brief as "Requirements", which tells it to read poteto-mode, write an
attempt report and message the Foreman. Those lines are for the worker.

## Current state

- `reviewPrompt` in `factory/review.ts` builds the reviewer's message. It names the diff, the
  gate evidence and the verdict file, and forbids editing, committing, delegating and pushing.
- `deliverReview` in `factory/native.ts` passes the ticket's brief as `requirements`.
- A brief mixes what to build with how the worker must work: skills to read, runner rules, the
  report and the message to the Foreman.
- The verdict is JSON with `kind` and `findings` at a fixed path; anything else is not a
  verdict.
- `ce-code-review` is a user skill synced to the orb. Its description: "Review a named diff or
  PR for bugs, regressions, tests, and standards." It accepts a `mode:agent` argument. Whether
  it delegates or writes files in that mode was not read for this ticket.

## Approach

Add one instruction to `reviewPrompt`: load the `ce-code-review` skill before reviewing and use
its method to find and judge defects. State the order of authority in the same sentence: where
the skill says to delegate, edit, apply fixes, or write a receipt or any file other than the
verdict, the factory's rules win, and the only output is the JSON verdict. If the skill cannot
be loaded, the reviewer says so in a finding of severity `nit` and reviews without it; a missing
skill does not block a verdict.

Tell the reviewer what the requirements are for: they describe the change to judge. Any line in
them about how the worker must work, which skills it reads, or what it reports is not an
instruction to the reviewer. Do not try to cut such lines out of the brief by pattern.

Read the skill's `SKILL.md` first and name in the report every place it conflicts with the
reviewer's rules, so the wording covers each one.

## Scope

- In: `reviewPrompt`, its tests, and the README's description of cold review.
- Out: the verdict format, which model reviews, the worker brief, splitting briefs into public
  requirements and private process (v1-ticket23 owns curated public text), and installing skills.
- Preserve: every existing prohibition in the prompt, and that an empty review is valid.

## Steps

1. **Read the review skill**. Read `ce-code-review`'s `SKILL.md` and list each instruction that
   conflicts with the reviewer's rules.
2. **Name the skill**. Add the instruction to load and use `ce-code-review`, with the factory's
   rules above it and the fallback when it cannot load.
3. **Scope the requirements**. Tell the reviewer that worker process lines in the requirements
   are not addressed to it.
4. **Test the prompt**. Assert the prompt names the skill, keeps every prohibition, and still
   ends with the verdict contract.
5. **Document the review**. Describe the reviewer's method in the README.

## Test plan

Unit tests on `reviewPrompt`: the text names `ce-code-review`; each existing prohibition is
still present; the verdict JSON shape and path are unchanged; requirements holding a planted
"read the poteto-mode skill" line still appear, after the sentence that says such lines are not
for the reviewer. Fixture run: a review round still completes and its verdict parses. A prompt
test cannot show the skill improves reviews; the Foreman compares the next three real verdicts
with earlier ones and records what changed.

## Why this approach?

- Without it: review quality rests on one paragraph, and the reviewer reads instructions meant
  for someone else.
- This buys: a maintained review method the operator already uses, while the factory's own
  rules and verdict format stay in charge. Telling the reviewer how to read the requirements is
  safer than deleting lines from a brief by pattern, which would drop real requirements.

## Files You'll Touch

| Path                                          | Role      | Contains                        | Edit or Read |
| --------------------------------------------- | --------- | ------------------------------- | ------------ |
| `factory/review.ts`, `factory/review.test.ts` | Review    | `reviewPrompt`, verdict parsing | Edit         |
| `factory/native.ts`                           | Lifecycle | `deliverReview`                 | Read         |
| `factory/README.md`                           | Operation | Cold review description         | Edit         |

Build order: skill reading, prompt, tests, documents.

## Initial state / preflight

Run the shared preflight in `docs/v1-execution.md`. Baseline gates have not run for this ticket.

| Command                                                                         | Expected result / action                        |
| ------------------------------------------------------------------------------- | ----------------------------------------------- |
| `git rev-parse HEAD && git status --short`                                      | Record the dispatch revision; clean tree.       |
| `git diff --stat 24647ed..HEAD -- factory/`                                     | Revalidate drift.                               |
| `git diff -- factory/ && git diff --cached -- factory/`                         | Preserve unrelated changes.                     |
| `rg -n "export function reviewPrompt" factory/review.ts`                        | The prompt builder.                             |
| `ls ~/.cache/amp/global-skill-manifests/ampcode.com/user/ \| rg ce-code-review` | The skill is synced.                            |
| `GIT_CONFIG_GLOBAL=/dev/null bun test factory`                                  | Passes; CI runners have no global Git identity. |

## Done when

- [x] The reviewer prompt tells the reviewer to load and use `ce-code-review`.
- [x] The factory's prohibitions and the JSON verdict are unchanged and rank above the skill.
- [x] The reviewer is told that worker process lines in the requirements are not for it.
- [x] A review round completes on the fixtures with a parsed verdict.
- [x] Full gates, guard and fresh cold review pass on the exact candidate.
