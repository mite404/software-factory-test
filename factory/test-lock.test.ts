import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function waitForFile(path: string, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (!(await Bun.file(path).exists())) {
    if (performance.now() >= deadline)
      throw new Error(`Missing fixture event ${path}`);
    await Bun.sleep(10);
  }
}

test("test runs serialize across checkouts, report waits, and recover from a killed holder", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-test-lock-"));
  const lock = join(root, "machine.lock");
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const start = (checkout: string, name: string, holder?: number) => {
    const stderrPath = join(root, `${name}.stderr`);
    const child = Bun.spawn([process.execPath, "test"], {
      cwd: join(root, checkout),
      env: {
        ...process.env,
        FIXTURE_NAME: name,
        FIXTURE_ROOT: root,
        FIXTURE_HOLDER: holder?.toString(),
      },
      stdout: "pipe",
      stderr: Bun.file(stderrPath),
    });
    children.push(child);
    return {
      child,
      stderrPath,
      stdout: new Response(child.stdout).text(),
    };
  };
  try {
    for (const checkout of ["first", "second"]) {
      const dir = join(root, checkout);
      await mkdir(dir);
      await writeFile(
        join(dir, "bunfig.toml"),
        '[test]\npreload = ["./preload.ts"]\n',
      );
      await writeFile(
        join(dir, "preload.ts"),
        `
import { acquireTestLock } from ${JSON.stringify(join(import.meta.dir, "test-lock.ts"))};
await Bun.write(process.env.FIXTURE_ROOT + "/" + process.env.FIXTURE_NAME + ".loading", "");
await acquireTestLock(${JSON.stringify(lock)}, 200);
`,
      );
      await writeFile(
        join(dir, "fixture.test.ts"),
        `
import { test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
const prefix = process.env.FIXTURE_ROOT + "/" + process.env.FIXTURE_NAME;
test("two-second fixture", async () => {
  if (process.env.FIXTURE_HOLDER) {
    let state = "exited";
    try {
      state = readFileSync("/proc/" + process.env.FIXTURE_HOLDER + "/stat", "utf8").split(") ")[1][0];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    writeFileSync(prefix + ".holder-state", state);
  }
  writeFileSync(prefix + ".start", String(Date.now()));
  while (!(await Bun.file(prefix + ".release").exists())) await Bun.sleep(10);
  await Bun.sleep(2000);
  writeFileSync(prefix + ".end", String(Date.now()));
}, 60000);
`,
      );
    }
    const holder = start("first", "holder");
    await waitForFile(join(root, "holder.start"));
    const waiter = start("second", "waiter", holder.child.pid);
    await waitForFile(join(root, "waiter.loading"));
    while (
      !(await Bun.file(waiter.stderrPath).text()).includes(
        "Waiting for test lock",
      )
    )
      await Bun.sleep(10);
    expect(await Bun.file(join(root, "waiter.start")).exists()).toBe(false);
    await writeFile(join(root, "holder.release"), "");
    expect(await holder.child.exited).toBe(0);
    await waitForFile(join(root, "waiter.start"));
    const exited = Number(await readFile(join(root, "holder.end"), "utf8"));
    const started = Number(await readFile(join(root, "waiter.start"), "utf8"));
    expect(started).toBeGreaterThanOrEqual(exited);
    expect(["exited", "Z", "X"]).toContain(
      await readFile(join(root, "waiter.holder-state"), "utf8"),
    );
    await writeFile(join(root, "waiter.release"), "");
    expect(await waiter.child.exited).toBe(0);
    expect(await Bun.file(holder.stderrPath).text()).not.toContain(
      "Waiting for test lock",
    );
    expect(await Bun.file(waiter.stderrPath).text()).toMatch(
      new RegExp(
        `Waiting for test lock held by PID ${holder.child.pid} \\(\\d+s elapsed\\)`,
      ),
    );

    const doomed = start("first", "doomed");
    await waitForFile(join(root, "doomed.start"));
    const survivor = start("second", "survivor");
    await waitForFile(join(root, "survivor.loading"));
    await Bun.sleep(100);
    expect(await Bun.file(join(root, "survivor.start")).exists()).toBe(false);
    const killed = performance.now();
    doomed.child.kill("SIGKILL");
    await doomed.child.exited;
    await waitForFile(join(root, "survivor.start"), 2000);
    expect(performance.now() - killed).toBeLessThan(2000);
    await writeFile(join(root, "survivor.release"), "");
    expect(await survivor.child.exited).toBe(0);
    expect(await Bun.file(survivor.stderrPath).text()).not.toContain(
      "Waiting for test lock",
    );
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await Promise.all(children.map((child) => child.exited));
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
