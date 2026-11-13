import type { Bookkeeping } from "./native";

/** Test double for external bookkeeping; factory Git and SQLite operations remain real. */
export function openStore(): Bookkeeping {
  return {
    async init() {},
    async close() {},
    ledger: { async record() {} },
  };
}
