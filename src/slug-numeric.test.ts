import { expect, test } from "bun:test";
import { slugify } from "./slug";

test("preserves ASCII digits and leading zeroes", () => {
  expect(slugify("000123")).toBe("000123");
});

test("preserves digits while normalizing version separators", () => {
  expect(slugify(" Version 2.0 ")).toBe("version-2-0");
});

test("discards fullwidth and Arabic-Indic digits", () => {
  expect(slugify("１２٣")).toBe("");
});
