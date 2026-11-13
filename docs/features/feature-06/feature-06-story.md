# Feature 06: conditional cold post-graft review

As an operator, I can send risky or retried integration candidates to an independent adversary,
so green commands alone do not approve work that needs judgment, without reviewing every branch.

## Acceptance criteria

1. Run the full configured quality gate. Failure returns diagnostics to the original worker.
   A small, low-risk first attempt that passes needs no model review.
2. Ticket scoping records Small/Medium/Large effort separately from a blast-radius risk reason.
   With review enabled, medium/large scope, elevated blast radius, or any retry receives exactly
   one cold post-graft adversarial review of its exact integration candidate. Unrated scope also
   requires review rather than silently claiming low risk.
   There is no pre-graft review and no model call just to classify risk.
3. An OpenAI implementation worker gets `anthropic/claude-fable-5-2` at high effort; an Anthropic
   worker gets `openai/gpt-6-astra` at high effort. Unsupported providers fail visibly.
4. Review input contains requirements, code/base, and neutral coordinator gate evidence only.
   Never relay worker-thread context, rationale, self-review, or prior reviewer opinions.
5. Apply pstack's concrete evidence-backed finding contract. An empty review can pass; issues
   return to the same implementation thread and worktree. A repair reruns the complete gate and
   receives a fresh post-graft review before acceptance and dependent dispatch.
6. Missing, malformed, stale, blocked, failed, or unavailable review evidence never authorizes
   acceptance. A changed candidate or integration base invalidates approval.
7. Reloads preserve review ownership and delivery state without duplicate creation, corrective
   messages, or acceptances. Ambiguous external effects remain parked for reconciliation.
8. Existing installs without review retain their documented behavior. Setup exposes the policy
   explicitly, and refresh never silently changes saved operator configuration.

## Boundary

One implementation owner per ticket. One sequential cold reviewer per required candidate, not a
panel. The integrator prepares the post-graft artifact in an isolated integration branch/worktree
and withholds final acceptance until any required review passes. Fast-forward grafts need no fake
merge commit. No remote writes, provisioning, main merge, deployment, or worker retirement.
