import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  ftruncateSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";

/**
 * Take the machine's test lock; the OS releases it on exit or SIGKILL.
 * @param path An isolated lock file for fixture hosts; real runs use the fixed default.
 * @param noticeIntervalMs Fixture hosts can shorten the wait notice interval.
 * @throws If the lock file or the system flock command cannot be used.
 */
export async function acquireTestLock(
  path = "/tmp/software-factory-bun-test.lock",
  noticeIntervalMs = 30_000,
): Promise<void> {
  const fd = openSync(path, "a+");
  try {
    // flock shares Bun's open file description, so its exit does not release our lock.
    const attempt = spawnSync("/usr/bin/flock", ["-n", "-E", "75", "3"], {
      stdio: ["ignore", "ignore", "pipe", fd],
    });
    if (attempt.error) throw attempt.error;
    if (attempt.status === 75) {
      const started = performance.now();
      const notice = setInterval(() => {
        const holder = readFileSync(path, "utf8").trim() || "unknown";
        const seconds = Math.floor((performance.now() - started) / 1000);
        process.stderr.write(
          `Waiting for test lock held by PID ${holder} (${seconds}s elapsed)\n`,
        );
      }, noticeIntervalMs);
      try {
        await new Promise<void>((resolve, reject) => {
          const waiter = spawn("/usr/bin/flock", ["3"], {
            stdio: ["ignore", "ignore", "inherit", fd],
          });
          waiter.on("error", reject);
          waiter.on("exit", (code, signal) => {
            if (code === 0) resolve();
            else reject(new Error(`Test lock failed (${code ?? signal})`));
          });
        });
      } finally {
        clearInterval(notice);
      }
    } else if (attempt.status !== 0) {
      throw new Error(`Test lock failed (${attempt.status ?? attempt.signal})`);
    }
    ftruncateSync(fd, 0);
    writeSync(fd, `${process.pid}\n`, 0, "utf8");
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
