import { expect, test } from "bun:test";
import { slugify } from "./slug";

test("normalizes dotted capital I before lowercasing", () => {
  expect(slugify("İSTANBUL")).toBe("istanbul");
});

test("discards capital sharp S without transliteration", () => {
  expect(slugify("ẞ")).toBe("");
});

test("discards Greek capitals after lowercasing", () => {
  expect(slugify("ΟΣ")).toBe("");
});
