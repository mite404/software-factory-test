import { expect, test } from "bun:test";
import { slugify } from "./slug";

test("collapses emoji runs to one separator and removes edge dashes", () => {
  expect(slugify("a😀b")).toBe("a-b");
  expect(slugify("a👩‍💻🚀b")).toBe("a-b");
  expect(slugify("😀abc🚀")).toBe("abc");
});
