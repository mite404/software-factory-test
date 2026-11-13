import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "./dashboard";
import { openPersistence } from "./persistence";

async function holdDatabase(
  directory: string,
  mode: "reader" | "writer",
  milliseconds: number,
) {
  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { Database } from "bun:sqlite";
const db = new Database(process.argv[1]);
if (process.argv[2] === "reader") {
  db.run("BEGIN");
  db.query("SELECT enabled FROM coordinator").get();
} else {
  db.run("BEGIN EXCLUSIVE");
  db.run("UPDATE coordinator SET enabled = 1");
}
console.log("locked");
setTimeout(() => { db.run("COMMIT"); db.close(); }, Number(process.argv[3]));`,
      join(directory, "state.sqlite"),
      mode,
      String(milliseconds),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const { value } = await holder.stdout.getReader().read();
  expect(new TextDecoder().decode(value)).toBe("locked\n");
  return holder;
}

test.each(["new-writer", "reopened-writer", "http-reader", "http-busy"])(
  "%s waits for an overlapping SQLite transaction without losing durable state",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "factory-contention-"));
    execFileSync("git", ["init", "-q", root]);
    const directory = join(root, ".git/factory");
    let storage = openPersistence(directory, []);
    const server = startDashboard({ root, port: 0 });
    let holder: Awaited<ReturnType<typeof holdDatabase>> | undefined;
    try {
      if (mode === "reopened-writer") {
        storage.close();
        storage = openPersistence(directory, []);
      }
      const reading = mode.startsWith("http");
      holder = await holdDatabase(
        directory,
        reading ? "writer" : "reader",
        mode === "http-busy" ? 7000 : 500,
      );
      if (!reading) {
        storage.state.enabled = true;
        storage.commit(
          storage.state,
          "factory",
          "started",
          "contention regression",
        );
      }
      const response = await fetch(
        `http://localhost:${server.port}/api/status`,
      );
      expect(response.status).toBe(mode === "http-busy" ? 503 : 200);
      expect(await response.json()).toMatchObject(
        mode === "http-busy"
          ? { durable: "unavailable", fresh: false }
          : { durable: "available", enabled: true },
      );
      expect(await holder.exited).toBe(0);
      expect(
        await (
          await fetch(`http://localhost:${server.port}/api/status`)
        ).json(),
      ).toMatchObject({
        durable: "available",
        enabled: true,
      });
    } finally {
      await holder?.exited;
      storage.close();
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  10_000,
);

test("HTTP reads durable acceptance without a heartbeat and never discloses private evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-evidence-"));
  execFileSync("git", ["init", "-q", root]);
  const directory = join(root, ".git/factory");
  const server = startDashboard({ root, port: 0 });
  const url = `http://localhost:${server.port}/api/status`;
  const revision = "a".repeat(40);
  const canary = "PRIVATE-CANARY-/secret/report.json";
  try {
    expect(await (await fetch(url)).json()).toMatchObject({
      durable: "missing",
      fresh: false,
      tasks: [],
    });
    expect(await readdir(join(root, ".git"))).not.toContain("factory");
    const storage = openPersistence(directory, [
      { id: "A", brief: canary, after: [] },
      { id: "B", brief: canary, after: [] },
      { id: "C", brief: canary, after: [] },
    ]);
    const review = {
      ticket: "B",
      attempt: 1,
      revision,
      base: "b".repeat(40),
      stage: "post-graft" as const,
      worktree: canary,
      model: "anthropic/reviewer" as const,
      report: canary,
      log: canary,
      command: canary,
      delivery: "sent" as const,
      thread: "T-review" as const,
    };
    storage.commit(
      {
        enabled: true,
        owner: "T-private-owner",
        runs: {
          A: { kind: "done", revision, thread: "T-worker", insight: canary },
          B: {
            kind: "running",
            base: review.base,
            worktree: canary,
            thread: "T-original",
            attempt: 1,
            delivery: "sent",
            requirements: canary,
            review,
          },
        },
      },
      "A",
      "accepted",
      canary,
    );
    storage.close();
    const bytes = await readFile(join(directory, "state.sqlite"));
    const files = await readdir(directory);
    const missing = await (await fetch(url)).json();
    expect(missing.tasks).toMatchObject([
      {
        id: "A",
        title: "A",
        status: "accepted",
        revision,
        evidence: { acceptance: { revision }, review: null, gate: null },
      },
      {
        id: "B",
        status: "unknown",
        thread: "T-review",
        revision,
        evidence: {
          review: {
            pending: true,
            revision,
            base: review.base,
            stage: "post-graft",
            thread: "T-review",
          },
          gate: { revision, base: review.base, stage: "post-graft" },
        },
      },
      { id: "C", status: "queued" },
    ]);
    expect(missing).toMatchObject({
      durable: "available",
      fresh: false,
      observedAt: null,
    });
    expect(JSON.stringify(missing)).not.toContain(canary);
    expect(JSON.stringify(missing)).not.toContain("T-private-owner");
    const snapshot = {
      project: "observed",
      enabled: false,
      observedAt: new Date().toISOString(),
      tasks: [
        {
          id: "A",
          title: "Accepted title",
          status: "working",
          thread: "T-wrong",
          revision: null,
        },
        {
          id: "B",
          title: `Review title; evidence: ${canary}`,
          status: "working",
          thread: "T-review",
          revision,
        },
        {
          id: "ghost",
          title: "Not durable",
          status: "accepted",
          thread: null,
          revision,
        },
      ],
    };
    const path = join(directory, "dashboard.json");
    await writeFile(path, JSON.stringify(snapshot));
    const fresh = await (await fetch(url)).json();
    expect(fresh).toMatchObject({ fresh: true, enabled: true });
    expect(fresh.tasks).toMatchObject([
      { id: "A", status: "accepted" },
      { id: "B", title: "B - post-graft review (sent)", status: "working" },
      { id: "C", status: "queued" },
    ]);
    snapshot.tasks[1]!.thread = "T-old-review";
    await writeFile(path, JSON.stringify(snapshot));
    expect((await (await fetch(url)).json()).tasks[1].status).toBe("unknown");
    snapshot.tasks[1]!.thread = "T-review";
    snapshot.tasks[1]!.revision = "c".repeat(40);
    await writeFile(path, JSON.stringify(snapshot));
    expect((await (await fetch(url)).json()).tasks[1].status).toBe("unknown");
    snapshot.tasks[1]!.revision = revision;
    snapshot.observedAt = new Date(Date.now() - 60_000).toISOString();
    await writeFile(path, JSON.stringify(snapshot));
    expect((await (await fetch(url)).json()).tasks[1].status).toBe("unknown");
    snapshot.observedAt = new Date(Date.now() + 60_000).toISOString();
    await writeFile(path, JSON.stringify(snapshot));
    expect((await (await fetch(url)).json()).tasks[1].status).toBe("unknown");
    await writeFile(path, "not json");
    const invalid = await (await fetch(url)).json();
    expect(invalid).toMatchObject({
      observations: "invalid",
    });
    expect(invalid.tasks[0].status).toBe("accepted");
    expect(await readFile(join(directory, "state.sqlite"))).toEqual(bytes);
    expect((await readdir(directory)).sort()).toEqual(
      [...files, "dashboard.json"].sort(),
    );
    for (const path of [
      "/state.sqlite",
      "/api/evidence",
      "/.git/factory/state.sqlite",
    ])
      expect((await fetch(new URL(path, url))).status).toBe(404);
    for (const method of ["POST", "PUT", "DELETE"])
      expect((await fetch(url, { method })).status).toBe(405);
    await writeFile(join(directory, "state.sqlite"), canary);
    const corrupt = await fetch(url);
    expect(corrupt.status).toBe(503);
    expect(await corrupt.json()).toMatchObject({
      durable: "invalid",
      fresh: false,
      tasks: [],
    });
    expect(await readFile(join(directory, "state.sqlite"), "utf8")).toBe(
      canary,
    );
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("dashboard serves fresh titles, stops stale activity, and never serves private files or writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-dashboard-"));
  execFileSync("git", ["init", "-q", root]);
  await mkdir(join(root, ".git/factory"), { recursive: true });
  const server = startDashboard({ root, port: 0 });
  const url = `http://localhost:${server.port}`;
  try {
    expect((await fetch(`${url}/api/status`)).status).toBe(200);
    expect(await (await fetch(`${url}/api/status`)).json()).toMatchObject({
      fresh: false,
      tasks: [],
    });
    const storage = openPersistence(join(root, ".git/factory"), [
      { id: "A", brief: "Repair", after: [] },
      { id: "B", brief: "Next", after: [] },
    ]);
    storage.commit(
      {
        enabled: true,
        runs: {
          A: {
            kind: "running",
            base: "a".repeat(40),
            worktree: "/private/worktree",
            thread: "T-actual-thread",
            attempt: 1,
            delivery: "sent",
          },
        },
      },
      "A",
      "sent",
      "T-actual-thread",
    );
    storage.close();
    const snapshot = {
      project: "a-real-project",
      enabled: true,
      observedAt: new Date().toISOString(),
      tasks: [
        {
          id: "A",
          title: "Repair <script>markup</script>",
          status: "working",
          thread: "T-actual-thread",
          revision: null,
        },
        {
          id: "B",
          title: "Next ticket",
          status: "queued",
          thread: null,
          revision: null,
        },
      ],
      privateToken: "must-not-be-served",
    };
    const path = join(root, ".git/factory/dashboard.json");
    await writeFile(path, JSON.stringify(snapshot));
    const response = await fetch(`${url}/api/status`);
    const current = await response.json();
    expect(current.fresh).toBe(true);
    expect(current.tasks[0]).toMatchObject({
      title: "Repair <script>markup</script>",
      status: "working",
      thread: "T-actual-thread",
    });
    expect(current.privateToken).toBeUndefined();
    expect(response.headers.get("cache-control")).toBe("no-store");
    snapshot.observedAt = new Date(Date.now() - 60_000).toISOString();
    await writeFile(path, JSON.stringify(snapshot));
    const stale = await (await fetch(`${url}/api/status`)).json();
    expect(stale.fresh).toBe(false);
    expect(stale.tasks[0].status).toBe("unknown");
    await writeFile(path, '{"tasks": "invalid"}');
    expect(await (await fetch(`${url}/api/status`)).json()).toMatchObject({
      durable: "available",
      observations: "invalid",
      fresh: false,
    });
    expect((await fetch(`${url}/.git/factory/dashboard.json`)).status).toBe(
      404,
    );
    expect((await fetch(`${url}/api/status`, { method: "POST" })).status).toBe(
      405,
    );
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
