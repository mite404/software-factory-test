import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit } from "./audit";

const roots: string[] = [];
const from = "2026-11-09T00:00:00.000Z";
const to = "2026-11-16T00:00:00.000Z";
const key = "audit-secret-canary-do-not-persist";
const revision = "a".repeat(40);
const finding = {
  severity: "warning",
  location: "factory/native.ts:23",
  evidence: "Deadline derives from the local clock",
  correction: "Use the persisted deadline",
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function review(ticket: string, findings = [finding]) {
  return {
    ticket,
    attempt: 2,
    revision,
    base: "b".repeat(40),
    stage: "post-graft",
    kind: findings.length ? "issues" : "pass",
    findings,
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "factory-audit-"));
  roots.push(directory);
  const path = join(directory, "state.sqlite");
  const db = new Database(path);
  db.run(
    "CREATE TABLE events (id INTEGER PRIMARY KEY, at TEXT NOT NULL, ticket TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL); PRAGMA user_version = 2",
  );
  db.close();
  return directory;
}

function event(
  directory: string,
  ticket: string,
  action: string,
  detail: string,
  at = from,
) {
  const db = new Database(join(directory, "state.sqlite"));
  try {
    db.run(
      "INSERT INTO events (at, ticket, action, detail) VALUES (?, ?, ?, ?)",
      [at, ticket, action, detail],
    );
  } finally {
    db.close();
  }
}

async function verdictFile(directory: string, ticket: string, at = from) {
  const path = join(
    directory,
    `${ticket}-2-${revision}-post-graft.review.json`,
  );
  await writeFile(path, JSON.stringify(review(ticket)));
  await utimes(path, new Date(at), new Date(at));
  return path;
}

type RequestBody = {
  model: string;
  state: typeof finding;
  questions: Record<
    string,
    {
      type: string;
      instructions: string;
      criteria: Record<string, unknown> | string[];
    }
  >;
};

function response(
  body: RequestBody,
  area = "time and clocks",
  confidence = 0.9,
  noneFits = 0.1,
  score = 2.5,
) {
  const answers = Object.fromEntries(
    Object.entries(body.questions).map(([id, question]) => {
      if (question.type === "noul")
        return [id, { type: "noul", noul: noneFits }];
      const options = Object.keys(question.criteria);
      const selected = id === "area" ? area : options[0]!;
      const probabilities = Object.fromEntries(
        options.map((option) => [option, option === selected ? 1 : 0]),
      );
      if (question.type === "choice")
        return [
          id,
          { type: "choice", choice: selected, confidence, probabilities },
        ];
      return [
        id,
        {
          type: "score",
          score,
          confidence,
          legend: Object.fromEntries(Object.entries(question.criteria)),
          probabilities: Object.fromEntries(
            options.map((option) => [option, option === "2" ? 1 : 0]),
          ),
        },
      ];
    }),
  );
  return {
    model: "jev-1.13.0",
    answers,
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

function body(init: RequestInit) {
  if (typeof init.body !== "string") throw new Error("Expected JSON text");
  return JSON.parse(init.body) as RequestBody;
}

async function ledger(result: Awaited<ReturnType<typeof audit>>) {
  return JSON.parse(await readFile(result.ledger, "utf8")) as {
    records: Array<Record<string, unknown>>;
  };
}

test("weekly audit collects every in-range finding once, pages events, bounds gate text and never mutates sources", async () => {
  const directory = await fixture();
  const db = new Database(join(directory, "state.sqlite"));
  db.transaction(() => {
    for (let i = 0; i < 501; i++)
      db.run(
        "INSERT INTO events (at, ticket, action, detail) VALUES (?, 'noise', 'sent', 'private transcript')",
        [from],
      );
  })();
  db.close();
  const a = review("A", [
    finding,
    {
      ...finding,
      location: "factory/native.ts:45",
      evidence: "Second independent failure",
    },
  ]);
  event(
    directory,
    "A",
    "escalated",
    JSON.stringify({ ...a, evidence: "Extra verdict field" }),
  );
  const aPath = await verdictFile(directory, "A", to);
  await writeFile(aPath, JSON.stringify(a));
  event(
    directory,
    "Old",
    "review-verdict",
    JSON.stringify(review("Old")),
    "2026-11-08T23:59:59.999Z",
  );
  await verdictFile(directory, "Old", from);
  event(
    directory,
    "Future",
    "review-verdict",
    JSON.stringify(review("Future")),
    to,
  );
  await verdictFile(directory, "Future", from);
  await verdictFile(directory, "FileOnly", "2026-11-15T23:59:59.999Z");
  await verdictFile(directory, "FileOutside", to);
  event(
    directory,
    "Pass",
    "review-verdict",
    JSON.stringify(review("Pass", [])),
  );
  await writeFile(join(directory, "Gate-3.log"), "first run\n");
  await writeFile(
    join(directory, "Gate-3.rerun.log"),
    "private-full-log-header\n" + "padding\n".repeat(2000) + "Type mismatch\n",
  );
  await writeFile(
    join(directory, "Gate-3.rerun.log.excerpt.json"),
    JSON.stringify({
      outcome: "gate-failed",
      status: 1,
      stdout: "Type mismatch\n",
      stderr: "Test summary\n",
      omitted: true,
    }),
  );
  event(
    directory,
    "Gate",
    "rejected",
    JSON.stringify({
      attempt: 3,
      reason: "gate-failed",
      evidence: "/private/path/Gate-3.log",
    }),
  );
  event(
    directory,
    "Gate",
    "escalated",
    `factory-rejection-stop:v1:${JSON.stringify({
      attempt: 3,
      reason: "verification-rejected",
      evidence: "/private/path/Gate-3.log",
    })}`,
  );
  event(directory, "Stop", "blocked", "PRIVATE BRIEF AND TRANSCRIPT");
  event(directory, "StoppedReview", "review-stopped", "error");
  event(directory, "Missing", "parked", "/private/Missing-4.log");
  const sources = await readdir(directory);
  const before = await Promise.all(
    sources.map((name) => readFile(join(directory, name))),
  );
  const states: unknown[] = [];
  const result = await audit({
    directory,
    from,
    to,
    apiKey: key,
    fetch: async (url, init) => {
      expect(url).toBe("https://api.typesafe.ai/v1/systemone");
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("error");
      expect(new Headers(init.headers).get("Authorization")).toBe(
        `Bearer ${key}`,
      );
      expect(new Headers(init.headers).get("Content-Type")).toBe(
        "application/json",
      );
      const payload = body(init);
      expect(Object.keys(payload).sort()).toEqual([
        "model",
        "questions",
        "state",
      ]);
      expect(Object.keys(payload.state).sort()).toEqual([
        "correction",
        "evidence",
        "location",
        "severity",
      ]);
      expect(Object.keys(payload.questions).sort()).toEqual([
        "area",
        "impact",
        "layer",
        "mistake",
        "noneFits",
      ]);
      expect(JSON.stringify(payload)).not.toContain("PRIVATE");
      expect(JSON.stringify(payload)).not.toContain("private-full-log-header");
      expect(JSON.stringify(payload)).not.toContain(key);
      states.push(payload.state);
      const score =
        payload.state.evidence === "Second independent failure" ? 1.5 : 2.5;
      return Response.json(
        response(payload, "time and clocks", 0.9, 0.1, score),
      );
    },
  });
  expect(result.count).toBe(7);
  expect(states).toHaveLength(4);
  expect(states[0]).toEqual(finding);
  const data = await ledger(result);
  expect(data.records.map((row) => row.ticket)).toEqual([
    "A",
    "A",
    "FileOnly",
    "Gate",
    "Stop",
    "StoppedReview",
    "Missing",
  ]);
  expect(data.records[3]).toMatchObject({
    attempt: 3,
    severity: "gate failure",
    bucket: "time and clocks",
  });
  expect(String(data.records[3]!.evidence)).toContain(
    "BEGIN GATE STDOUT\nType mismatch\n",
  );
  expect(String(data.records[3]!.evidence)).toContain(
    "BEGIN GATE STDERR\nTest summary\n",
  );
  expect(
    Buffer.byteLength(String(data.records[3]!.evidence)),
  ).toBeLessThanOrEqual(8192);
  expect(data.records.slice(4).map((row) => row.reason)).toEqual([
    "blocked: no structured finding or gate excerpt",
    "review-stopped: no structured finding or gate excerpt",
    "Gate excerpt unavailable",
  ]);
  expect(
    result.buckets.find((bucket) => bucket.bucket === "time and clocks"),
  ).toEqual({
    bucket: "time and clocks",
    count: 4,
    tickets: ["A", "FileOnly", "Gate"],
    meanImpact: 2.25,
    files: [{ file: "factory/native.ts", count: 3 }],
  });
  expect(result.brief).toContain(result.ledger);
  expect(result.brief).toContain("moonshotai/kimi-k3");
  expect((await stat(result.ledger)).mode & 0o777).toBe(0o600);
  for (let i = 0; i < sources.length; i++)
    expect(await readFile(join(directory, sources[i]!))).toEqual(before[i]!);
  expect((await readdir(directory)).sort()).toEqual(
    [...sources, result.ledger.split("/").at(-1)!].sort(),
  );
});

test("429 and 529 back off within a bound, keep partial weeks and omit secrets from all artifacts", async () => {
  const directory = await fixture();
  event(
    directory,
    "Retry",
    "review-verdict",
    JSON.stringify(
      review("Retry", [{ ...finding, evidence: `Invalid output ${key}` }]),
    ),
  );
  const waits: number[] = [];
  let calls = 0;
  const result = await audit({
    directory,
    from,
    to,
    apiKey: key,
    sleep: async (ms) => {
      waits.push(ms);
    },
    fetch: async (_url, init) => {
      calls++;
      expect(init.body).not.toContain(key);
      if (calls < 3)
        return new Response(key, { status: calls === 1 ? 429 : 529 });
      return Response.json(response(body(init), "persistence", 0.7, 0.49, 1.7));
    },
  });
  expect(calls).toBe(3);
  expect(waits).toEqual([1000, 2000]);
  expect((await ledger(result)).records[0]).toMatchObject({
    bucket: "persistence",
    evidence: "Invalid output [REDACTED]",
  });
  expect(await readFile(result.ledger, "utf8")).not.toContain(key);
  expect(result.brief).not.toContain(key);
  for (const status of [429, 529, 401]) {
    calls = 0;
    const failed = await audit({
      directory,
      from,
      to,
      apiKey: key,
      sleep: async () => {},
      fetch: async () => {
        calls++;
        return new Response(key, { status });
      },
    });
    expect(calls).toBe(status === 401 ? 1 : 3);
    expect((await ledger(failed)).records[0]).toMatchObject({
      bucket: "unsorted",
      reason: `Classifier HTTP ${status}`,
    });
    expect(await readFile(failed.ledger, "utf8")).not.toContain(key);
  }
  const failed = await audit({
    directory,
    from,
    to,
    apiKey: key,
    fetch: () => {
      throw new Error(key);
    },
  });
  expect((await ledger(failed)).records[0]).toMatchObject({
    bucket: "unsorted",
    reason: "Classifier request failed",
  });
  expect(failed.brief).not.toContain(key);
});

test("confidence and none-fits boundaries refuse a guess and preserve typed probabilities", async () => {
  const directory = await fixture();
  event(directory, "A", "review-verdict", JSON.stringify(review("A")));
  for (const [confidence, noneFits, expected, reason] of [
    [0.699, 0.1, "unsorted", "Low area confidence"],
    [0.7, 0.499, "time and clocks", undefined],
    [0.9, 0.5, "unsorted", "No listed area fits"],
  ] as const) {
    const result = await audit({
      directory,
      from,
      to,
      apiKey: key,
      fetch: async (_url, init) =>
        Response.json(
          response(body(init), "time and clocks", confidence, noneFits),
        ),
    });
    const row = (await ledger(result)).records[0]!;
    expect(row.bucket).toBe(expected);
    expect(row.reason).toBe(reason);
    expect(row.answers).toMatchObject({
      area: { confidence, probabilities: { "time and clocks": 1 } },
      impact: { score: 2.5 },
      noneFits: { noul: noneFits },
    });
  }
});

test("malformed answers are unsorted at the network boundary without retaining response data", async () => {
  const directory = await fixture();
  event(directory, "A", "review-verdict", JSON.stringify(review("A")));
  event(
    directory,
    "B",
    "review-verdict",
    JSON.stringify(
      review("B", [{ ...finding, evidence: "Valid independent finding" }]),
    ),
  );
  const corruptions = [
    (row: Record<string, unknown>) => {
      delete row.layer;
    },
    (row: Record<string, unknown>) => {
      row.area = { type: "noul", noul: 0.5 };
    },
    (row: Record<string, unknown>) => {
      (row.area as Record<string, unknown>).choice = key;
    },
    (row: Record<string, unknown>) => {
      (row.mistake as Record<string, unknown>).confidence = 1.1;
    },
    (row: Record<string, unknown>) => {
      (row.layer as Record<string, unknown>).probabilities = {};
    },
    (row: Record<string, unknown>) => {
      (row.area as Record<string, unknown>).probabilities = {
        "time and clocks": -1,
      };
    },
    (row: Record<string, unknown>) => {
      (row.impact as Record<string, unknown>).score = 4.01;
    },
    (row: Record<string, unknown>) => {
      (row.impact as Record<string, unknown>).score = -0.01;
    },
    (row: Record<string, unknown>) => {
      (row.noneFits as Record<string, unknown>).noul = "0.2";
    },
  ];
  for (const corrupt of corruptions) {
    const result = await audit({
      directory,
      from,
      to,
      apiKey: key,
      fetch: async (_url, init) => {
        const request = body(init);
        const payload = response(request);
        if (request.state.evidence !== "Valid independent finding")
          corrupt(payload.answers);
        return Response.json({ ...payload, private: key });
      },
    });
    expect((await ledger(result)).records[0]).toMatchObject({
      bucket: "unsorted",
      reason: "Malformed classifier answer",
    });
    expect((await ledger(result)).records[1]).toMatchObject({
      ticket: "B",
      bucket: "time and clocks",
    });
    expect(await readFile(result.ledger, "utf8")).not.toContain(key);
  }
});

test("malformed verdicts and legacy or invalid gate excerpts stay local while a valid gate is classified", async () => {
  const directory = await fixture();
  const bad = await verdictFile(directory, "Bad");
  await writeFile(bad, "not JSON");
  await utimes(bad, new Date(from), new Date(from));
  await writeFile(join(directory, "Gate-1.log"), "Compile failed\n");
  event(directory, "Gate", "rejected", "/private/Gate-1.log");
  await writeFile(
    join(directory, "Gate-1.log.excerpt.json"),
    JSON.stringify({
      outcome: "gate-failed",
      status: 1,
      stdout: "Compile failed\n",
      stderr: "",
      omitted: false,
    }),
  );
  await writeFile(join(directory, "Legacy-1.log"), "stderr tail only\n");
  event(directory, "Legacy", "rejected", "/private/Legacy-1.log");
  await writeFile(join(directory, "Invalid-1.log"), "corrupt sidecar\n");
  await writeFile(
    join(directory, "Invalid-1.log.excerpt.json"),
    JSON.stringify({
      outcome: "gate-failed",
      status: 1,
      stdout: "x".repeat(8193),
      stderr: "",
      omitted: false,
    }),
  );
  event(directory, "Invalid", "rejected", "/private/Invalid-1.log");
  await writeFile(
    join(directory, "NotRun-1.log"),
    "Candidate revision, clean tree, or allowed-path check failed",
  );
  await writeFile(
    join(directory, "NotRun-1.log.excerpt.json"),
    JSON.stringify({
      outcome: "gate-not-run",
      status: null,
      stdout: "",
      stderr: "",
      omitted: false,
    }),
  );
  event(directory, "NotRun", "rejected", "/private/NotRun-1.log");
  for (const [ticket, outcome, status] of [
    ["Unknown", "future-outcome", 1],
    ["MissingOutcome", undefined, 1],
    ["Passed", "gate-passed", 0],
    ["Contradictory", "gate-failed", 0],
  ] as const) {
    await writeFile(join(directory, `${ticket}-1.log`), "Tests passed\n");
    await writeFile(
      join(directory, `${ticket}-1.log.excerpt.json`),
      JSON.stringify({
        outcome,
        status,
        stdout: "Tests passed\n",
        stderr: "",
        omitted: false,
      }),
    );
    event(directory, ticket, "rejected", `/private/${ticket}-1.log`);
  }
  const states: unknown[] = [];
  const result = await audit({
    directory,
    from,
    to,
    apiKey: key,
    fetch: async (_url, init) => {
      states.push(body(init).state);
      return Response.json(response(body(init)));
    },
  });
  expect(states).toHaveLength(1);
  expect(states[0]).toMatchObject({
    evidence:
      "BEGIN GATE STDOUT\nCompile failed\n\nEND GATE STDOUT\nBEGIN GATE STDERR\n\nEND GATE STDERR",
  });
  expect((await ledger(result)).records).toMatchObject([
    { ticket: "Bad", bucket: "unsorted", reason: "Invalid verdict file" },
    { ticket: "Gate", bucket: "time and clocks" },
    {
      ticket: "Legacy",
      bucket: "unsorted",
      evidence: "stderr tail only\n",
      reason: "Legacy gate log lacks stream boundaries",
    },
    {
      ticket: "Invalid",
      bucket: "unsorted",
      evidence: "corrupt sidecar\n",
      reason: "Invalid or unavailable gate excerpt",
    },
    {
      ticket: "NotRun",
      bucket: "unsorted",
      evidence: "Candidate revision, clean tree, or allowed-path check failed",
      reason:
        "Gate not run: candidate revision, clean tree or allowed-path check failed",
    },
    {
      ticket: "Unknown",
      bucket: "unsorted",
      reason: "Invalid or unavailable gate excerpt",
    },
    {
      ticket: "MissingOutcome",
      bucket: "unsorted",
      reason: "Invalid or unavailable gate excerpt",
    },
    {
      ticket: "Passed",
      bucket: "unsorted",
      reason: "Gate passed: no failed gate finding",
    },
    {
      ticket: "Contradictory",
      bucket: "unsorted",
      reason: "Invalid or unavailable gate excerpt",
    },
  ]);
});

test("missing credentials and invalid ranges fail before requests or writes, and CLI errors stay private", async () => {
  const directory = await fixture();
  const sources = await readdir(directory);
  const request = () => {
    throw new Error("Must not request");
  };
  expect(
    audit({ directory, from, to, apiKey: "", fetch: request }),
  ).rejects.toThrow("TYPESAFE_API_KEY");
  expect(
    audit({ directory, from: to, to: from, apiKey: key, fetch: request }),
  ).rejects.toThrow("increasing date range");
  expect(
    audit({ directory, from: "invalid", to, apiKey: key, fetch: request }),
  ).rejects.toThrow("increasing date range");
  expect(
    audit({
      directory: join(directory, key),
      from,
      to,
      apiKey: key,
      fetch: request,
    }),
  ).rejects.toThrow("Audit failed; inspect local records and output access");
  const child = Bun.spawn(["bun", "factory/audit.ts", directory, from, to], {
    env: { ...process.env, TYPESAFE_API_KEY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stdout).text()).toBe("");
  expect(await new Response(child.stderr).text()).toBe(
    "Set TYPESAFE_API_KEY before running the audit\n",
  );
  expect(await readdir(directory)).toEqual(sources);
});
