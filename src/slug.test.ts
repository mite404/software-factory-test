import { expect, test } from "bun:test";
import { slugify, unslugify } from "./slug";

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
