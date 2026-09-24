import { describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { applyEdits } from "./apply.ts";
import { insertModuleListEntry, renameStringLiterals, setModuleConfigProperties } from "./edits.ts";
import { removeDependency, setDependencyRange } from "./packageJson.ts";

function parsePkg(text: string): { dependencies: Record<string, string> } {
  return boundaryCast<{ dependencies: Record<string, string> }>(JSON.parse(text), "json");
}

const CONFIG_SINGLE_LINE = `export default defineConfig({ modules: [{ use: "kestrel-events-inmemory" }, { use: "kestrel-persistence-sqlite", config: { file: "./data/kestrel.db" } }], triggers: [] });\n`;

const CONFIG_MULTILINE = `export default defineConfig({
  modules: [
    { use: "kestrel-events-inmemory" },
    { use: "kestrel-persistence-sqlite", config: { file: "./data/kestrel.db" } },
  ],
  triggers: [],
});
`;

describe("insertModuleListEntry", () => {
  it("inserts inline after the anchor on a single-line array", () => {
    const edit = insertModuleListEntry("kestrel.config.ts", CONFIG_SINGLE_LINE, { anchorUse: "kestrel-events-inmemory", position: "after", use: "kestrel-events-direct" });
    expect(edit).toBeDefined();
    const { text } = applyEdits(CONFIG_SINGLE_LINE, [edit!]);
    expect(text).toContain('{ use: "kestrel-events-inmemory" }, { use: "kestrel-events-direct" }, { use: "kestrel-persistence-sqlite"');
  });

  it("inserts on its own line, matching indentation, on a multi-line array", () => {
    const edit = insertModuleListEntry("kestrel.config.ts", CONFIG_MULTILINE, { anchorUse: "kestrel-events-inmemory", position: "after", use: "kestrel-events-direct" });
    expect(edit).toBeDefined();
    const { text } = applyEdits(CONFIG_MULTILINE, [edit!]);
    expect(text).toContain('    { use: "kestrel-events-inmemory" },\n    { use: "kestrel-events-direct" },\n    { use: "kestrel-persistence-sqlite"');
  });

  it("returns undefined when the anchor is not found, for a manual fallback", () => {
    const edit = insertModuleListEntry("kestrel.config.ts", CONFIG_SINGLE_LINE, { anchorUse: "nope", position: "after", use: "x" });
    expect(edit).toBeUndefined();
  });

  it("is idempotent: applying the same insert twice does not duplicate on a re-run against fixed source", () => {
    const first = insertModuleListEntry("kestrel.config.ts", CONFIG_MULTILINE, { anchorUse: "kestrel-events-inmemory", position: "after", use: "kestrel-events-direct" });
    const { text: fixed } = applyEdits(CONFIG_MULTILINE, [first!]);
    const second = insertModuleListEntry("kestrel.config.ts", fixed, { anchorUse: "kestrel-events-inmemory", position: "after", use: "kestrel-events-direct" });
    expect(second).toBeUndefined();
  });
});

describe("setModuleConfigProperties", () => {
  it("adds a property to an existing config object literal", () => {
    const edit = setModuleConfigProperties("kestrel.config.ts", CONFIG_SINGLE_LINE, { use: "kestrel-persistence-sqlite", assignments: { acquireTimeoutMs: "15000" } });
    const { text } = applyEdits(CONFIG_SINGLE_LINE, [edit!]);
    expect(text).toContain('config: { file: "./data/kestrel.db", acquireTimeoutMs: 15000 }');
  });

  it("replaces an existing property's value instead of duplicating the key", () => {
    const source = 'export default defineConfig({ modules: [{ use: "kestrel-persistence-sqlite", config: { file: "x", acquireTimeoutMs: 3000 } }], triggers: [] });\n';
    const edit = setModuleConfigProperties("kestrel.config.ts", source, { use: "kestrel-persistence-sqlite", assignments: { acquireTimeoutMs: "15000" } });
    const { text } = applyEdits(source, [edit!]);
    expect(text).toContain('config: { file: "x", acquireTimeoutMs: 15000 }');
    expect(text.match(/acquireTimeoutMs/g)).toHaveLength(1);
  });

  it("creates config: {} when the entry has none", () => {
    const edit = setModuleConfigProperties("kestrel.config.ts", CONFIG_SINGLE_LINE, { use: "kestrel-events-inmemory", assignments: { relayPipelines: "[]" } });
    const { text } = applyEdits(CONFIG_SINGLE_LINE, [edit!]);
    expect(text).toContain('{ use: "kestrel-events-inmemory", config: { relayPipelines: [] } }');
  });
});

describe("renameStringLiterals", () => {
  it("renames every matching string literal, keeping the quote style", () => {
    const source = `definePipeline({ name: "deleteMediaFolder", steps: ["media.folderItems", "media.delete:folder"] });\n`;
    const edits = renameStringLiterals("pipelines/deleteMediaFolder.ts", source, "media.folderItems", "media.listFolderItems");
    expect(edits).toHaveLength(1);
    const { text } = applyEdits(source, edits);
    expect(text).toContain('"media.listFolderItems"');
    expect(text).not.toContain('"media.folderItems"');
  });

  it("finds no occurrence and returns an empty list", () => {
    const source = `definePipeline({ name: "p", steps: ["media.upload"] });\n`;
    expect(renameStringLiterals("p.ts", source, "media.folderItems", "media.listFolderItems")).toEqual([]);
  });
});

describe("package.json dependency edits", () => {
  const PKG = `{
  "name": "app",
  "dependencies": {
    "@michaelthielemann/kestrel": "^5.8.0",
    "@michaelthielemann/kestrel-events-inmemory": "^5.8.0",
    "zod": "^3.23.8"
  }
}
`;

  it("sets the range of an existing dependency", () => {
    const edit = setDependencyRange("package.json", PKG, "dependencies", "@michaelthielemann/kestrel", "^6.0.0");
    const { text } = applyEdits(PKG, [edit]);
    expect(text).toContain('"@michaelthielemann/kestrel": "^6.0.0"');
    expect(parsePkg(text)).toBeTruthy();
  });

  it("adds a new dependency alphabetically", () => {
    const edit = setDependencyRange("package.json", PKG, "dependencies", "@michaelthielemann/kestrel-events-direct", "^6.0.0");
    const { text } = applyEdits(PKG, [edit]);
    const parsed = parsePkg(text);
    expect(parsed.dependencies["@michaelthielemann/kestrel-events-direct"]).toBe("^6.0.0");
    expect(Object.keys(parsed.dependencies)).toEqual(["@michaelthielemann/kestrel", "@michaelthielemann/kestrel-events-direct", "@michaelthielemann/kestrel-events-inmemory", "zod"]);
  });

  it("creates the dependencies map when the project has none", () => {
    const noDeps = `{\n  "name": "app"\n}\n`;
    const edit = setDependencyRange("package.json", noDeps, "dependencies", "@michaelthielemann/kestrel-events-direct", "^6.0.0");
    const { text } = applyEdits(noDeps, [edit]);
    const parsed = parsePkg(text);
    expect(parsed.dependencies["@michaelthielemann/kestrel-events-direct"]).toBe("^6.0.0");
  });

  it("removes a dependency", () => {
    const edit = removeDependency("package.json", PKG, "dependencies", "@michaelthielemann/kestrel-events-inmemory");
    const { text } = applyEdits(PKG, [edit!]);
    const parsed = parsePkg(text);
    expect(parsed.dependencies["@michaelthielemann/kestrel-events-inmemory"]).toBeUndefined();
    expect(parsed.dependencies["zod"]).toBe("^3.23.8");
  });
});
