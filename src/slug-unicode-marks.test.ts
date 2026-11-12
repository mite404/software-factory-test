import { expect, test } from "bun:test";
import { slugify } from "./slug";

test("removes combining marks outside the basic accent range without separators", () => {
  expect(slugify("a\u1AB0b")).toBe("ab");
  expect(slugify("a\u1DC0b")).toBe("ab");
  expect(slugify("a\uFE20b")).toBe("ab");
});

test("reduces an all-mark input to an empty slug", () => {
  expect(slugify("\u1AB0\u1DC0\uFE20")).toBe("");
});

test("normalizes normal ASCII text", () => {
  expect(slugify("Hello World 123")).toBe("hello-world-123");
});
