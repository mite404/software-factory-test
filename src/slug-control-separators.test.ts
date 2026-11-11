import { expect, test } from "bun:test";
import { slugify } from "./slug";

test("collapses control runs between words into one separator", () => {
  expect(slugify("Alpha\t\r\n\0Beta")).toBe("alpha-beta");
});

test("removes leading and trailing control runs", () => {
  expect(slugify("\t\r\n\0Alpha")).toBe("alpha");
  expect(slugify("Alpha\t\r\n\0")).toBe("alpha");
});

test("preserves the word boundary at a null character", () => {
  expect(slugify("a\0b")).toBe("a-b");
});
