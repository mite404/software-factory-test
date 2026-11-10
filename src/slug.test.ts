import { expect, test } from "bun:test";
import { isSlug, slugify, unslugify } from "./slug";

test("replaces runs of non-alphanumerics with one dash", () => {
  expect(slugify("  Hello,  World! ")).toBe("hello-world");
});

test("folds accented letters to ASCII", () => {
  expect(slugify("Crème Brûlée")).toBe("creme-brulee");
});

test("truncates to 40 characters", () => {
  expect(slugify("a".repeat(50))).toBe("a".repeat(40));
});

test("turns every dash back into a space", () => {
  expect(unslugify("hello-world-again")).toBe("hello world again");
});

test("recognizes only already-valid slugs", () => {
  for (const s of ["a", "0", "a-b", "abc-123", "a".repeat(40)]) {
    expect(isSlug(s)).toBe(true);
  }
  for (const s of [
    "",
    "A b",
    "-a",
    "a-",
    "a--b",
    "a_b",
    "é",
    "a\n",
    "a".repeat(41),
  ]) {
    expect(isSlug(s)).toBe(false);
  }
});
