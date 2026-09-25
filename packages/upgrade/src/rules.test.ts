import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BootCheck } from "@michaelthielemann/kestrel";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { applyEdits } from "./apply.ts";
import type { LoadedProject, RuleContext } from "./plugin.ts";
import { eventBusRule, eventDeliveryRule, kestrelRangeRule, readFileOrUndefined, removedStepsRule } from "./rules.ts";

const EMPTY_CHECK: BootCheck = { errors: [], warnings: [], notChecked: [] };

function parsePkg(text: string): { dependencies: Record<string, string> } {
  return boundaryCast<{ dependencies: Record<string, string> }>(JSON.parse(text), "json");
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-rules-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function contextFor(project: LoadedProject, answers: ReadonlyMap<string, string> = new Map()): RuleContext {
  return { root: dir, scratch: dir, project, bootCheck: EMPTY_CHECK, readFile: readFileOrUndefined, answers };
}

async function projectWithModules(source: string, modules: Array<{ use: string; config?: Record<string, unknown> }>): Promise<LoadedProject> {
  const configFile = join(dir, "kestrel.config.ts");
  await writeFile(configFile, source);
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: Object.fromEntries(modules.map((m) => m.use).filter((u) => u.startsWith("@")).map((u) => [u, "^5.8.0"])) }, null, 2));
  return {
    input: { config: { modules, triggers: [] }, modules: [], pipelines: [] },
    kind: "backend",
    configFile,
    moduleFiles: new Map(),
    pipelineFiles: [],
  };
}

async function projectWithConfig(source: string, moduleUses: string[]): Promise<LoadedProject> {
  return projectWithModules(source, moduleUses.map((use) => ({ use, config: {} })));
}

describe("modules/event-delivery", () => {
  it("fires when events-inmemory has no delivery module and inserts events-direct after it", async () => {
    const source = 'export default defineConfig({ modules: [{ use: "@michaelthielemann/kestrel-events-inmemory" }], triggers: [] });\n';
    const project = await projectWithConfig(source, ["@michaelthielemann/kestrel-events-inmemory"]);
    const findings = await eventDeliveryRule.check(contextFor(project));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("auto");
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const configEdit = edits.find((e) => e.file === project.configFile)!;
    const { text } = applyEdits(source, [configEdit]);
    expect(text).toContain('kestrel-events-inmemory" }, { use: "@michaelthielemann/kestrel-events-direct", config: {} }');
  });

  it("does not fire once a delivery module is present", async () => {
    const source = 'export default defineConfig({ modules: [{ use: "@michaelthielemann/kestrel-events-inmemory" }, { use: "@michaelthielemann/kestrel-events-direct" }], triggers: [] });\n';
    const project = await projectWithConfig(source, ["@michaelthielemann/kestrel-events-inmemory", "@michaelthielemann/kestrel-events-direct"]);
    expect(await eventDeliveryRule.check(contextFor(project))).toEqual([]);
  });

  it("does not fire without the bus module at all", async () => {
    const source = "export default defineConfig({ modules: [], triggers: [] });\n";
    const project = await projectWithConfig(source, []);
    expect(await eventDeliveryRule.check(contextFor(project))).toEqual([]);
  });

  it("also adds the module to a sibling modules.ts, when one exists", async () => {
    const source = 'export default defineConfig({ modules: [{ use: "@michaelthielemann/kestrel-events-inmemory" }], triggers: [] });\n';
    const project = await projectWithConfig(source, ["@michaelthielemann/kestrel-events-inmemory"]);
    const modulesTsFile = join(dir, "modules.ts");
    const modulesTsSource = `import { pipelineDefiner, type StepCatalogue } from "@michaelthielemann/kestrel";
import eventsInmemory from "@michaelthielemann/kestrel-events-inmemory";

const modules = [eventsInmemory] as const;

export default modules;
export type KnownStep = StepCatalogue<typeof modules>;
export const definePipeline = pipelineDefiner<KnownStep>();
`;
    await writeFile(modulesTsFile, modulesTsSource);
    const findings = await eventDeliveryRule.check(contextFor(project));
    expect(findings).toHaveLength(1);
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const modulesTsEdits = edits.filter((e) => e.file === modulesTsFile);
    expect(modulesTsEdits.length).toBeGreaterThan(0);
    const { text } = applyEdits(modulesTsSource, modulesTsEdits);
    expect(text).toContain('import eventsDirect from "@michaelthielemann/kestrel-events-direct";');
    expect(text).toContain("const modules = [eventsInmemory, eventsDirect] as const;");
  });

  it("goes manual, naming the config file, when the anchor's use is a constant the source cannot match", async () => {
    const source = 'const BUS = "@michaelthielemann/kestrel-events-inmemory";\nexport default defineConfig({ modules: [{ use: BUS }], triggers: [] });\n';
    const project = await projectWithConfig(source, ["@michaelthielemann/kestrel-events-inmemory"]);
    const findings = await eventDeliveryRule.check(contextFor(project));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("manual");
    expect(findings[0]?.suggestion).toContain("kestrel.config.ts's modules list");
  });
});

describe("modules/event-bus", () => {
  it("fires when events-queue has no bus and inserts events-inmemory before it", async () => {
    const source = 'export default defineConfig({ modules: [{ use: "@michaelthielemann/kestrel-events-queue" }], triggers: [] });\n';
    const project = await projectWithConfig(source, ["@michaelthielemann/kestrel-events-queue"]);
    const findings = await eventBusRule.check(contextFor(project));
    expect(findings).toHaveLength(1);
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const configEdit = edits.find((e) => e.file === project.configFile)!;
    const { text } = applyEdits(source, [configEdit]);
    expect(text).toContain('modules: [{ use: "@michaelthielemann/kestrel-events-inmemory", config: {} }, { use: "@michaelthielemann/kestrel-events-queue"');
  });

  it("goes manual, naming the config file, when the anchor's use is a constant the source cannot match", async () => {
    const source = 'const QUEUE = "@michaelthielemann/kestrel-events-queue";\nexport default defineConfig({ modules: [{ use: QUEUE }], triggers: [] });\n';
    const project = await projectWithConfig(source, ["@michaelthielemann/kestrel-events-queue"]);
    const findings = await eventBusRule.check(contextFor(project));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("manual");
    expect(findings[0]?.suggestion).toContain("kestrel.config.ts's modules list");
  });
});

describe("steps/removed", () => {
  it("renames media.folderItems to media.listFolderItems in a pipeline file", async () => {
    const pipelineFile = join(dir, "deleteMediaFolder.ts");
    const source = 'export default definePipeline({ name: "deleteMediaFolder", steps: ["media.folderItems"] });\n';
    await writeFile(pipelineFile, source);
    const project: LoadedProject = { input: { config: { modules: [], triggers: [] }, modules: [], pipelines: [] }, kind: "backend", configFile: join(dir, "kestrel.config.ts"), moduleFiles: new Map(), pipelineFiles: [{ file: pipelineFile, pipelines: ["deleteMediaFolder"] }] };
    const findings = await removedStepsRule.check(contextFor(project));
    expect(findings).toHaveLength(1);
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const { text } = applyEdits(source, edits);
    expect(text).toContain('"media.listFolderItems"');
  });

  it("does not fire when no pipeline uses the removed step", async () => {
    const pipelineFile = join(dir, "p.ts");
    await writeFile(pipelineFile, 'export default definePipeline({ name: "p", steps: ["media.upload"] });\n');
    const project: LoadedProject = { input: { config: { modules: [], triggers: [] }, modules: [], pipelines: [] }, kind: "backend", configFile: join(dir, "kestrel.config.ts"), moduleFiles: new Map(), pipelineFiles: [{ file: pipelineFile, pipelines: ["p"] }] };
    expect(await removedStepsRule.check(contextFor(project))).toEqual([]);
  });

  it("reports the removed step once per file, even when several pipelines share it", async () => {
    const pipelineFile = join(dir, "combined.ts");
    const source = 'export const a = definePipeline({ name: "a", steps: ["media.folderItems"] });\nexport const b = definePipeline({ name: "b", steps: ["media.upload"] });\n';
    await writeFile(pipelineFile, source);
    const project: LoadedProject = { input: { config: { modules: [], triggers: [] }, modules: [], pipelines: [] }, kind: "backend", configFile: join(dir, "kestrel.config.ts"), moduleFiles: new Map(), pipelineFiles: [{ file: pipelineFile, pipelines: ["a", "b"] }] };
    const findings = await removedStepsRule.check(contextFor(project));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.where).toEqual({ file: pipelineFile });
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const { text } = applyEdits(source, edits);
    expect(text).toContain('"media.listFolderItems"');
  });
});

describe("deps/kestrel-range", () => {
  it("fires for a non-6.x kestrel dependency and sets it to ^6.0.0", async () => {
    const project = await projectWithConfig("export default defineConfig({ modules: [], triggers: [] });\n", ["@michaelthielemann/kestrel-events-inmemory"]);
    const findings = await kestrelRangeRule.check(contextFor(project));
    expect(findings).toHaveLength(1);
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const pkgSource = readFileOrUndefined(join(dir, "package.json"))!;
    const { text } = applyEdits(pkgSource, edits);
    expect(parsePkg(text).dependencies["@michaelthielemann/kestrel-events-inmemory"]).toBe("^6.0.0");
  });

  it("does not fire once the range is already 6.x", async () => {
    const project = await projectWithConfig("export default defineConfig({ modules: [], triggers: [] });\n", []);
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { "@michaelthielemann/kestrel-events-inmemory": "^6.0.0" } }));
    expect(await kestrelRangeRule.check(contextFor(project))).toEqual([]);
  });
});
