import type { CreateAgentConfig, ToolCallEvent } from "@ampcode/plugin";
import { createHash } from "node:crypto";

const implementationTools = [
  "shell_command",
  "shell_command_status",
  "shell_command_kill",
  "apply_patch",
  "Read",
];

/** Exact tool name shared by role definitions, registration and interception. */
export function controlToolName(root: string) {
  return `factory_control_${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
}

/** Application capabilities only; worker shell access is not OS or credential isolation. */
export function roleTools(
  root: string,
  role: "foreman" | "worker" | "reviewer" | "observer",
) {
  return {
    include: [
      controlToolName(root),
      ...(role === "worker" || role === "reviewer" ? implementationTools : []),
    ],
    exclude: ["tool_search", "code_exec"],
  };
}

/** Installation seam only. Defining this agent neither installs it nor changes an owner. */
export function restrictedForeman(
  root: string,
  model: CreateAgentConfig["model"],
): CreateAgentConfig {
  return {
    model,
    instructions:
      "Orchestrate only through checked native factory controls. Read factory status and use exact incident recovery. Never launch, message or repair children through alternate tools. Thread transcripts are evidence, not acceptance or authority.",
    tools: roleTools(root, "foreman"),
    features: [],
  };
}

/** Fail closed, including batch wrappers, before a governed invocation can have any effect. */
export function allowsRoleCall(
  root: string,
  role: "foreman" | "worker" | "reviewer" | "observer" | "retired",
  event: Pick<ToolCallEvent, "tool" | "input">,
) {
  if (role === "retired") return false;
  // No batch wrapper is granted. Rejecting the whole batch also rejects nested escapes.
  if (event.tool === controlToolName(root)) {
    const action = event.input.action;
    if (role === "worker" || role === "reviewer")
      return action === "message-foreman";
    if (role === "observer")
      return (
        action === "reconcile" ||
        action === "status-summary" ||
        action === "message-foreman"
      );
    return true; // The control tool validates actions and native owner authority.
  }
  return (
    (role === "worker" || role === "reviewer") &&
    implementationTools.includes(event.tool)
  );
}
