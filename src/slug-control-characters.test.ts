import { expect, test } from "bun:test";
import { isSlug } from "./slug";

test("rejects ASCII control characters anywhere in a slug", () => {
  for (const control of ["\0", "\t", "\r", "\n", "\x7f", "\r\n"]) {
    for (const input of [
      control + "abc-123",
      "abc" + control + "-123",
      "abc-123" + control,
    ]) {
      expect(isSlug(input)).toBe(false);
    }
  }
});

test("accepts valid ASCII slugs as positive controls", () => {
  for (const input of ["a-b", "abc-123"]) {
    expect(isSlug(input)).toBe(true);
  }
});
