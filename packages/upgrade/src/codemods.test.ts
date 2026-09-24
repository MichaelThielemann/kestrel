import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { applyEdits, combineEditParts, verifiesAfterEdit, type Edit } from "./codemods.ts";

const PACKAGE_JSON = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");

describe("./codemods package export", () => {
  it("is published in both the dev and publishConfig exports maps", () => {
    const pkg = boundaryCast<{ exports: Record<string, unknown>; publishConfig: { exports: Record<string, unknown> } }>(JSON.parse(readFileSync(PACKAGE_JSON, "utf8")), "json");
    expect(Object.keys(pkg.exports)).toContain("./codemods");
    expect(Object.keys(pkg.publishConfig.exports)).toContain("./codemods");
  });
});

describe("the edit, verify and all-or-nothing combine primitives", () => {
  it("apply an edit and verify the result", () => {
    const source = 'export default { a: 1, b: 2 };\n';
    const edit: Edit = { file: "config.ts", start: source.indexOf("1"), end: source.indexOf("1") + 1, text: "99" };
    const { text } = applyEdits(source, [edit]);
    expect(text).toContain("a: 99");
    expect(verifiesAfterEdit("config.ts", text)).toBe(true);
  });

  it("rejects a result that would leave an array hole", () => {
    const broken = "export default [1, , 2];\n";
    expect(verifiesAfterEdit("config.ts", broken)).toBe(false);
  });

  it("verifies JSON by file extension, not by content shape", () => {
    expect(verifiesAfterEdit("package.json", '{ "a": 1 }')).toBe(true);
    expect(verifiesAfterEdit("package.json", "{ not json")).toBe(false);
  });

  it("combines multi-part edits into one all-or-nothing set, naming what is missing", () => {
    const partA: Edit[] = [{ file: "a.ts", start: 0, end: 0, text: "x" }];
    const ok = combineEditParts({ "part a": partA, "part b": [] });
    expect(ok.edits).toEqual(partA);
    expect(ok.missing).toEqual([]);

    const missingPart = combineEditParts({ "part a": partA, "part b": undefined });
    expect(missingPart.edits).toEqual([]);
    expect(missingPart.missing).toEqual(["part b"]);
  });
});
