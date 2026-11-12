import { expect, test } from "bun:test";
import { slugify } from "./slug";

test("Unicode spaces preserve word boundaries", () => {
  for (const space of ["\u00a0", "\u2003", "\u202f", "\u3000"]) {
    expect(slugify(`alpha${space}beta`)).toBe("alpha-beta");
  }
});

test("collapses mixed Unicode spaces, ASCII spaces, and dashes", () => {
  expect(slugify("alpha\u00a0 -\u2003 --\u202f \u3000-beta")).toBe(
    "alpha-beta",
  );
});

test("removes leading and trailing Unicode spaces", () => {
  for (const space of ["\u00a0", "\u2003", "\u202f", "\u3000"]) {
    expect(slugify(`${space}alpha`)).toBe("alpha");
    expect(slugify(`alpha${space}`)).toBe("alpha");
  }
});

test("all-Unicode-space input becomes empty", () => {
  expect(slugify("\u00a0\u2003\u202f\u3000")).toBe("");
});
