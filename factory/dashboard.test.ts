import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "./dashboard";

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
    expect((await (await fetch(`${url}/api/status`)).json()).fresh).toBe(false);
    await writeFile(path, '{"tasks": "invalid"}');
    expect((await fetch(`${url}/api/status`)).status).toBe(503);
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
