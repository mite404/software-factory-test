export type Actor = "computer" | "model" | "foreman" | "operator";

/** Ordered pipeline badges shared by status, dashboard and fixture feeds. */
export const pipelineSteps = [
  { id: "worktree", label: "worktree", actor: "computer" },
  { id: "setup", label: "setup", actor: "computer" },
  { id: "builder", label: "builder thread", actor: "model" },
  { id: "report", label: "report.json", actor: "model" },
  { id: "gate", label: "gate · 10 min cap", actor: "computer" },
  { id: "review", label: "cold review", actor: "model" },
  { id: "merge", label: "ff-merge", actor: "computer" },
] as const satisfies readonly { id: string; label: string; actor: Actor }[];
