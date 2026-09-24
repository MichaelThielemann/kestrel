import { describe, expect, it } from "vitest";
import { applyEdits } from "./apply.ts";

describe("applyEdits", () => {
  it("splices non-overlapping edits in one pass", () => {
    const source = "abcdefgh";
    const { text, applied, conflicted } = applyEdits(source, [
      { file: "f", start: 1, end: 2, text: "X" },
      { file: "f", start: 5, end: 6, text: "Y" },
    ]);
    expect(text).toBe("aXcdeYgh");
    expect(applied).toHaveLength(2);
    expect(conflicted).toHaveLength(0);
  });

  it("lets an edit that fully contains an already-accepted one take its place", () => {
    const source = '  "a": "5.8.0",\n  "b": "1.0.0"\n';
    const bump = { file: "f", start: source.indexOf("5.8.0"), end: source.indexOf("5.8.0") + "5.8.0".length, text: "6.0.0" };
    const removeWholeLine = { file: "f", start: 0, end: source.indexOf("\n") + 1, text: "" };
    const { text, applied, conflicted } = applyEdits(source, [bump, removeWholeLine]);
    expect(text).toBe('  "b": "1.0.0"\n');
    expect(applied).toEqual([removeWholeLine]);
    expect(conflicted).toEqual([bump]);
  });

  it("keeps the edit with the higher start and drops the one it partially overlaps, on a genuine conflict", () => {
    const source = "abcdefgh";
    const higherStart = { file: "f", start: 4, end: 6, text: "Y" };
    const lowerStart = { file: "f", start: 2, end: 5, text: "X" };
    const { applied, conflicted } = applyEdits(source, [higherStart, lowerStart]);
    expect(applied).toEqual([higherStart]);
    expect(conflicted).toEqual([lowerStart]);
  });
});
