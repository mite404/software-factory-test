import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Create a private per-factory bearer token during setup, preserving an existing token.
 * @throws On failed I/O.
 */
export function installControlToken(directory: string) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "control-token");
  if (!existsSync(path))
    writeFileSync(path, randomBytes(32).toString("hex") + "\n", {
      flag: "wx",
      mode: 0o600,
    });
}

/** Check a bearer token without exposing it or creating storage. Missing tokens fail closed. */
export function authorizedControl(
  directory: string,
  authorization: string | null,
) {
  try {
    const token = readFileSync(join(directory, "control-token"), "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(token)) return false;
    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(authorization ?? "");
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  } catch {
    return false;
  }
}
