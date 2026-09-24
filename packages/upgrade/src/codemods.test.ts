import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { applyEdits, combineEditParts, replaceModuleListEntry, verifiesAfterEdit, type Edit } from "./codemods.ts";

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

describe("the module-list replacement primitive", () => {
  it("replaces a module-list entry with a new use and config, so a plugin's own switchEdits can build its module-list switch", () => {
    const source = 'export default defineConfig({ modules: [{ use: "@michaelthielemann/kestrel-events-direct" }], triggers: [] });\n';
    const edit = replaceModuleListEntry("kestrel.config.ts", source, { use: "@michaelthielemann/kestrel-events-direct", newUse: "@michaelthielemann/kestrel-events-queue", config: '{ relayPipelines: ["publishPage"] }' });
    expect(edit).toBeDefined();
    const { text } = applyEdits(source, [edit!]);
    expect(text).toContain('@michaelthielemann/kestrel-events-queue", config: { relayPipelines: ["publishPage"] }');
    expect(text).not.toContain("events-direct");
  });

  it("returns undefined when the entry is not found, so a plugin's switchEdits can report that part missing", () => {
    const source = 'export default defineConfig({ modules: [], triggers: [] });\n';
    expect(replaceModuleListEntry("kestrel.config.ts", source, { use: "@michaelthielemann/kestrel-events-direct", newUse: "@michaelthielemann/kestrel-events-queue" })).toBeUndefined();
  });
});
