import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
import { installControlToken } from "./control-token";
import { tasks } from "./native";
import { lifecycleStatus, openPersistence } from "./persistence";

test("automation POSTs require token and exact origin, queue only, and never expose prompts", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-dashboard-controls-"));
  execFileSync("git", ["init", "-q", root]);
  const directory = join(root, ".git/factory");
  const storage = openPersistence(directory, []);
  storage.commit(
    {
      enabled: false,
      owner: "T-owner",
      runs: {},
      automations: {
        "weekly.audit": {
          schedule: "0 9 * * 1",
          authored: false,
          armedAt: 0,
          prompt: "PRIVATE-AUTOMATION-BODY-CANARY",
        },
      },
    },
    "factory",
    "fixture",
    "",
  );
  storage.close();
  installControlToken(directory);
  const token = (
    await readFile(join(directory, "control-token"), "utf8")
  ).trim();
  installControlToken(directory);
  expect(
    (await readFile(join(directory, "control-token"), "utf8")).trim(),
  ).toBe(token);
  const origin = "https://operator.example.invalid";
  const server = startDashboard({ root, port: 0, controlOrigin: origin });
  const url = `http://127.0.0.1:${server.port}`;
  const post = (
    headers: Record<string, string>,
    body = '{"action":"run"}',
    path = "/api/automations/weekly.audit",
    method = "POST",
  ) =>
    fetch(url + path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  try {
    const database = join(directory, "state.sqlite");
    const before = await readFile(database);
    const valid = { origin, authorization: `Bearer ${token}` };
    for (const [headers, code] of [
      [{ origin }, 401],
      [{ origin, authorization: "Bearer wrong" }, 401],
      [{ ...valid, origin: "https://attacker.invalid" }, 403],
      [{ authorization: valid.authorization }, 403],
      [{ ...valid, origin: "null" }, 403],
      [
        {
          ...valid,
          origin: "https://attacker.invalid",
          "x-forwarded-host": "attacker.invalid",
          "x-forwarded-proto": "https",
        },
        403,
      ],
    ] as const)
      expect((await post(headers)).status).toBe(code);
    for (const body of [
      '{"action":"start"}',
      '{"action":"run","name":"weekly.audit"}',
      "null",
      "[]",
      "broken",
    ])
      expect((await post(valid, body)).status).toBe(400);
    expect(
      (await post(valid, undefined, "/api/automations/missing")).status,
    ).toBe(404);
    for (const path of [
      "/",
      "/api/status",
      "/api/events",
      "/api/evidence",
      "/api/definition",
      "/api/control-token",
      "/assets/missing.js",
      "/unknown",
    ])
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
        expect((await post(valid, undefined, path, method)).status).toBe(405);
    expect(
      (await post(valid, undefined, "/api/automations/weekly.audit", "PUT"))
        .status,
    ).toBe(405);
    expect((await fetch(url + "/api/control-token")).status).toBe(404);
    expect(await readFile(database)).toEqual(before);
    const response = await post(valid);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ id: 1, status: "pending" });
    const statusText = await (await fetch(url + "/api/status")).text();
    expect(statusText).not.toContain("PRIVATE-AUTOMATION-BODY-CANARY");
    expect(statusText).not.toContain(token);
    const status = JSON.parse(statusText);
    expect(status.automations).toEqual([
      {
        name: "weekly.audit",
        schedule: "0 9 * * 1",
        enabled: false,
        lastRunAt: null,
        lastOutcome: null,
        requests: [
          {
            id: 1,
            name: "weekly.audit",
            action: "run",
            status: "pending",
            reason: null,
            at: expect.any(Number),
          },
        ],
      },
    ]);
    const db = new Database(database, { readonly: true });
    try {
      expect(db.query("SELECT data FROM automations").get()).toEqual({
        data: JSON.stringify({
          "weekly.audit": {
            schedule: "0 9 * * 1",
            authored: false,
            armedAt: 0,
            prompt: "PRIVATE-AUTOMATION-BODY-CANARY",
          },
        }),
      });
      expect(
        db.query("SELECT count(*) AS n FROM automation_requests").get(),
      ).toEqual({ n: 1 });
      expect(db.query("SELECT action FROM events ORDER BY id").all()).toEqual([
        { action: "fixture" },
      ]);
    } finally {
      db.close();
    }
    const removed = openPersistence(directory, []);
    try {
      removed.commit(
        { ...removed.state, automations: {} },
        "factory",
        "reload",
        "",
      );
      const pending = await (await fetch(url + "/api/status")).json();
      expect(pending.automations).toMatchObject([
        {
          name: "weekly.audit",
          schedule: null,
          requests: [{ status: "pending" }],
        },
      ]);
      removed.settleAutomationRequest(
        1,
        "refused",
        "Error: Unknown automation weekly.audit",
      );
      const refused = await (await fetch(url + "/api/status")).json();
      expect(refused.automations).toMatchObject([
        {
          name: "weekly.audit",
          schedule: null,
          enabled: false,
          requests: [
            {
              status: "refused",
              reason: "Error: Unknown automation weekly.audit",
            },
          ],
        },
      ]);
    } finally {
      removed.close();
    }
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("events are cursor ordered, bounded, read-only and expose only validated references", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-events-"));
  execFileSync("git", ["init", "-q", root]);
  const directory = join(root, ".git/factory");
  const server = startDashboard({ root, port: 0 });
  const url = `http://localhost:${server.port}/api/events`;
  const at = "2026-11-15T12:34:56.000Z";
  const revision = "abcdef12".repeat(5);
  const secret = {
    brief: "PRIVATE-EVENT-CANARY",
    path: "/private/worktree/report.json",
    verdict: "REJECT because private finding",
    thread: "T-planted-verdict",
  };
  try {
    expect(await (await fetch(url)).json()).toEqual({
      durable: "missing",
      events: [],
    });
    expect(await readdir(join(root, ".git"))).not.toContain("factory");
    const storage = openPersistence(directory, [], () => Date.parse(at));
    storage.event(
      "A",
      "review-sent",
      JSON.stringify({
        ...secret,
        attempt: 2,
        revision,
        thread: "T-event-review",
      }),
    );
    storage.event(
      "B",
      "future-action",
      JSON.stringify({ ...secret, attempt: 3, revision, thread: "T-hidden" }),
    );
    storage.event(
      "A",
      "review-sent",
      JSON.stringify({
        ...secret,
        attempt: "2",
        revision: `${revision}\n`,
        thread: "T-escape\n",
      }),
    );
    storage.event("A", "accepted", revision);
    storage.event("B", "sent", "T-worker");
    storage.event(
      "A",
      "review-verdict",
      JSON.stringify({
        kind: "issues",
        attempt: 2,
        revision,
        thread: secret.thread,
        findings: [{ evidence: secret.verdict }],
      }),
    );
    storage.event("A", "review-sent", "not JSON PRIVATE-EVENT-CANARY");
    storage.close();
    const path = join(directory, "state.sqlite");
    const before = await readFile(path);
    const files = await readdir(directory);
    const response = await fetch(`${url}?after=0&limit=2`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      durable: "available",
      events: [
        {
          id: 1,
          at,
          ticket: "A",
          action: "review-sent",
          attempt: 2,
          revision,
          thread: "T-event-review",
        },
        { id: 2, at, ticket: "B", action: "future-action" },
      ],
    });
    const rest = await (await fetch(`${url}?after=2&limit=500`)).json();
    expect(rest.events).toEqual([
      { id: 3, at, ticket: "A", action: "review-sent" },
      { id: 4, at, ticket: "A", action: "accepted", revision },
      { id: 5, at, ticket: "B", action: "sent", thread: "T-worker" },
      { id: 6, at, ticket: "A", action: "review-verdict" },
      { id: 7, at, ticket: "A", action: "review-sent" },
    ]);
    const text = await (await fetch(url)).text();
    for (const value of Object.values(secret))
      expect(text).not.toContain(value);
    expect(await (await fetch(`${url}?after=7`)).json()).toEqual({
      durable: "available",
      events: [],
    });
    for (const query of [
      "after=-1",
      "after=1.5",
      "after=NaN",
      "after=",
      "after=1%0a",
      "after=9007199254740992",
      "limit=0",
      "limit=501",
      "limit=1.5",
      "limit=Infinity",
      "limit=",
      "limit=1%0a",
    ])
      expect((await fetch(`${url}?${query}`)).status).toBe(400);
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
    expect(await readFile(path)).toEqual(before);
    expect(await readdir(directory)).toEqual(files);
    await writeFile(path, "invalid database");
    const invalid = await fetch(url);
    expect(invalid.status).toBe(503);
    expect(await invalid.json()).toEqual({
      durable: "invalid",
      events: [],
      error: "Durable status unavailable.",
    });
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("dashboard serves the built pipeline and assets alongside its read-only API", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-web-"));
  execFileSync("git", ["init", "-q", root]);
  const web = join(root, "web/dist");
  await mkdir(join(web, "assets"), { recursive: true });
  await writeFile(
    join(web, "index.html"),
    '<h1>Built pipeline</h1><script src="/assets/index-abc.js"></script>',
  );
  await writeFile(join(web, "assets/index-abc.js"), 'fetch("/api/status")');
  await writeFile(join(web, "assets/index-xyz.css"), "body { color: red }");
  const directory = join(root, ".git/factory");
  const storage = openPersistence(directory, [
    { id: "public-ticket", brief: "PRIVATE-BRIEF", after: [] },
  ]);
  storage.close();
  const before = await readFile(join(directory, "state.sqlite"));
  const server = startDashboard({ root, port: 0 });
  const url = `http://localhost:${server.port}`;
  try {
    for (const path of ["/", "/index.html"]) {
      const response = await fetch(`${url}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("Built pipeline");
    }
    const script = await fetch(`${url}/assets/index-abc.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect(await script.text()).toBe('fetch("/api/status")');
    const style = await fetch(`${url}/assets/index-xyz.css`);
    expect(style.status).toBe(200);
    expect(style.headers.get("content-type")).toContain("text/css");
    expect(await style.text()).toBe("body { color: red }");
    const status = await (await fetch(`${url}/api/status`)).json();
    expect(status).toMatchObject({
      durable: "available",
      tasks: [{ id: "public-ticket", title: "public-ticket" }],
    });
    expect(JSON.stringify(status)).not.toContain("PRIVATE-BRIEF");
    for (const path of [
      "/assets/missing.js",
      "/assets/%2e%2e%2f.git%2ffactory%2fstate.sqlite",
      "/.git/factory/state.sqlite",
      "/web/main.ts",
    ])
      expect((await fetch(`${url}${path}`)).status).toBe(404);
    for (const path of ["/", "/assets/index-abc.js", "/api/status"])
      expect((await fetch(`${url}${path}`, { method: "POST" })).status).toBe(
        405,
      );
    expect(await readFile(join(directory, "state.sqlite"))).toEqual(before);
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP retains authored labels across restarts and rejects untrusted labels without leaking private data", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-labels-"));
  execFileSync("git", ["init", "-q", root]);
  const directory = join(root, ".git/factory");
  const server = startDashboard({ root, port: 0 });
  const url = `http://localhost:${server.port}/api/status`;
  const canary = "PRIVATE-BRIEF-REPORT-CANARY";
  try {
    const queue = tasks([
      {
        id: "A",
        brief: canary,
        after: [],
        steps: [
          "Verify private field exclusion",
          "Preserve ordered task labels",
        ],
        report: canary,
      },
      { id: "legacy", brief: canary, after: [] },
      {
        id: "constructor",
        brief: canary,
        after: [],
        intake: "planned",
        outcome: "Public plan",
      },
    ]);
    const storage = openPersistence(directory, queue);
    storage.commit(
      { enabled: true, runs: { orphan: { kind: "blocked", reason: canary } } },
      "orphan",
      "blocked",
      canary,
    );
    storage.close();
    const reopened = openPersistence(directory, []);
    const retained = reopened.tickets;
    reopened.close();
    const expected = [
      {
        id: "A",
        steps: [
          "Verify private field exclusion",
          "Preserve ordered task labels",
        ],
      },
      { id: "legacy", steps: [] },
      {
        id: "constructor",
        steps: [],
        stage: "planned",
        outcome: "Public plan",
      },
      { id: "orphan", steps: [], kind: "blocked", stopName: null },
    ];
    const check = async () => {
      const response = await fetch(url);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.tasks).toMatchObject(expected);
      expect(body.counts).toEqual({ planned: 1, queued: 2, accepted: 0 });
      expect(JSON.stringify(body)).not.toContain(canary);
      expect(JSON.stringify(body)).not.toContain("currentStep");
      return body;
    };
    await check();
    expect(retained[0]?.steps).toEqual([
      "Verify private field exclusion",
      "Preserve ordered task labels",
    ]);
    const snapshot = {
      project: "fixture",
      enabled: true,
      observedAt: new Date().toISOString(),
      tasks: [
        {
          id: "A",
          title: "Observed title",
          status: "queued", // written before the feed dropped its public status
          thread: null,
          revision: null,
          steps: ["Untrusted heartbeat replacement"],
        },
      ],
    };
    const path = join(directory, "dashboard.json");
    await writeFile(path, JSON.stringify(snapshot));
    expect(await check()).toMatchObject({
      observations: "available",
      fresh: true,
    });
    snapshot.observedAt = new Date(Date.now() - 60_000).toISOString();
    await writeFile(path, JSON.stringify(snapshot));
    expect(await check()).toMatchObject({
      observations: "available",
      fresh: false,
    });
    for (const steps of [null, "wrong", [""], ["  "], [9]]) {
      await writeFile(
        path,
        JSON.stringify({
          ...snapshot,
          tasks: [{ ...snapshot.tasks[0], steps }],
        }),
      );
      expect(await check()).toMatchObject({
        observations: "invalid",
        fresh: false,
      });
    }
    const db = new Database(join(directory, "state.sqlite"));
    try {
      for (const steps of [null, "wrong", [""], ["  "], [9]]) {
        db.query("UPDATE tickets SET data = ? WHERE id = 'A'").run(
          JSON.stringify({ ...queue[0], steps }),
        );
        expect(() => openPersistence(directory, [])).toThrow();
        const response = await fetch(url);
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          durable: "invalid",
          tasks: [],
        });
      }
    } finally {
      db.close();
    }
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP target follows the root branch with missing storage, branch changes and detached HEAD", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-target-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "initial-target");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  );
  const server = startDashboard({ root, port: 0 });
  const url = `http://localhost:${server.port}/api/status`;
  try {
    expect(await (await fetch(url)).json()).toMatchObject({
      target: "initial-target",
      durable: "missing",
    });
    const storage = openPersistence(join(root, ".git/factory"), []);
    storage.close();
    expect(await (await fetch(url)).json()).toMatchObject({
      target: "initial-target",
      durable: "available",
    });
    git("checkout", "-qb", "changed-target");
    expect(await (await fetch(url)).json()).toMatchObject({
      target: "changed-target",
      durable: "available",
    });
    git("checkout", "-q", "--detach");
    expect(await (await fetch(url)).json()).toMatchObject({
      target: "detached HEAD",
      durable: "available",
    });
    await rm(join(root, ".git/factory"), { recursive: true });
    expect(await (await fetch(url)).json()).toMatchObject({
      target: "detached HEAD",
      durable: "missing",
    });
    await rm(root, { recursive: true });
    const failed = await fetch(url);
    expect(failed.status).toBe(503);
    expect(failed.headers.get("content-type")).toContain("application/json");
    const body = await failed.text();
    expect(JSON.parse(body)).toMatchObject({
      durable: "invalid",
      fresh: false,
      tasks: [],
      error: "Durable status unavailable.",
    });
    expect(body).not.toContain(root);
    expect(body).not.toContain("fatal:");
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

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
          A: {
            kind: "done",
            revision,
            thread: "T-worker",
            insight: canary,
            review: { ...review, ticket: "A", thread: "T-cold-review" },
          },
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
        stage: "accepted",
        thread: "T-worker",
        revision,
        evidence: {
          acceptance: { revision },
          review: { pending: false, thread: "T-cold-review", revision },
          gate: { revision, base: review.base, stage: "post-graft" },
        },
      },
      {
        id: "B",
        activity: null,
        thread: "T-review",
        revision,
        attempt: 1,
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
      { id: "C", stage: "queued", attempt: null },
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
          activity: "working",
          thread: "T-wrong",
          revision: null,
        },
        {
          id: "B",
          title: `Review title; evidence: ${canary}`,
          activity: "working",
          thread: "T-review",
          revision,
        },
        {
          id: "ghost",
          title: "Not durable",
          activity: null,
          thread: null,
          revision,
        },
        {
          id: "C",
          title: canary,
          activity: null,
          thread: null,
          revision: null,
        },
      ],
    };
    const path = join(directory, "dashboard.json");
    await writeFile(path, JSON.stringify(snapshot));
    const fresh = await (await fetch(url)).json();
    expect(fresh).toMatchObject({ fresh: true, enabled: true });
    expect(fresh.tasks).toMatchObject([
      { id: "A", stage: "accepted" },
      { id: "B", title: "B - post-graft review (sent)", activity: "working" },
      { id: "C", stage: "queued" },
    ]);
    snapshot.tasks[0] = {
      id: "A",
      title: canary,
      activity: "working",
      thread: "T-worker",
      revision,
    };
    for (const age of [0, 60_000]) {
      snapshot.observedAt = new Date(Date.now() - age).toISOString();
      await writeFile(path, JSON.stringify(snapshot));
      const legacy = await fetch(url);
      expect(legacy.status).toBe(200);
      const body = await legacy.text();
      expect(body).not.toContain(canary);
      expect(JSON.parse(body)).toMatchObject({
        fresh: age === 0,
        tasks: [
          {
            id: "A",
            title: "A",
            stage: "accepted",
            thread: "T-worker",
            revision,
            evidence: { acceptance: { revision } },
          },
          {
            id: "B",
            title: "B - post-graft review (sent)",
            thread: "T-review",
            revision,
            activity: age === 0 ? "working" : null,
            evidence: {
              review: { pending: true, revision, base: review.base },
            },
          },
          {
            id: "C",
            title: "C",
            stage: "queued",
            thread: null,
            revision: null,
          },
        ],
      });
      expect(await readFile(path, "utf8")).toBe(JSON.stringify(snapshot));
    }
    snapshot.observedAt = new Date().toISOString();
    snapshot.tasks[1]!.thread = "T-old-review";
    await writeFile(path, JSON.stringify(snapshot));
    expect((await (await fetch(url)).json()).tasks[1].activity).toBeNull();
    snapshot.tasks[1]!.thread = "T-review";
    snapshot.tasks[1]!.revision = "c".repeat(40);
    await writeFile(path, JSON.stringify(snapshot));
    expect((await (await fetch(url)).json()).tasks[1].activity).toBeNull();
    snapshot.tasks[1]!.revision = revision;
    snapshot.observedAt = new Date(Date.now() - 60_000).toISOString();
    await writeFile(path, JSON.stringify(snapshot));
    expect((await (await fetch(url)).json()).tasks[1].activity).toBeNull();
    snapshot.observedAt = new Date(Date.now() + 60_000).toISOString();
    await writeFile(path, JSON.stringify(snapshot));
    expect((await (await fetch(url)).json()).tasks[1].activity).toBeNull();
    await writeFile(path, "not json");
    const invalid = await (await fetch(url)).json();
    expect(invalid).toMatchObject({
      observations: "invalid",
    });
    expect(invalid.tasks[0].stage).toBe("accepted");
    expect(await readFile(join(directory, "state.sqlite"))).toEqual(bytes);
    expect((await readdir(directory)).sort()).toEqual(
      [...files, "dashboard.json"].sort(),
    );
    for (const path of [
      "/state.sqlite",
      "/api/evidence/A",
      "/evidence",
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

test("dashboard ignores observed titles, stops stale activity, and never serves private files or writes", async () => {
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
          activity: "working",
          thread: "T-actual-thread",
          revision: null,
        },
        {
          id: "B",
          title: "Next ticket",
          activity: null,
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
      title: "A",
      activity: "working",
      thread: "T-actual-thread",
    });
    expect(current.privateToken).toBeUndefined();
    expect(response.headers.get("cache-control")).toBe("no-store");
    snapshot.observedAt = new Date(Date.now() - 60_000).toISOString();
    await writeFile(path, JSON.stringify(snapshot));
    const stale = await (await fetch(`${url}/api/status`)).json();
    expect(stale.fresh).toBe(false);
    expect(stale.tasks[0].activity).toBeNull();
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

test("the feed carries the declared lifecycle table and each run's kind and stop, and nothing private", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-graph-"));
  execFileSync("git", ["init", "-q", root]);
  const directory = join(root, ".git/factory");
  const canary = "PRIVATE-GRAPH-CANARY-/secret/brief.txt";
  const base = "b".repeat(40);
  const storage = openPersistence(directory, [
    { id: "A", brief: canary, after: [] },
    { id: "B", brief: canary, after: [] },
    { id: "C", brief: canary, after: [] },
  ]);
  const worker = {
    kind: "running",
    base,
    worktree: canary,
    thread: "T-worker",
    attempt: 1,
    delivery: "sent",
    requirements: canary,
    feedback: canary,
  } as const;
  storage.commit(
    {
      enabled: true,
      runs: {
        A: {
          ...worker,
          incident: {
            id: "stop-a",
            ticket: "A",
            owner: "T-owner",
            cause: { thread: "T-worker", role: "worker" },
            base,
            attempt: 1,
            reason: "provider-limit",
            recovery: "wait",
            providerLimit: {
              message: canary,
              observedAt: 1000,
              resetAt: 9_000_000,
              thread: "T-worker",
            },
            delivery: "queued",
          },
        },
        B: {
          kind: "blocked",
          reason: canary,
          base,
          thread: "T-blocked",
          incident: {
            id: "stop-b",
            ticket: "B",
            owner: "T-owner",
            base,
            attempt: 1,
            reason: "worker-blocked",
            recovery: "inspect",
            delivery: "queued",
          },
        },
      },
    },
    "A",
    "blocked",
    canary,
  );
  storage.close();
  const server = startDashboard({ root, port: 0 });
  try {
    const text = await (
      await fetch(`http://localhost:${server.port}/api/status`)
    ).text();
    expect(text).not.toContain(canary);
    const body = JSON.parse(text);
    // The page draws this table, so it must be exactly the one the factory acts on.
    expect(body.lifecycle).toEqual(
      JSON.parse(JSON.stringify(lifecycleStatus())),
    );
    expect(body.lifecycle.blocked.stops.withoutWorker.exits).toEqual([]);
    expect(body.tasks).toMatchObject([
      {
        id: "A",
        kind: "running",
        stopName: "providerLimit",
        stage: "rate-limited",
        actor: "computer",
        clearsAt: new Date(9_000_000).toISOString(),
        stop: { reason: "provider-limit", role: "worker" },
      },
      {
        id: "B",
        kind: "blocked",
        stopName: "uncheckpointed",
        actor: "foreman",
      },
      { id: "C", kind: null, stopName: null, stage: "queued" },
    ]);
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
