---
name: creating-factory-tickets
description: >-
  Creates local factory tickets, optionally paired with Linear. Use when scoping factory backlog
  work or creating a factory feature ticket.
---

# Creating factory tickets

Use this instead of the global create-linear-ticket filing workflow in this project.
It creates local Markdown, optionally one matching Linear issue. It creates no GitHub issue.

## Choose mode and path

Before creating tickets, ask: "Would you like a Linear & local ticket to be created, or local
ticket only? Do you have a preferred local path? Otherwise I'll use
`docs/feats/<name-of-feat>/<name-of-feat-ticket><#>.md`."

An explicit mode/path in the user's request already answers that part. Reuse a choice explicitly
made for the current batch; do not ask per ticket. If no path preference is supplied, use the
default. If the mode is unanswered, wait rather than silently creating an external issue.
Local-only mode needs no Linear connection, GitHub remote, or network calls.

Choose one searchable ticket name, such as `review-policy-ticket1`. The local filename without
`.md`, its H1, and the Linear title must match exactly. The feature directory is `review-policy`.
Use the next unused positive number within the feature directory; inspect existing local tickets
and, in paired mode, existing Linear issues before allocating. Never overwrite a collision.
Keep the Linear identifier in metadata, not as a prefix that makes the two names differ.
Honor a supplied filename; derive the shared title from its stem before creating either artifact.
Leave existing ticket names/locations unchanged unless the user asks for migration.

## Write the local ticket

Read [EXAMPLE.md](EXAMPLE.md) before writing. Use its heading order and table layout; replace
illustrative names, placeholders, commands, and claims with inspected task-specific facts.
Omit Notes only when empty. The example is not a filed ticket or proof that its checks ran.

Inspect actual code and dependencies first. Keep the ticket concise, with these sections:

1. Status: goal, initial priority, Small/Medium/Large effort, risk and blast-radius reason,
   dependencies, actual planned-at revision/date. Scope size is not a duration or risk score.
2. Why this matters, Current state, Approach, Scope, Steps, Test plan.
3. **Why this approach?** Name the concrete failure without this structure and the safety
   property the chosen ownership boundary buys. Keep rationale here rather than repeating Approach.
4. **Files You'll Touch.** Table: Path / Role / Contains / Edit, Create, or Read. Include tests
   and read-only exemplars; explain connections and a leaf-first build order when applicable.
   Distinguish expected files from authoritative edit scope; this table is not a filesystem sandbox.
5. **Initial state / preflight.** Record the planning SHA and relevant paths. Give runnable
   commands with expected results for HEAD, clean/known worktree state, committed drift from the
   planning SHA, unstaged and staged diffs, prerequisites, and actual baseline gates. Mark checks
   not run instead of claiming green. Revalidate expected prerequisite drift; preserve unrelated
   edits. Setup failures return to the coordinator, not an expanded implementation scope.
6. Done when: observable acceptance criteria and full required gates. Notes only when needed.

The three bold execution-contract sections sit immediately before Done when. No quizzes, stubs,
invented interfaces, or teaching appendix. Local-only tickets use local completion tracking;
paired tickets use noninteractive `*` criteria so Linear remains the status owner.

Record authoring facts now; the coordinator must execute preflight before dispatch. Merely writing
commands does not implement deterministic checks, modify factory acceptance, or authorize workers.
Ticket creation does not grant execution, publication, deployment, or permission changes.

## Optional Linear pair

Only after the user chooses paired mode, load create-linear-ticket for its exact project/team
resolution, field mapping, and `scripts/ticket_state.py` helper. This factory skill overrides its
GitHub mirroring workflow, GitHub preflight, and mandatory PR-title requirement. Discover currently
available Linear operations rather than assuming their names. No GitHub issue or link chip.

1. Resolve the actual Linear project/team and existing effort labels. Ask on ambiguity. If Linear
   is unavailable, retain the local draft and report that pairing is pending, not complete.
2. Run the existing ticket_state helper selfcheck. Read local metadata first. A recorded `linear:`
   means retrieve that issue, not create another. Damaged metadata blocks filing until repaired.
3. Before a new create, look up exact project and shared title to reconcile previous partial work.
   Reuse only a verified matching issue; ambiguous matches need a decision. Never guess an ID/URL.
4. Create the issue with exactly the local filename stem/H1 as title and the local ticket's body.
   Map effort and initial priority using the global skill. Do not invent labels or alter status.
5. Immediately save the returned identifier using the existing helper's `write ... --linear`.
   Store no fabricated ID or long URL. No `github:` field is required for this mode.
6. Read the saved local metadata and fetch the Linear issue. Verify identifier, exact title, and
   matching authored body, excluding local filing metadata. Preserve existing remote edits;
   report divergence instead of silently replacing them.

After an uncertain create or failed local save, reconcile the exact project/title before retrying.
On rerun, reuse the same local path and identifier; never allocate another ticket number just to
recover a partial pair. Report local success and Linear failure separately. Later findings append
as Linear comments; do not run the global GitHub-dependent resolve flow on this two-artifact mode.

## Completion checklist

- Mode and path follow the user's choice, or the documented path default.
- Local filename stem equals H1; in paired mode, fetched Linear title equals both.
- All three execution-contract sections precede Done when; claims cite inspected code or evidence.
- Existing files and unrelated changes are preserved; no GitHub issue was created.
- Paired mode has persisted, read-back Linear identity; local-only mode made no external calls.
- Report actual paths, returned Linear link if any, and any incomplete pairing. Do not claim
  coordinator preflight or executable file isolation was added by writing the ticket.
