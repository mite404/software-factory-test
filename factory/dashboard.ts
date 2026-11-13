import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

export type DashboardSnapshot = {
  project: string;
  observedAt: string;
  enabled: boolean;
  tasks: {
    id: string;
    title: string;
    status: "working" | "idle" | "blocked" | "queued" | "accepted" | "unknown";
    thread: string | null;
    revision: string | null;
  }[];
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("Invalid status");
  return { ...value };
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid task");
  return value;
}

function reference(value: unknown, pattern: RegExp): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !pattern.test(value))
    throw new Error("Invalid task");
  return value;
}

function activity(
  value: unknown,
): DashboardSnapshot["tasks"][number]["status"] {
  switch (value) {
    case "working":
    case "idle":
    case "blocked":
    case "queued":
    case "accepted":
    case "unknown":
      return value;
    default:
      throw new Error("Invalid activity");
  }
}

function parseTask(value: unknown): DashboardSnapshot["tasks"][number] {
  const task = record(value);
  return {
    id: string(task.id),
    title: string(task.title),
    status: activity(task.status),
    thread: reference(task.thread, /^T-[\w-]+$/),
    revision: reference(task.revision, /^[a-f0-9]{40}$/),
  };
}

function parseSnapshot(input: unknown): DashboardSnapshot {
  const value = record(input);
  if (
    typeof value.project !== "string" ||
    typeof value.observedAt !== "string" ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    typeof value.enabled !== "boolean" ||
    !Array.isArray(value.tasks)
  )
    throw new Error("Invalid status");
  return {
    project: value.project,
    observedAt: value.observedAt,
    enabled: value.enabled,
    tasks: value.tasks.map(parseTask),
  };
}

function missingFile(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** Serve a curated, read-only status projection, never raw factory files. @throws If Git or HTML is unavailable. */
export function startDashboard({ root, port }: { root: string; port: number }) {
  const directory = execFileSync(
    "git",
    ["-C", root, "rev-parse", "--absolute-git-dir"],
    { encoding: "utf8" },
  ).trim();
  const html = readFileSync(join(import.meta.dir, "dashboard.html"), "utf8");
  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      if (request.method !== "GET")
        return new Response("Read-only service", {
          status: 405,
          headers: { ...headers, allow: "GET" },
        });
      const path = new URL(request.url).pathname;
      if (path === "/")
        return new Response(html, {
          headers: { ...headers, "content-type": "text/html; charset=utf-8" },
        });
      if (path !== "/api/status")
        return new Response("Not found", { status: 404, headers });
      try {
        const snapshot = parseSnapshot(
          JSON.parse(
            await readFile(join(directory, "factory/dashboard.json"), "utf8"),
          ),
        );
        const age = Date.now() - Date.parse(snapshot.observedAt);
        return Response.json(
          { ...snapshot, fresh: age >= -5000 && age < 20_000 },
          { headers },
        );
      } catch (error) {
        if (missingFile(error)) {
          return Response.json(
            {
              project: basename(root),
              observedAt: null,
              enabled: false,
              fresh: false,
              tasks: [],
            },
            { headers },
          );
        }
        return Response.json(
          { error: "Status unavailable. Check the factory plugin." },
          { status: 503, headers },
        );
      }
    },
  });
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { repo: { type: "string", default: "." } },
  });
  const server = startDashboard({
    root: resolve(values.repo ?? "."),
    port: Number(process.env.PORT ?? 4310),
  });
  process.stdout.write(`Factory dashboard listening on port ${server.port}\n`);
}
