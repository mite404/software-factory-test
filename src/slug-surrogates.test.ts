import { expect, test } from "bun:test";
import { slugify } from "./slug";

test("replaces lone high and low surrogates between words with one dash", () => {
  expect(slugify("hello\uD800world")).toBe("hello-world");
  expect(slugify("hello\uDC00world")).toBe("hello-world");
});

test("collapses mixed runs containing lone surrogates to one dash", () => {
  expect(slugify("hello\uDC00\uD800 -\uDC00\uD800world")).toBe("hello-world");
});

test("trims edge surrogates", () => {
  expect(slugify("\uD800hello-world\uDC00")).toBe("hello-world");
  expect(slugify("\uDC00hello-world\uD800")).toBe("hello-world");
});

test("returns empty for surrogate-only input", () => {
  for (const input of ["\uD800", "\uDC00", "\uDC00\uD800"]) {
    expect(slugify(input)).toBe("");
  }
});
