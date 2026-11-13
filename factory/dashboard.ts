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

function parseSnapshot(value: unknown): DashboardSnapshot {
  if (
    !value ||
    typeof value !== "object" ||
    !("project" in value) ||
    typeof value.project !== "string" ||
    !("observedAt" in value) ||
    typeof value.observedAt !== "string" ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    !("enabled" in value) ||
    typeof value.enabled !== "boolean" ||
    !("tasks" in value) ||
    !Array.isArray(value.tasks)
  )
    throw new Error("Invalid status");
  const tasks = value.tasks.map(
    (task: unknown): DashboardSnapshot["tasks"][number] => {
      if (
        !task ||
        typeof task !== "object" ||
        !("id" in task) ||
        typeof task.id !== "string" ||
        !("title" in task) ||
        typeof task.title !== "string" ||
        !("status" in task) ||
        !("thread" in task) ||
        !(
          task.thread === null ||
          (typeof task.thread === "string" && /^T-[\w-]+$/.test(task.thread))
        ) ||
        !("revision" in task) ||
        !(
          task.revision === null ||
          (typeof task.revision === "string" &&
            /^[a-f0-9]{40}$/.test(task.revision))
        )
      )
        throw new Error("Invalid task");
      const status = task.status;
      if (
        status !== "working" &&
        status !== "idle" &&
        status !== "blocked" &&
        status !== "queued" &&
        status !== "accepted" &&
        status !== "unknown"
      )
        throw new Error("Invalid activity");
      return {
        id: task.id,
        title: task.title,
        status,
        thread: task.thread,
        revision: task.revision,
      };
    },
  );
  return {
    project: value.project,
    observedAt: value.observedAt,
    enabled: value.enabled,
    tasks,
  };
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
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
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
