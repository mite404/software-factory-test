import { createHash } from "node:crypto";

type BlockedReport = { kind: "blocked"; attempt: number; reason: string };

type CandidateReport = {
  kind: "candidate";
  attempt: number;
  revision: string;
  insight: string;
  summary?: string;
};

type MalformedReport = {
  kind: "malformed";
  field:
    | "JSON"
    | "report"
    | "attempt"
    | "kind"
    | "revision"
    | "insight"
    | "summary"
    | "reason";
};

type ParsedReport =
  | (CandidateReport & { legacyDigest: string })
  | BlockedReport
  | MalformedReport;

/** Build the two JSON examples included in a worker's brief. */
export function workerReportExamples(attempt: number) {
  const candidate = {
    attempt,
    kind: "candidate",
    revision: "<full git HEAD>",
    insight: "<short verified finding>",
    summary: "<optional public line>",
  } satisfies Required<CandidateReport>;
  const blocked = {
    attempt,
    kind: "blocked",
    reason: "<needed decision>",
  } satisfies BlockedReport;
  return {
    candidate: JSON.stringify(candidate),
    blocked: JSON.stringify(blocked),
  };
}

function candidateReport(
  fields: Record<string, unknown>,
  attempt: number,
): ParsedReport {
  const { revision, summary } = fields;
  const insight =
    typeof fields.insight === "string" ? fields.insight.slice(0, 1000) : "";
  if (typeof revision !== "string" || !/^[a-f0-9]{40}$/i.test(revision))
    return { kind: "malformed", field: "revision" };
  if (!insight.trim()) return { kind: "malformed", field: "insight" };
  if (summary !== undefined && typeof summary !== "string")
    return { kind: "malformed", field: "summary" };
  return {
    attempt,
    kind: "candidate",
    revision: revision.toLowerCase(),
    insight,
    ...(summary === undefined ? {} : { summary }),
    // Pre-upgrade gate evidence hashed the original object's keys in their original order.
    legacyDigest: createHash("sha256")
      .update(JSON.stringify(fields))
      .digest("hex"),
  };
}

/** Validate one report. A valid report for a different expected attempt returns null. */
export function parseWorkerReport(
  source: string,
  currentAttempt?: number,
): ParsedReport | null {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return { kind: "malformed", field: "JSON" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { kind: "malformed", field: "report" };
  const fields: Record<string, unknown> = { ...value };
  const { attempt, kind, reason } = fields;
  if (
    typeof attempt !== "number" ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1
  )
    return { kind: "malformed", field: "attempt" };
  const report: ParsedReport =
    kind === "candidate"
      ? candidateReport(fields, attempt)
      : kind === "blocked" && typeof reason === "string" && reason.trim()
        ? { attempt, kind, reason }
        : { kind: "malformed", field: kind === "blocked" ? "reason" : "kind" };
  return report.kind === "malformed" ||
    currentAttempt === undefined ||
    attempt === currentAttempt
    ? report
    : null;
}
