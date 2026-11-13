import { readFile } from "node:fs/promises";
import type { ThreadID } from "./persistence";

export type Review = {
  ticket: string;
  attempt: number;
  revision: string;
  base: string;
  stage: "post-graft";
  worktree: string;
  model: `${string}/${string}`;
  report: string;
  log: string;
  command: string;
  delivery: "creating" | "queued" | "sending" | "sent";
  thread?: ThreadID;
  evidence?: string;
};

/** Validate persisted review ownership at the storage boundary. */
export function validReview(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    [
      "ticket",
      "revision",
      "base",
      "worktree",
      "model",
      "report",
      "log",
      "command",
    ].every((key) => typeof row[key] === "string" && row[key].length > 0) &&
    Number.isSafeInteger(row.attempt) &&
    Number(row.attempt) > 0 &&
    row.stage === "post-graft" &&
    new Set<unknown>(["creating", "queued", "sending", "sent"]).has(
      row.delivery,
    ) &&
    (row.delivery === "creating"
      ? row.thread === undefined
      : typeof row.thread === "string" && /^T-.+/.test(row.thread)) &&
    (row.evidence === undefined || typeof row.evidence === "string")
  );
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Read a structured verdict; unavailable or invalid evidence never authorizes landing. */
export async function reviewVerdict(review: Review) {
  try {
    const raw: unknown = JSON.parse(await readFile(review.report, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    if (
      !["ticket", "attempt", "revision", "base", "stage"].every(
        (key) => row[key] === review[key as keyof Review],
      ) ||
      !new Set<unknown>(["pass", "issues"]).has(row.kind) ||
      !Array.isArray(row.findings)
    )
      return null;
    const findings = row.findings;
    if (
      !findings.every((finding: unknown) => {
        if (!finding || typeof finding !== "object") return false;
        const item = finding as Record<string, unknown>;
        return (
          new Set<unknown>(["critical", "warning", "nit"]).has(item.severity) &&
          ["location", "evidence", "correction"].every((key) =>
            nonempty(item[key]),
          )
        );
      }) ||
      (row.kind === "pass" ? findings.length !== 0 : findings.length === 0)
    )
      return null;
    return { kind: row.kind, evidence: JSON.stringify(row) };
  } catch {
    return null;
  }
}

/** Build a cold pstack review contract, without implementation-thread or prior-review context. */
export function reviewPrompt(review: Review, requirements: string) {
  return `You are an independent adversarial code reviewer, not an implementation worker.
Read only the actual diff and relevant callers/types in ${review.worktree}, and the requirements below.
Inspect git diff ${review.base} ${review.revision}. Stage: ${review.stage}.
Requirements: ${requirements}
Coordinator gate evidence: ${review.command} passed for revision ${review.revision}; log ${review.log}.
Stress-test correctness, root causes, structural integrity, verification, complexity and security.
Follow call chains and cite concrete locations and evidence. Distinguish bugs from preference.
Do not force findings, pad nits, or block on unsupported style opinions. An empty review is valid.
Do not read worker threads, worker reports, self-reviews, or other reviewer opinions.
Do not edit code, commit, delegate, push, deploy or control the factory.
Your only permitted write is ${review.report}, a JSON verdict:
${JSON.stringify({ ticket: review.ticket, attempt: review.attempt, revision: review.revision, base: review.base, stage: review.stage, kind: "pass | issues | blocked", findings: [{ severity: "critical | warning | nit", location: "file:line", evidence: "concrete problem and why", correction: "actionable correction" }] })}
Use kind pass with findings [] when there are no supported issues. Narrative text or idle state is not a verdict.`;
}
