import { expect, test } from "bun:test";
import { unslugify } from "./slug";

test("preserves 41 ASCII letters without truncation", () => {
  expect(unslugify("abcdefghijklmnopqrstuvwxyzabcdefghijklmno")).toBe(
    "abcdefghijklmnopqrstuvwxyzabcdefghijklmno",
  );
});

test("replaces dashes and preserves the complete suffix beyond 40 characters", () => {
  expect(unslugify("abcdefghijklmnopqrstuvwxyzabcdefghijklm-tail-end")).toBe(
    "abcdefghijklmnopqrstuvwxyzabcdefghijklm tail end",
  );
});

test("preserves Unicode text exactly after the 40-character boundary", () => {
  expect(
    unslugify(
      "abcdefghijklmnopqrstuvwxyzabcdefghijklmnCrème-日本語-😀-e\u0301",
    ),
  ).toBe("abcdefghijklmnopqrstuvwxyzabcdefghijklmnCrème 日本語 😀 e\u0301");
});
