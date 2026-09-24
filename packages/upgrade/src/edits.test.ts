import { describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { applyEdits } from "./apply.ts";
import { parseTs } from "./ast.ts";
import { addModuleEmits, insertModuleListEntry, insertModulesTsEntry, insertPipelineStep, insertStepAfterEmitOutsideGroup, markStepBinary, renameContentField, renameStringLiterals, replaceModuleListEntry, replaceModulesTsEntry, setModuleConfigProperties, setStepRequired } from "./edits.ts";
import { removeDependency, replaceDependency, setDependencyRange } from "./packageJson.ts";

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

  it("adds the comma a comma-less last anchor is missing, and the result re-parses", () => {
    const source = `export default defineConfig({
  modules: [
    { use: "kestrel-persistence-sqlite", config: { file: "./data/kestrel.db" } },
    { use: "kestrel-events-inmemory" }
  ],
  triggers: [],
});
`;
    const edit = insertModuleListEntry("kestrel.config.ts", source, { anchorUse: "kestrel-events-inmemory", position: "after", use: "kestrel-events-direct" });
    const { text } = applyEdits(source, [edit!]);
    expect(text).toContain('{ use: "kestrel-events-inmemory" },\n    { use: "kestrel-events-direct" },\n  ],');
    expect(() => parseTs(text)).not.toThrow();
  });

  it("matches the file's own single-quote style instead of always inserting double quotes", () => {
    const source = `export default defineConfig({
  modules: [
    { use: 'kestrel-events-inmemory' },
    { use: 'kestrel-persistence-sqlite' },
  ],
  triggers: [],
});
`;
    const edit = insertModuleListEntry("kestrel.config.ts", source, { anchorUse: "kestrel-events-inmemory", position: "after", use: "kestrel-events-direct" });
    const { text } = applyEdits(source, [edit!]);
    expect(text).toContain("{ use: 'kestrel-events-direct' }");
  });

  it("inserts with the file's own CRLF line ending instead of a bare LF", () => {
    const source = CONFIG_MULTILINE.replace(/\n/g, "\r\n");
    const edit = insertModuleListEntry("kestrel.config.ts", source, { anchorUse: "kestrel-events-inmemory", position: "after", use: "kestrel-events-direct" });
    const { text } = applyEdits(source, [edit!]);
    expect(text).toContain('{ use: "kestrel-events-inmemory" },\r\n    { use: "kestrel-events-direct" },\r\n');
    expect(text).not.toMatch(/[^\r]\n/);
  });
});

describe("setModuleConfigProperties", () => {
  it("adds a property to an existing config object literal", () => {
    const edits = setModuleConfigProperties("kestrel.config.ts", CONFIG_SINGLE_LINE, { use: "kestrel-persistence-sqlite", assignments: { acquireTimeoutMs: "15000" } });
    const { text } = applyEdits(CONFIG_SINGLE_LINE, edits!);
    expect(text).toContain('config: { file: "./data/kestrel.db", acquireTimeoutMs: 15000 }');
  });

  it("replaces an existing property's value instead of duplicating the key", () => {
    const source = 'export default defineConfig({ modules: [{ use: "kestrel-persistence-sqlite", config: { file: "x", acquireTimeoutMs: 3000 } }], triggers: [] });\n';
    const edits = setModuleConfigProperties("kestrel.config.ts", source, { use: "kestrel-persistence-sqlite", assignments: { acquireTimeoutMs: "15000" } });
    const { text } = applyEdits(source, edits!);
    expect(text).toContain('config: { file: "x", acquireTimeoutMs: 15000 }');
    expect(text.match(/acquireTimeoutMs/g)).toHaveLength(1);
  });

  it("creates config: {} when the entry has none", () => {
    const edits = setModuleConfigProperties("kestrel.config.ts", CONFIG_SINGLE_LINE, { use: "kestrel-events-inmemory", assignments: { relayPipelines: "[]" } });
    const { text } = applyEdits(CONFIG_SINGLE_LINE, edits!);
    expect(text).toContain('{ use: "kestrel-events-inmemory", config: { relayPipelines: [] } }');
  });

  it("only splices the replaced property's value, leaving an unrelated comment on another property untouched", () => {
    const source = `export default defineConfig({
  modules: [
    {
      use: "kestrel-persistence-sqlite",
      config: {
        file: "x", // production path
        acquireTimeoutMs: 3000,
      },
    },
  ],
  triggers: [],
});
`;
    const edits = setModuleConfigProperties("kestrel.config.ts", source, { use: "kestrel-persistence-sqlite", assignments: { acquireTimeoutMs: "15000" } });
    const { text } = applyEdits(source, edits!);
    expect(text).toContain('file: "x", // production path');
    expect(text).toContain("acquireTimeoutMs: 15000");
  });

  it("preserves a spread element by refusing to rewrite the config, leaving it manual", () => {
    const source = 'export default defineConfig({ modules: [{ use: "kestrel-persistence-sqlite", config: { ...sqliteBase, busyTimeoutMs: 8000 } }], triggers: [] });\n';
    const edits = setModuleConfigProperties("kestrel.config.ts", source, { use: "kestrel-persistence-sqlite", assignments: { acquireTimeoutMs: "15000" } });
    expect(edits).toBeUndefined();
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

  it("adds the comma the previous last entry was missing when a new entry sorts after every existing one", () => {
    const edit = setDependencyRange("package.json", PKG, "dependencies", "zzz-last", "^1.0.0");
    const { text } = applyEdits(PKG, [edit]);
    const parsed = parsePkg(text);
    expect(parsed.dependencies["zzz-last"]).toBe("^1.0.0");
    expect(parsed.dependencies["zod"]).toBe("^3.23.8");
  });

  it("adds the missing comma when the map is not alphabetically sorted and the new entry is appended after the last one", () => {
    const unsorted = `{\n  "dependencies": {\n    "@michaelthielemann/kestrel": "^5.8.0",\n    "@michaelthielemann/kestrel-events-inmemory": "^5.8.0",\n    "@michaelthielemann/kestrel-events-direct": "^5.8.0"\n  }\n}\n`;
    const edit = setDependencyRange("package.json", unsorted, "dependencies", "@michaelthielemann/kestrel-events-queue", "^6.0.0");
    const { text } = applyEdits(unsorted, [edit]);
    const parsed = parsePkg(text);
    expect(parsed.dependencies["@michaelthielemann/kestrel-events-direct"]).toBe("^5.8.0");
    expect(parsed.dependencies["@michaelthielemann/kestrel-events-queue"]).toBe("^6.0.0");
  });

  it("replaceDependency swaps an unsorted, last, newly-appended entry for a new one without a double comma", () => {
    const unsorted = `{\n  "dependencies": {\n    "@michaelthielemann/kestrel": "^6.0.0",\n    "@michaelthielemann/kestrel-persistence-sqlite": "^6.0.0",\n    "@michaelthielemann/kestrel-insights": "^6.0.0",\n    "@michaelthielemann/kestrel-events-direct": "^6.0.0"\n  }\n}\n`;
    const edits = replaceDependency("package.json", unsorted, "dependencies", "@michaelthielemann/kestrel-events-direct", "@michaelthielemann/kestrel-events-queue", "^6.0.0");
    const { text } = applyEdits(unsorted, edits);
    expect(text).not.toContain(",,");
    const parsed = parsePkg(text);
    expect(parsed.dependencies["@michaelthielemann/kestrel-events-direct"]).toBeUndefined();
    expect(parsed.dependencies["@michaelthielemann/kestrel-events-queue"]).toBe("^6.0.0");
    expect(parsed.dependencies["@michaelthielemann/kestrel-insights"]).toBe("^6.0.0");
  });

  it("replaceDependency falls back to remove-plus-set when the target name already has its own entry", () => {
    const source = `{\n  "dependencies": {\n    "@michaelthielemann/kestrel-events-direct": "^6.0.0",\n    "@michaelthielemann/kestrel-events-queue": "^5.0.0"\n  }\n}\n`;
    const edits = replaceDependency("package.json", source, "dependencies", "@michaelthielemann/kestrel-events-direct", "@michaelthielemann/kestrel-events-queue", "^6.0.0");
    const { text } = applyEdits(source, edits);
    const parsed = parsePkg(text);
    expect(parsed.dependencies["@michaelthielemann/kestrel-events-direct"]).toBeUndefined();
    expect(parsed.dependencies["@michaelthielemann/kestrel-events-queue"]).toBe("^6.0.0");
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

describe("insertPipelineStep", () => {
  const PIPELINE = `definePipeline({ name: "retryReassignRevisionAuthor", steps: ["authn.requireUser", "revisions.reassignAuthor"] });\n`;

  it("inserts a step before the anchor in a flat step list", () => {
    const edit = insertPipelineStep("p.ts", PIPELINE, { pipelineName: "retryReassignRevisionAuthor", anchorStep: "revisions.reassignAuthor", position: "before", newStep: "authn.verifyUser:reassignTo" });
    const { text } = applyEdits(PIPELINE, [edit!]);
    expect(text).toContain('"authn.requireUser", "authn.verifyUser:reassignTo", "revisions.reassignAuthor"');
  });

  it("inserts inside an atomic group when the anchor is grouped", () => {
    const source = `definePipeline({ name: "p", steps: [{ atomic: ["content.set", "revisions.reassignAuthor"] }] });\n`;
    const edit = insertPipelineStep("p.ts", source, { pipelineName: "p", anchorStep: "revisions.reassignAuthor", position: "before", newStep: "authn.verifyUser:result.reassignTo" });
    const { text } = applyEdits(source, [edit!]);
    expect(text).toContain('{ atomic: ["content.set", "authn.verifyUser:result.reassignTo", "revisions.reassignAuthor"] }');
  });

  it("is idempotent", () => {
    const first = insertPipelineStep("p.ts", PIPELINE, { pipelineName: "retryReassignRevisionAuthor", anchorStep: "revisions.reassignAuthor", position: "before", newStep: "authn.verifyUser:reassignTo" });
    const { text: fixed } = applyEdits(PIPELINE, [first!]);
    expect(insertPipelineStep("p.ts", fixed, { pipelineName: "retryReassignRevisionAuthor", anchorStep: "revisions.reassignAuthor", position: "before", newStep: "authn.verifyUser:reassignTo" })).toBeUndefined();
  });

  it("returns undefined for an unknown pipeline or anchor", () => {
    expect(insertPipelineStep("p.ts", PIPELINE, { pipelineName: "nope", anchorStep: "revisions.reassignAuthor", position: "before", newStep: "x" })).toBeUndefined();
    expect(insertPipelineStep("p.ts", PIPELINE, { pipelineName: "retryReassignRevisionAuthor", anchorStep: "nope.step", position: "before", newStep: "x" })).toBeUndefined();
  });

  it("inserts directly before the anchor, not at the start of a line several steps share", () => {
    const source = `definePipeline({
  name: "reassign",
  steps: [
    "authn.requireUser", "authz.require:users.manage", "revisions.reassignAuthor",
  ],
});
`;
    const edit = insertPipelineStep("p.ts", source, { pipelineName: "reassign", anchorStep: "revisions.reassignAuthor", position: "before", newStep: "authn.verifyUser:reassignTo" });
    const { text } = applyEdits(source, [edit!]);
    expect(text).toContain('"authn.requireUser", "authz.require:users.manage", "authn.verifyUser:reassignTo", "revisions.reassignAuthor",');
    expect(text.indexOf("authn.requireUser")).toBeLessThan(text.indexOf("authn.verifyUser:reassignTo"));
    expect(text.indexOf("authz.require")).toBeLessThan(text.indexOf("authn.verifyUser:reassignTo"));
  });
});

describe("renameContentField", () => {
  const CONFIG = `export default defineConfig({ modules: [{ use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { kind: "multi", fields: { _hint: { type: "string" }, title: { type: "string" } } } } } }], triggers: [] });\n`;

  it("renames an unquoted field key", () => {
    const edit = renameContentField("kestrel.config.ts", CONFIG, { use: "@michaelthielemann/kestrel-content-default", typeName: "page", from: "_hint", to: "hint" });
    const { text } = applyEdits(CONFIG, [edit!]);
    expect(text).toContain("fields: { hint: { type: \"string\" }, title:");
  });

  it("returns undefined for an unknown field or type", () => {
    expect(renameContentField("kestrel.config.ts", CONFIG, { use: "@michaelthielemann/kestrel-content-default", typeName: "page", from: "_nope", to: "nope" })).toBeUndefined();
    expect(renameContentField("kestrel.config.ts", CONFIG, { use: "@michaelthielemann/kestrel-content-default", typeName: "nope", from: "_hint", to: "hint" })).toBeUndefined();
  });
});

describe("addModuleEmits", () => {
  it("adds emits: [...] to a module literal with none", () => {
    const source = `export default defineModule({ name: "migrations/default", provides: [], requires: [], configSchema, setup });\n`;
    const edit = addModuleEmits("module.ts", source, ["migrations.applied"]);
    const { text } = applyEdits(source, [edit!]);
    expect(text).toContain('defineModule({ name: "migrations/default", emits: ["migrations.applied"], provides:');
  });

  it("extends an existing emits array without duplicating an already-listed event", () => {
    const source = `export default defineModule({ name: "m/one", emits: ["a.one"], provides: [], requires: [], configSchema, setup });\n`;
    const edit = addModuleEmits("module.ts", source, ["a.one", "a.two"]);
    const { text } = applyEdits(source, [edit!]);
    expect(text).toContain('emits: ["a.one", "a.two"]');
  });

  it("returns undefined once every event is already listed", () => {
    const source = `export default defineModule({ name: "m/one", emits: ["a.one"], provides: [], requires: [], configSchema, setup });\n`;
    expect(addModuleEmits("module.ts", source, ["a.one"])).toBeUndefined();
  });
});

describe("markStepBinary", () => {
  const MODULE = `export default defineModule({ name: "notes/local", describe: () => ({ create: { summary: "create", reads: [], writes: ["result"] } }) });\n`;

  it("adds binary: true to the named step's describe entry", () => {
    const edit = markStepBinary("module.ts", MODULE, "create");
    const { text } = applyEdits(MODULE, [edit!]);
    expect(text).toContain('writes: ["result"], binary: true');
  });

  it("returns undefined once binary is already set", () => {
    const withBinary = `export default defineModule({ describe: () => ({ create: { summary: "x", reads: [], writes: ["result"], binary: true } }) });\n`;
    expect(markStepBinary("module.ts", withBinary, "create")).toBeUndefined();
  });

  it("returns undefined for an unknown step", () => {
    expect(markStepBinary("module.ts", MODULE, "nope")).toBeUndefined();
  });
});

describe("setStepRequired", () => {
  const MODULE = `export default defineModule({ describe: () => ({ create: { summary: "create", reads: [], writes: ["result"], output: { type: "object", properties: { id: { type: "string" } } } } }) });\n`;

  it("adds required to the step's output schema", () => {
    const edit = setStepRequired("module.ts", MODULE, "create", ["id"]);
    const { text } = applyEdits(MODULE, [edit!]);
    expect(text).toContain('properties: { id: { type: "string" } }, required: ["id"]');
  });

  it("replaces an existing required array", () => {
    const withRequired = `export default defineModule({ describe: () => ({ create: { summary: "x", reads: [], writes: ["result"], output: { type: "object", properties: {}, required: ["old"] } } }) });\n`;
    const edit = setStepRequired("module.ts", withRequired, "create", []);
    const { text } = applyEdits(withRequired, [edit!]);
    expect(text).toContain('required: []');
  });
});

describe("replaceModuleListEntry", () => {
  it("replaces the whole entry with a new use and config", () => {
    const source = 'export default defineConfig({ modules: [{ use: "kestrel-events-inmemory" }, { use: "kestrel-events-direct" }], triggers: [] });\n';
    const edit = replaceModuleListEntry("kestrel.config.ts", source, { use: "kestrel-events-direct", newUse: "@michaelthielemann/kestrel-events-queue", config: '{ relayPipelines: ["publishPage"] }' });
    const { text } = applyEdits(source, [edit!]);
    expect(text).toContain('{ use: "@michaelthielemann/kestrel-events-queue", config: { relayPipelines: ["publishPage"] } }');
    expect(text).not.toContain("events-direct");
  });

  it("returns undefined when the entry is not found", () => {
    const source = 'export default defineConfig({ modules: [{ use: "kestrel-events-inmemory" }], triggers: [] });\n';
    expect(replaceModuleListEntry("kestrel.config.ts", source, { use: "kestrel-events-direct", newUse: "kestrel-events-queue" })).toBeUndefined();
  });
});

describe("insertStepAfterEmitOutsideGroup", () => {
  it("inserts right after the emit when it is not in a group", () => {
    const source = 'definePipeline({ name: "createPage", steps: ["content.create", "events.emit:page.created"] });\n';
    const edit = insertStepAfterEmitOutsideGroup("p.ts", source, { pipelineName: "createPage", emitStep: "events.emit:page.created", newStep: "events.relay" });
    const { text } = applyEdits(source, [edit!]);
    expect(text).toContain('"content.create", "events.emit:page.created", "events.relay"');
  });

  it("inserts after the whole atomic group, not inside it, when the emit is grouped", () => {
    const source = 'definePipeline({ name: "createPage", steps: [{ atomic: ["content.create", "events.emit:page.created"] }, "delivery.publish:pages"] });\n';
    const edit = insertStepAfterEmitOutsideGroup("p.ts", source, { pipelineName: "createPage", emitStep: "events.emit:page.created", newStep: "events.relay" });
    const { text } = applyEdits(source, [edit!]);
    expect(text).toContain('steps: [{ atomic: ["content.create", "events.emit:page.created"] }, "events.relay", "delivery.publish:pages"]');
  });

  it("is idempotent for the grouped case", () => {
    const source = 'definePipeline({ name: "createPage", steps: [{ atomic: ["content.create", "events.emit:page.created"] }] });\n';
    const first = insertStepAfterEmitOutsideGroup("p.ts", source, { pipelineName: "createPage", emitStep: "events.emit:page.created", newStep: "events.relay" });
    const { text: fixed } = applyEdits(source, [first!]);
    expect(insertStepAfterEmitOutsideGroup("p.ts", fixed, { pipelineName: "createPage", emitStep: "events.emit:page.created", newStep: "events.relay" })).toBeUndefined();
  });

  it("returns undefined for an unknown pipeline or emit step", () => {
    const source = 'definePipeline({ name: "createPage", steps: ["events.emit:page.created"] });\n';
    expect(insertStepAfterEmitOutsideGroup("p.ts", source, { pipelineName: "nope", emitStep: "events.emit:page.created", newStep: "events.relay" })).toBeUndefined();
    expect(insertStepAfterEmitOutsideGroup("p.ts", source, { pipelineName: "createPage", emitStep: "events.emit:nope", newStep: "events.relay" })).toBeUndefined();
  });
});

describe("insertModulesTsEntry", () => {
  const MODULES_TS = `import { pipelineDefiner, type StepCatalogue } from "@michaelthielemann/kestrel";
import eventsInmemory from "@michaelthielemann/kestrel-events-inmemory";
import persistenceSqlite from "@michaelthielemann/kestrel-persistence-sqlite";

const modules = [
  eventsInmemory,
  persistenceSqlite,
] as const;

export default modules;
export type KnownStep = StepCatalogue<typeof modules>;
export const definePipeline = pipelineDefiner<KnownStep>();
`;

  it("adds the import and the array entry for a module not yet listed", () => {
    const edits = insertModulesTsEntry("modules.ts", MODULES_TS, "@michaelthielemann/kestrel-events-direct");
    expect(edits).toBeDefined();
    const { text } = applyEdits(MODULES_TS, edits!);
    expect(text).toContain('import eventsDirect from "@michaelthielemann/kestrel-events-direct";');
    expect(text).toContain("  eventsInmemory,\n  persistenceSqlite,\n  eventsDirect,\n");
    expect(() => parseTs(text)).not.toThrow();
  });

  it("returns undefined once the package is already imported", () => {
    const withDirect = 'import eventsDirect from "@michaelthielemann/kestrel-events-direct";\n' + MODULES_TS;
    expect(insertModulesTsEntry("modules.ts", withDirect, "@michaelthielemann/kestrel-events-direct")).toBeUndefined();
  });

  it("returns undefined when the file is not the modules.ts array-of-identifiers shape", () => {
    const source = 'export default defineConfig({ modules: [{ use: "kestrel-events-inmemory" }], triggers: [] });\n';
    expect(insertModulesTsEntry("kestrel.config.ts", source, "@michaelthielemann/kestrel-events-direct")).toBeUndefined();
  });
});

describe("replaceModulesTsEntry", () => {
  const MODULES_TS = `import { pipelineDefiner, type StepCatalogue } from "@michaelthielemann/kestrel";
import eventsInmemory from "@michaelthielemann/kestrel-events-inmemory";
import eventsDirect from "@michaelthielemann/kestrel-events-direct";
import persistenceSqlite from "@michaelthielemann/kestrel-persistence-sqlite";

const modules = [
  eventsInmemory,
  eventsDirect,
  persistenceSqlite,
] as const;

export default modules;
export type KnownStep = StepCatalogue<typeof modules>;
export const definePipeline = pipelineDefiner<KnownStep>();
`;

  it("swaps the import and the array element in place", () => {
    const edits = replaceModulesTsEntry("modules.ts", MODULES_TS, "@michaelthielemann/kestrel-events-direct", "@michaelthielemann/kestrel-events-queue");
    expect(edits).toBeDefined();
    const { text } = applyEdits(MODULES_TS, edits!);
    expect(text).toContain('import eventsQueue from "@michaelthielemann/kestrel-events-queue";');
    expect(text).not.toContain("events-direct");
    expect(text).not.toContain("eventsDirect");
    expect(text).toContain("  eventsInmemory,\n  eventsQueue,\n  persistenceSqlite,\n");
    expect(() => parseTs(text)).not.toThrow();
  });

  it("returns undefined when the package is not imported there", () => {
    const withoutDirect = MODULES_TS.replace('import eventsDirect from "@michaelthielemann/kestrel-events-direct";\n', "").replace("  eventsDirect,\n", "");
    expect(replaceModulesTsEntry("modules.ts", withoutDirect, "@michaelthielemann/kestrel-events-direct", "@michaelthielemann/kestrel-events-queue")).toBeUndefined();
  });

  it("returns undefined when the file is not the modules.ts array-of-identifiers shape", () => {
    const source = 'export default defineConfig({ modules: [{ use: "@michaelthielemann/kestrel-events-direct" }], triggers: [] });\n';
    expect(replaceModulesTsEntry("kestrel.config.ts", source, "@michaelthielemann/kestrel-events-direct", "@michaelthielemann/kestrel-events-queue")).toBeUndefined();
  });
});
