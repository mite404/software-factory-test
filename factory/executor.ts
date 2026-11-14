import type { AgentThreadExecutor } from "@ampcode/plugin";

export type Executor = Exclude<AgentThreadExecutor, "orb">;

/** Validate executor records; omission denotes a legacy local thread. */
export function validExecutor(value: unknown): boolean {
  if (value === undefined || value === "local") return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    row.type === "runner" &&
    typeof row.id === "string" &&
    row.id.trim().length > 0 &&
    Object.keys(row).length === 2
  );
}
