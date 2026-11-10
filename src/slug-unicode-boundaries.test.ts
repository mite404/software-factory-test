import { expect, test } from "bun:test";
import { isSlug, slugify } from "./slug";

test("canonical accents produce the same 40-character ASCII slug", () => {
  const prefix = "a".repeat(39);
  const expected = prefix + "e";

  for (const accent of ["\u00e9", "e\u0301"]) {
    const slug = slugify(prefix + accent);
    expect(slug).toBe(expected);
    expect(slug.length).toBe(40);
    expect(isSlug(slug)).toBe(true);
  }
});

test("removes combining marks before truncating an internal separator", () => {
  const prefix = "a".repeat(37);
  const expected = prefix + "e-b";

  for (const accent of ["\u00e9", "e\u0301"]) {
    const slug = slugify(prefix + accent + " bc");
    expect(slug).toBe(expected);
    expect(isSlug(slug)).toBe(true);
  }
});
