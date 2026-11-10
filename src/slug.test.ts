import { expect, test } from "bun:test";
import { isSlug, slugify, unslugify } from "./slug";

test("empty slug inputs", () => {
  for (const input of [
    "",
    "   ",
    "\t",
    "\n",
    " \t\n ",
    "!.,?",
    "---",
    " -\t!\n-- ",
  ]) {
    expect(slugify(input)).toBe("");
  }
});

test("replaces runs of non-alphanumerics with one dash", () => {
  expect(slugify("  Hello,  World! ")).toBe("hello-world");
});

test("folds accented letters to ASCII", () => {
  expect(slugify("Crème Brûlée")).toBe("creme-brulee");
});

test("truncates to 40 characters", () => {
  expect(slugify("a".repeat(50))).toBe("a".repeat(40));
});

test("slugify is idempotent", () => {
  for (const [input, expected] of [
    ["hello-world", "hello-world"],
    ["abc-123", "abc-123"],
    ["Hello WORLD 123", "hello-world-123"],
    ["Crème Brûlée", "creme-brulee"],
    ["", ""],
    ["a".repeat(50), "a".repeat(40)],
    ["a".repeat(39) + " bc", "a".repeat(39)],
  ]) {
    const slug = slugify(input);
    expect(slug).toBe(expected);
    expect(slugify(slug)).toBe(slug);
  }
});

test("truncated slug stays valid", () => {
  const truncated = slugify("a".repeat(39) + " b");
  expect(truncated).toBe("a".repeat(39));
  expect(isSlug(truncated)).toBe(true);

  const beforeCutoff = slugify("a".repeat(38) + " bc");
  expect(beforeCutoff).toBe("a".repeat(38) + "-b");
  expect(isSlug(beforeCutoff)).toBe(true);

  const afterCutoff = slugify("a".repeat(40) + " b");
  expect(afterCutoff).toBe("a".repeat(40));
  expect(isSlug(afterCutoff)).toBe(true);
});

test("turns every dash back into a space", () => {
  expect(unslugify("hello-world-again")).toBe("hello world again");
});

test("reject unicode lookalikes", () => {
  for (const { input, valid } of [
    { input: "ａｂｃ", valid: false },
    { input: "a-٠", valid: false },
    { input: "a-０", valid: false },
    { input: "а-с", valid: false },
    { input: "e\u0301", valid: false },
    { input: "a-😀", valid: false },
    { input: "a–b", valid: false },
    { input: "a-0", valid: true },
    { input: "abc-123", valid: true },
  ]) {
    expect(isSlug(input)).toBe(valid);
  }
});

test("unslugify edge inputs", () => {
  for (const [input, expected] of [
    ["", ""],
    ["Crème 日本語", "Crème 日本語"],
    ["-a", " a"],
    ["a-", "a "],
    ["a--b", "a  b"],
    ["-a--b-", " a  b "],
    ["a–b", "a–b"],
  ]) {
    expect(unslugify(input)).toBe(expected);
  }
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
