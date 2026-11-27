import { createHash } from "node:crypto";

const modes = ["bug-finding", "feature-creation", "ui-polish"] as const;
type DiscoveryMode = (typeof modes)[number];
type Policy = { mode: DiscoveryMode; cooldownMs: number };

export type DiscoveryPass = {
  kind: "active";
  id: string;
  mode: DiscoveryMode;
  revision: string;
  prd: string;
  prdDigest: string;
  scope: string[];
  startedAt: number;
  expiresAt: number;
};

export type DiscoveryOutcome =
  | { kind: "expired" | "exhausted" | "evidence-unavailable" }
  | { kind: "investigation"; path: string; question: string }
  | { kind: "duplicate" | "admitted"; ticket: string };

function fields(value: unknown, allowed: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a discovery object");
  const row: Record<string, unknown> = Object.fromEntries(
    Object.entries(value),
  );
  if (Object.keys(row).some((key) => !allowed.includes(key)))
    throw new Error("Unsupported discovery field");
  return row;
}

/** Parse opt-in discovery against the existing authored mode field. @throws On invalid policy. */
export function discoveryPolicy(
  value: unknown,
  mode: unknown = "bug-finding",
): Policy | undefined {
  if (value === undefined) return;
  const { cooldownMs } = fields(value, ["cooldownMs"]);
  const selected = modes.find((candidate) => candidate === mode);
  if (
    !selected ||
    typeof cooldownMs !== "number" ||
    !Number.isSafeInteger(cooldownMs) ||
    cooldownMs < 1 ||
    cooldownMs > 604_800_000
  )
    throw new Error("Invalid discovery mode or cooldownMs");
  return { mode: selected, cooldownMs };
}

/** Validate the discovery policy on an immutable loaded definition. */
export function validDiscoveryPolicy(value: unknown) {
  if (value === undefined) return true;
  try {
    const { mode, cooldownMs } = fields(value, ["mode", "cooldownMs"]);
    return mode !== undefined && !!discoveryPolicy({ cooldownMs }, mode);
  } catch {
    return false;
  }
}

/** Test a file against the same exact-file / directory-prefix convention used by candidate gates. */
export function withinDiscoveryScope(path: string, scope: readonly string[]) {
  return scope.some(
    (prefix) =>
      path === prefix || (prefix.endsWith("/") && path.startsWith(prefix)),
  );
}

function summary(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    value.length > 500 ||
    !value.trim() ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
  )
    throw new Error(`Missing or invalid discovery ${label}`);
  return value;
}

function evidencePath(
  value: unknown,
  pass: DiscoveryPass,
  tracked: (path: string) => boolean,
) {
  if (
    typeof value !== "string" ||
    value.length > 240 ||
    !/^[\w.-]+(?:\/[\w.-]+)*$/u.test(value) ||
    value.split("/").some((part) => part === "." || part === "..") ||
    !withinDiscoveryScope(value, pass.scope) ||
    !tracked(value)
  )
    throw new Error(
      "Discovery requires an in-scope regular file at the pinned revision",
    );
  return value;
}

const common = [
  "kind",
  "key",
  "path",
  "problem",
  "acceptance",
  "observation",
  "duplicate",
];
const evidenceFields = {
  "bug-finding": [
    "expected",
    "affectedUsers",
    "blastRadius",
    "fixScope",
    "bugType",
    "confidence",
    "priority",
    "blockers",
  ],
  "feature-creation": ["prdLine", "userStory"],
  "ui-polish": ["state", "rendering", "uiType"],
};

function bugEvidence(row: Record<string, unknown>) {
  const { bugType, confidence, priority, blockers } = row;
  if (
    confidence !== "reproduced" ||
    !["functional", "accessibility", "cosmetic"].some(
      (type) => type === bugType,
    )
  )
    throw new Error(
      "Implementation needs a reproduced repository defect; security and hypotheses are investigations only",
    );
  if (!["P0", "P1", "P2", "P3"].some((level) => level === priority))
    throw new Error("Discovery requires a confirmed priority");
  if (
    bugType === "cosmetic" &&
    ["P0", "P1"].some((level) => level === priority)
  )
    throw new Error("Cosmetic findings cannot use urgent bug priority");
  if (!Array.isArray(blockers) || blockers.length !== 0)
    throw new Error(
      "Blocked findings stay investigations, regardless of priority",
    );
  return [
    "expected",
    "affectedUsers",
    "blastRadius",
    "fixScope",
    "bugType",
    "priority",
  ]
    .map((key) => `${key}: ${summary(row[key], key)}`)
    .join("\n");
}

function modeEvidence(
  pass: DiscoveryPass,
  row: Record<string, unknown>,
  prd: (line: number) => string | undefined,
) {
  if (pass.mode === "bug-finding") return bugEvidence(row);
  if (pass.mode === "feature-creation") {
    const line = row.prdLine;
    const requirement =
      typeof line === "number" &&
      Number.isSafeInteger(line) &&
      line > 0 &&
      prd(line);
    if (!requirement)
      throw new Error(
        "Discovery needs a nonempty PRD line at the pinned revision",
      );
    return `PRD line ${line}: ${requirement}\nUser story: ${summary(row.userStory, "userStory")}`;
  }
  const uiType = ["accessibility", "cosmetic", "interaction"].find(
    (type) => type === row.uiType,
  );
  if (!uiType) throw new Error("Invalid UI finding type");
  return `UI type: ${uiType}\nState: ${summary(row.state, "state")}\nRendered evidence: ${summary(row.rendering, "rendering")}`;
}

/** Validate one owner-attested result. Evidence is data, never a command to execute. @throws On unsupported, incomplete or out-of-scope evidence. */
export function discoveryFinding(
  value: unknown,
  pass: DiscoveryPass,
  source: {
    tracked: (path: string) => boolean;
    prd: (line: number) => string | undefined;
  },
) {
  const { kind } = fields(value, [
    ...common,
    ...evidenceFields[pass.mode],
    "question",
    "category",
    "blastRadius",
  ]);
  if (kind === "exhausted" || kind === "evidence-unavailable") {
    emptyResultEvidence(value, kind);
    return { kind } as const;
  }
  if (kind === "investigation") {
    const row = fields(value, [
      "kind",
      "path",
      "question",
      "category",
      "blastRadius",
    ]);
    const path = evidencePath(row.path, pass, source.tracked);
    const question = summary(row.question, "question");
    if (row.category === "defensive-security")
      return {
        kind,
        path,
        question: `Defensive security: ${question} Affected scope: ${summary(row.blastRadius, "blastRadius")}`,
      } as const;
    if (row.category !== undefined || row.blastRadius !== undefined)
      throw new Error("Invalid investigation category");
    return { kind, path, question } as const;
  }
  if (kind !== "work") throw new Error("Invalid discovery result");
  const row = fields(value, [...common, ...evidenceFields[pass.mode]]);
  const path = evidencePath(row.path, pass, source.tracked);
  if (
    typeof row.key !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.key) ||
    row.key.length > 80
  )
    throw new Error("Discovery requires a stable finding key");
  if (
    typeof row.duplicate !== "string" ||
    !/^[\w-]{1,128}$/.test(row.duplicate)
  )
    throw new Error("Duplicate check must name an existing ticket or 'none'");
  const problem = summary(row.problem, "problem");
  const acceptance = summary(row.acceptance, "acceptance");
  const observation = summary(row.observation, "observation");
  const evidence = modeEvidence(pass, row, source.prd);
  const digest = createHash("sha256")
    .update(JSON.stringify([path, row.key]))
    .digest("hex");
  return {
    kind: "work" as const,
    duplicate: row.duplicate,
    task: {
      id: `discovery-${digest}`,
      intake: "admitted" as const,
      outcome: "Resolve a local repository quality finding",
      brief: [
        `Local repository quality only (${pass.mode}) at ${pass.revision}.`,
        `Problem: ${problem}`,
        `Observation: ${observation}`,
        evidence,
        `Scope: ${path} only. No exploitation, network probes, external filing or rollout.`,
        "Dependencies: none. Verification: use the pinned repository gate and check the observed behavior locally.",
        `Acceptance: ${acceptance}`,
      ].join("\n"),
      after: [],
      lessonScope: [path],
      discoveryPath: path,
      risky: row.bugType === "accessibility" || row.uiType === "accessibility",
    },
  };
}

function emptyResultEvidence(
  value: unknown,
  kind: "exhausted" | "evidence-unavailable",
) {
  if (kind === "evidence-unavailable") {
    fields(value, ["kind"]);
  } else {
    const row = fields(value, ["kind", "observation"]);
    summary(row.observation, "completed inspection observation");
  }
}
