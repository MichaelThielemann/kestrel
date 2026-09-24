import { describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { applyEdits } from "./apply.ts";
import { findCalls, firstArgument, isArrayExpression, objectProperty, parseTs, type AstNode } from "./ast.ts";
import {
  addModuleEmits,
  createPipelineFile,
  insertModuleListEntry,
  insertModulesTsEntry,
  insertPipelineStep,
  insertStepAfterEmitOutsideGroup,
  insertTrigger,
  insertTriggers,
  markStepBinary,
  newPipelineFileContent,
  removeModuleConfigProperty,
  renameContentField,
  replaceModuleConfigProperty,
  renameStringLiterals,
  replaceModuleListEntry,
  replaceModulesTsEntry,
  setModuleConfigProperties,
  setStepRequired,
  swapPipelineSteps,
  type ModelFieldsLocator,
  type StepListLocator,
} from "./edits.ts";
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

describe("removeModuleConfigProperty", () => {
  it("removes a property in the middle, keeping the ones before and after intact", () => {
    const source = 'export default defineConfig({ modules: [{ use: "kestrel-delivery-static", config: { prefix: "", media: { publicPath: "/media" }, fallback: true } }], triggers: [] });\n';
    const edit = removeModuleConfigProperty("kestrel.config.ts", source, { use: "kestrel-delivery-static", key: "media" });
    expect(edit).toBeDefined();
    const { text } = applyEdits(source, [edit!]);
    expect(text).toContain('config: { prefix: "", fallback: true }');
  });

  it("removes the last property, taking the preceding comma with it", () => {
    const source = 'export default defineConfig({ modules: [{ use: "kestrel-delivery-static", config: { prefix: "", media: { publicPath: "/media" } } }], triggers: [] });\n';
    const edit = removeModuleConfigProperty("kestrel.config.ts", source, { use: "kestrel-delivery-static", key: "media" });
    const { text } = applyEdits(source, [edit!]);
    expect(text).toContain('config: { prefix: "" }');
  });

  it("removes the only property, leaving an empty config object", () => {
    const source = 'export default defineConfig({ modules: [{ use: "kestrel-delivery-static", config: { media: { publicPath: "/media" } } }], triggers: [] });\n';
    const edit = removeModuleConfigProperty("kestrel.config.ts", source, { use: "kestrel-delivery-static", key: "media" });
    const { text } = applyEdits(source, [edit!]);
    expect(text).toContain("config: {  }");
  });

  it("returns undefined when the entry, its config, or the key cannot be found", () => {
    const source = 'export default defineConfig({ modules: [{ use: "kestrel-delivery-static", config: { prefix: "" } }], triggers: [] });\n';
    expect(removeModuleConfigProperty("kestrel.config.ts", source, { use: "kestrel-delivery-static", key: "media" })).toBeUndefined();
    expect(removeModuleConfigProperty("kestrel.config.ts", source, { use: "nope", key: "media" })).toBeUndefined();
    const noConfig = 'export default defineConfig({ modules: [{ use: "kestrel-delivery-static" }], triggers: [] });\n';
    expect(removeModuleConfigProperty("kestrel.config.ts", noConfig, { use: "kestrel-delivery-static", key: "media" })).toBeUndefined();
  });
});

describe("replaceModuleConfigProperty", () => {
  it("replaces a property's key and value together when it is one of several", () => {
    const source = 'export default defineConfig({ modules: [{ use: "kestrel-delivery-static", config: { prefix: "site/", media: { publicPath: "/media" } } }], triggers: [] });\n';
    const edit = replaceModuleConfigProperty("kestrel.config.ts", source, { use: "kestrel-delivery-static", fromKey: "media", toText: 'reservedPaths: ["/media"]' });
    expect(edit).toBeDefined();
    const { text } = applyEdits(source, [edit!]);
    expect(text).toContain('config: { prefix: "site/", reservedPaths: ["/media"] }');
  });

  it("replaces the only property without leaving a stray comma or brace", () => {
    const source = 'export default defineConfig({ modules: [{ use: "kestrel-delivery-static", config: { media: { publicPath: "/media" } } }], triggers: [] });\n';
    const edit = replaceModuleConfigProperty("kestrel.config.ts", source, { use: "kestrel-delivery-static", fromKey: "media", toText: 'reservedPaths: ["/media"]' });
    const { text } = applyEdits(source, [edit!]);
    expect(text).toContain('config: { reservedPaths: ["/media"] }');
  });

  it("returns undefined when the entry, its config, or the key cannot be found", () => {
    const source = 'export default defineConfig({ modules: [{ use: "kestrel-delivery-static", config: { prefix: "" } }], triggers: [] });\n';
    expect(replaceModuleConfigProperty("kestrel.config.ts", source, { use: "kestrel-delivery-static", fromKey: "media", toText: "x: 1" })).toBeUndefined();
    expect(replaceModuleConfigProperty("kestrel.config.ts", source, { use: "nope", fromKey: "media", toText: "x: 1" })).toBeUndefined();
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

  it("uses a plugin-supplied locateSteps for a layout the built-in search does not recognize", () => {
    const source = `defineFlow({ id: "custom", options: { steps: ["authn.requireUser", "revisions.reassignAuthor"] } });\n`;
    expect(insertPipelineStep("p.ts", source, { pipelineName: "custom", anchorStep: "revisions.reassignAuthor", position: "before", newStep: "authn.verifyUser:reassignTo" })).toBeUndefined();

    const locateSteps: StepListLocator = (root, pipelineName) => {
      const arrays: AstNode[] = [];
      for (const call of findCalls(root, "defineFlow")) {
        const arg = firstArgument(call);
        if (arg?.type !== "ObjectExpression" || objectProperty(arg, "id")?.value !== pipelineName) continue;
        const options = objectProperty(arg, "options");
        const steps = options?.type === "ObjectExpression" ? objectProperty(options, "steps") : undefined;
        if (isArrayExpression(steps)) arrays.push(steps);
      }
      return arrays;
    };
    const edit = insertPipelineStep("p.ts", source, { pipelineName: "custom", anchorStep: "revisions.reassignAuthor", position: "before", newStep: "authn.verifyUser:reassignTo", locateSteps });
    const { text } = applyEdits(source, [edit!]);
    expect(text).toContain('"authn.requireUser", "authn.verifyUser:reassignTo", "revisions.reassignAuthor"');
  });

  it("falls back to the built-in search when the locator finds nothing for this pipeline, instead of giving up", () => {
    const source = 'definePipeline({ name: "custom", steps: ["authn.requireUser", "revisions.reassignAuthor"] });\n';
    const locateSteps: StepListLocator = () => [];
    const edit = insertPipelineStep("p.ts", source, { pipelineName: "custom", anchorStep: "revisions.reassignAuthor", position: "before", newStep: "authn.verifyUser:reassignTo", locateSteps });
    expect(edit).toBeDefined();
    const { text } = applyEdits(source, [edit!]);
    expect(text).toContain('"authn.requireUser", "authn.verifyUser:reassignTo", "revisions.reassignAuthor"');
  });

  it("uses the locator's own result exclusively, even when the built-in search would also match the same pipeline name", () => {
    const source = `definePipeline({ name: "custom", steps: ["authn.requireUser", "revisions.reassignAuthor"] });\ndefineFlow({ id: "custom", options: { steps: ["authn.requireUser", "revisions.reassignAuthor"] } });\n`;
    const locateSteps: StepListLocator = (root, pipelineName) => {
      const arrays: AstNode[] = [];
      for (const call of findCalls(root, "defineFlow")) {
        const arg = firstArgument(call);
        if (arg?.type !== "ObjectExpression" || objectProperty(arg, "id")?.value !== pipelineName) continue;
        const options = objectProperty(arg, "options");
        const steps = options?.type === "ObjectExpression" ? objectProperty(options, "steps") : undefined;
        if (isArrayExpression(steps)) arrays.push(steps);
      }
      return arrays;
    };
    const edit = insertPipelineStep("p.ts", source, { pipelineName: "custom", anchorStep: "revisions.reassignAuthor", position: "before", newStep: "authn.verifyUser:reassignTo", locateSteps });
    const { text } = applyEdits(source, [edit!]);
    expect(text.indexOf("defineFlow")).toBeLessThan(text.indexOf("authn.verifyUser:reassignTo"));
  });
});

describe("swapPipelineSteps", () => {
  const PIPELINE = 'definePipeline({ name: "deleteMedia", steps: ["authn.requireUser", "images.remove", "media.remove", "events.emit:media.deleted"] });\n';

  it("swaps the two steps' text so earlier ends up before later", () => {
    const edits = swapPipelineSteps("p.ts", PIPELINE, { pipelineName: "deleteMedia", earlier: "media.remove", later: "images.remove" });
    expect(edits).toBeDefined();
    const { text } = applyEdits(PIPELINE, edits!);
    expect(text).toContain('"authn.requireUser", "media.remove", "images.remove", "events.emit:media.deleted"');
    expect(() => parseTs(text)).not.toThrow();
  });

  it("returns undefined when earlier is already before later", () => {
    const source = 'definePipeline({ name: "deleteMedia", steps: ["media.remove", "images.remove"] });\n';
    expect(swapPipelineSteps("p.ts", source, { pipelineName: "deleteMedia", earlier: "media.remove", later: "images.remove" })).toBeUndefined();
  });

  it("returns undefined for an unknown pipeline or step", () => {
    expect(swapPipelineSteps("p.ts", PIPELINE, { pipelineName: "nope", earlier: "media.remove", later: "images.remove" })).toBeUndefined();
    expect(swapPipelineSteps("p.ts", PIPELINE, { pipelineName: "deleteMedia", earlier: "media.remove", later: "nope.step" })).toBeUndefined();
  });

  it("swaps inside an atomic group", () => {
    const source = 'definePipeline({ name: "p", steps: [{ atomic: ["images.remove", "media.remove"] }] });\n';
    const edits = swapPipelineSteps("p.ts", source, { pipelineName: "p", earlier: "media.remove", later: "images.remove" });
    expect(edits).toBeDefined();
    const { text } = applyEdits(source, edits!);
    expect(text).toContain('{ atomic: ["media.remove", "images.remove"] }');
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

  it("uses a plugin-supplied locateModelFields for a layout the built-in search does not recognize", () => {
    const source = `defineContentModel({ name: "page", schema: { fields: { _hint: { type: "string" }, title: { type: "string" } } } });\n`;
    expect(renameContentField("model.ts", source, { use: "irrelevant", typeName: "page", from: "_hint", to: "hint" })).toBeUndefined();

    const locateModelFields: ModelFieldsLocator = (root, { typeName }) => {
      for (const call of findCalls(root, "defineContentModel")) {
        const arg = firstArgument(call);
        if (arg?.type !== "ObjectExpression" || objectProperty(arg, "name")?.value !== typeName) continue;
        const schema = objectProperty(arg, "schema");
        const fields = schema?.type === "ObjectExpression" ? objectProperty(schema, "fields") : undefined;
        if (fields?.type === "ObjectExpression") return fields;
      }
      return undefined;
    };
    const edit = renameContentField("model.ts", source, { use: "irrelevant", typeName: "page", from: "_hint", to: "hint", locateModelFields });
    const { text } = applyEdits(source, [edit!]);
    expect(text).toContain("fields: { hint: { type: \"string\" }, title:");
  });

  it("falls back to the built-in search when the locator returns undefined for this type, instead of giving up", () => {
    const locateModelFields: ModelFieldsLocator = () => undefined;
    const edit = renameContentField("kestrel.config.ts", CONFIG, { use: "@michaelthielemann/kestrel-content-default", typeName: "page", from: "_hint", to: "hint", locateModelFields });
    expect(edit).toBeDefined();
    const { text } = applyEdits(CONFIG, [edit!]);
    expect(text).toContain("fields: { hint: { type: \"string\" }, title:");
  });

  it("uses the locator's own result exclusively, even when the built-in search would also match the same type name", () => {
    const source = `export default defineConfig({ modules: [{ use: "content-default", config: { types: { page: { fields: { _hint: { type: "string" } } } } } }] });\ndefineContentModel({ name: "page", schema: { fields: { _hint: { type: "string" } } } });\n`;
    const locateModelFields: ModelFieldsLocator = (root, { typeName }) => {
      for (const call of findCalls(root, "defineContentModel")) {
        const arg = firstArgument(call);
        if (arg?.type !== "ObjectExpression" || objectProperty(arg, "name")?.value !== typeName) continue;
        const schema = objectProperty(arg, "schema");
        const fields = schema?.type === "ObjectExpression" ? objectProperty(schema, "fields") : undefined;
        if (fields?.type === "ObjectExpression") return fields;
      }
      return undefined;
    };
    const edit = renameContentField("model.ts", source, { use: "content-default", typeName: "page", from: "_hint", to: "hint", locateModelFields });
    expect(edit).toBeDefined();
    expect(edit!.start).toBeGreaterThan(source.indexOf("defineContentModel"));
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

  it("uses a plugin-supplied locateSteps for a layout the built-in search does not recognize", () => {
    const source = `defineFlow({ id: "createPage", options: { steps: ["content.create", "events.emit:page.created"] } });\n`;
    expect(insertStepAfterEmitOutsideGroup("p.ts", source, { pipelineName: "createPage", emitStep: "events.emit:page.created", newStep: "events.relay" })).toBeUndefined();

    const locateSteps: StepListLocator = (root, pipelineName) => {
      const arrays: AstNode[] = [];
      for (const call of findCalls(root, "defineFlow")) {
        const arg = firstArgument(call);
        if (arg?.type !== "ObjectExpression" || objectProperty(arg, "id")?.value !== pipelineName) continue;
        const options = objectProperty(arg, "options");
        const steps = options?.type === "ObjectExpression" ? objectProperty(options, "steps") : undefined;
        if (isArrayExpression(steps)) arrays.push(steps);
      }
      return arrays;
    };
    const edit = insertStepAfterEmitOutsideGroup("p.ts", source, { pipelineName: "createPage", emitStep: "events.emit:page.created", newStep: "events.relay", locateSteps });
    const { text } = applyEdits(source, [edit!]);
    expect(text).toContain('"content.create", "events.emit:page.created", "events.relay"');
  });

  it("falls back to the built-in search when the locator finds nothing for this pipeline, instead of giving up", () => {
    const source = 'definePipeline({ name: "createPage", steps: ["content.create", "events.emit:page.created"] });\n';
    const locateSteps: StepListLocator = () => [];
    const edit = insertStepAfterEmitOutsideGroup("p.ts", source, { pipelineName: "createPage", emitStep: "events.emit:page.created", newStep: "events.relay", locateSteps });
    expect(edit).toBeDefined();
    const { text } = applyEdits(source, [edit!]);
    expect(text).toContain('"content.create", "events.emit:page.created", "events.relay"');
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

describe("insertTrigger", () => {
  it("fills an empty triggers array", () => {
    const source = 'export default defineConfig({ modules: [], triggers: [] });\n';
    const edit = insertTrigger("kestrel.config.ts", source, { trigger: '{ http: "GET /media/:id/:name", pipeline: "serveMediaFile" }' });
    expect(edit).toBeDefined();
    const { text } = applyEdits(source, [edit!]);
    expect(text).toBe('export default defineConfig({ modules: [], triggers: [{ http: "GET /media/:id/:name", pipeline: "serveMediaFile" }] });\n');
    expect(() => parseTs(text)).not.toThrow();
  });

  it("appends after the last entry of a single-line, non-empty triggers array", () => {
    const source = 'export default defineConfig({ modules: [], triggers: [{ http: "GET /me", pipeline: "me" }] });\n';
    const edit = insertTrigger("kestrel.config.ts", source, { trigger: '{ cron: "*/5 * * * *", pipeline: "resumeImages" }' });
    expect(edit).toBeDefined();
    const { text } = applyEdits(source, [edit!]);
    expect(text).toBe('export default defineConfig({ modules: [], triggers: [{ http: "GET /me", pipeline: "me" }, { cron: "*/5 * * * *", pipeline: "resumeImages" }] });\n');
    expect(() => parseTs(text)).not.toThrow();
  });

  it("appends its own line after the last entry of a multiline triggers array", () => {
    const source = `export default defineConfig({
  modules: [],
  triggers: [
    { http: "GET /me", pipeline: "me" },
  ],
});
`;
    const edit = insertTrigger("kestrel.config.ts", source, { trigger: '{ cron: "*/5 * * * *", pipeline: "resumeImages" }' });
    expect(edit).toBeDefined();
    const { text } = applyEdits(source, [edit!]);
    expect(text).toContain('    { http: "GET /me", pipeline: "me" },\n    { cron: "*/5 * * * *", pipeline: "resumeImages" },\n');
    expect(() => parseTs(text)).not.toThrow();
  });

  it("returns undefined when there is no triggers array", () => {
    const source = "export default defineConfig({ modules: [] });\n";
    expect(insertTrigger("kestrel.config.ts", source, { trigger: '{ http: "GET /me", pipeline: "me" }' })).toBeUndefined();
  });
});

describe("insertTriggers", () => {
  it("appends several trigger literals in one edit, never colliding with a second call against the same source", () => {
    const source = `export default defineConfig({
  modules: [],
  triggers: [
    { http: "GET /me", pipeline: "me" },
  ],
});
`;
    const edit = insertTriggers("kestrel.config.ts", source, ['{ http: "GET /media/:id/:name", pipeline: "serveMediaFile" }', '{ http: "GET /media/:id/variants/:file", pipeline: "serveImageVariant" }']);
    expect(edit).toBeDefined();
    const { text } = applyEdits(source, [edit!]);
    expect(text).toContain(
      '    { http: "GET /me", pipeline: "me" },\n' +
        '    { http: "GET /media/:id/:name", pipeline: "serveMediaFile" },\n' +
        '    { http: "GET /media/:id/variants/:file", pipeline: "serveImageVariant" },\n',
    );
    expect(() => parseTs(text)).not.toThrow();
  });

  it("returns undefined for an empty trigger list", () => {
    const source = 'export default defineConfig({ modules: [], triggers: [] });\n';
    expect(insertTriggers("kestrel.config.ts", source, [])).toBeUndefined();
  });
});

describe("newPipelineFileContent / createPipelineFile", () => {
  it("renders a pipeline file importing definePipeline from the package directly", () => {
    const text = newPipelineFileContent({ name: "serveMediaFile", steps: ["authn.identifyUser", "authz.require:media.read", "media.serve"] });
    expect(text).toBe(
      'import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";\n\n' +
        "export default definePipeline({\n" +
        '  name: "serveMediaFile",\n' +
        '  steps: ["authn.identifyUser", "authz.require:media.read", "media.serve"],\n' +
        "});\n",
    );
    expect(() => parseTs(text)).not.toThrow();
  });

  it("builds a create edit at start 0/end 0", () => {
    const edit = createPipelineFile("pipelines/serveMediaFile.ts", { name: "serveMediaFile", steps: ["media.serve"] });
    expect(edit.file).toBe("pipelines/serveMediaFile.ts");
    expect(edit.start).toBe(0);
    expect(edit.end).toBe(0);
    expect(edit.create).toBe(true);
    expect(edit.text).toContain('name: "serveMediaFile"');
  });
});
