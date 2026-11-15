import { setDefaultTimeout } from "bun:test";
import { acquireTestLock } from "./test-lock";

setDefaultTimeout(20_000);
await acquireTestLock();
