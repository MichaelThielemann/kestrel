import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { runCli } from "./cli-run.ts";
import type { UpgradePlugin } from "./plugin.ts";
import { loadBackendProject } from "./project.ts";
import type { UpgradeReport } from "./report.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = resolve(HERE, "..", "..");

async function linkPackage(nodeModulesDir: string, name: string, packageDirName: string): Promise<void> {
  const scope = join(nodeModulesDir, "@michaelthielemann");
  await mkdir(scope, { recursive: true });
  await symlink(resolve(PACKAGES_DIR, packageDirName), join(scope, name), "dir");
}

const NOTES_MODULE = `import { z } from "zod";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { ok } from "@michaelthielemann/kestrel/result";

export default defineModule({
  name: "notes/local",
  provides: [],
  requires: [],
  configSchema: z.object({}).strict(),
  async setup() {
    return {};
  },
  steps: () => ({
    create: async (ctx) => ok({ ...ctx, result: { id: "n1" } }),
    onCreated: async (ctx) => ok(ctx),
  }),
  describe: () => ({
    create: { summary: "create a note", reads: [], writes: ["result"], output: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    onCreated: { summary: "react to note.created", reads: [], writes: [] },
  }),
});
`;

const CREATE_NOTE_PIPELINE = `import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";

export default definePipeline({
  name: "createNote",
  steps: ["notes.create", "events.emit:note.created"],
});
`;

const ON_NOTE_CREATED_PIPELINE = `import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";

export default definePipeline({
  name: "onNoteCreated",
  steps: ["notes.onCreated"],
});
`;

type ModuleListStyle = "literal" | "backtick" | "helper" | "helper-with-comment";

function configSource(style: ModuleListStyle): string {
  if (style === "helper" || style === "helper-with-comment") {
    const comment = style === "helper-with-comment" ? `// uses "@michaelthielemann/kestrel-events-direct" under the hood\n` : "";
    return `import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";
import { baseModules } from "./modulesHelper.ts";
${comment}export default defineConfig({
  modules: baseModules(),
  triggers: [
    { http: "POST /notes", pipeline: "createNote" },
    { event: "note.created", pipeline: "onNoteCreated" },
  ],
  pipelinesDir: "./pipelines",
});
`;
  }
  const quote = style === "backtick" ? "`" : '"';
  return `import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";

export default defineConfig({
  modules: [
    { use: ${quote}@michaelthielemann/kestrel-events-inmemory${quote}, config: {} },
    { use: ${quote}@michaelthielemann/kestrel-events-direct${quote}, config: {} },
    { use: ${quote}@michaelthielemann/kestrel-persistence-sqlite${quote}, config: { file: "./data/kestrel.db" } },
    { use: "./notes.ts", config: {} },
  ],
  triggers: [
    { http: "POST /notes", pipeline: "createNote" },
    { event: "note.created", pipeline: "onNoteCreated" },
  ],
  pipelinesDir: "./pipelines",
});
`;
}

const MODULES_HELPER = `export function baseModules() {
  return [
    { use: "@michaelthielemann/kestrel-events-inmemory", config: {} },
    { use: "@michaelthielemann/kestrel-events-direct", config: {} },
    { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: "./data/kestrel.db" } },
    { use: "./notes.ts", config: {} },
  ];
}
`;

async function buildProject(dir: string, style: ModuleListStyle): Promise<void> {
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "app",
        type: "module",
        dependencies: {
          "@michaelthielemann/kestrel": "^6.0.0",
          "@michaelthielemann/kestrel-events-inmemory": "^6.0.0",
          "@michaelthielemann/kestrel-events-direct": "^6.0.0",
          "@michaelthielemann/kestrel-events-queue": "^6.0.0",
          "@michaelthielemann/kestrel-persistence-sqlite": "^6.0.0",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(join(dir, "kestrel.config.ts"), configSource(style));
  if (style === "helper" || style === "helper-with-comment") await writeFile(join(dir, "modulesHelper.ts"), MODULES_HELPER);
  await writeFile(join(dir, "notes.ts"), NOTES_MODULE);
  await mkdir(join(dir, "pipelines"), { recursive: true });
  await writeFile(join(dir, "pipelines", "createNote.ts"), CREATE_NOTE_PIPELINE);
  await writeFile(join(dir, "pipelines", "onNoteCreated.ts"), ON_NOTE_CREATED_PIPELINE);

  const nodeModules = join(dir, "node_modules");
  await linkPackage(nodeModules, "kestrel", "core");
  await linkPackage(nodeModules, "kestrel-contracts", "contracts");
  await linkPackage(nodeModules, "kestrel-events-inmemory", "events-inmemory");
  await linkPackage(nodeModules, "kestrel-events-direct", "events-direct");
  await linkPackage(nodeModules, "kestrel-events-queue", "events-queue");
  await linkPackage(nodeModules, "kestrel-persistence-sqlite", "persistence-sqlite");
  await symlink(resolve(HERE, "..", "..", "..", "node_modules", "zod"), join(nodeModules, "zod"), "dir");
}

async function runJson(dir: string, plugins: readonly UpgradePlugin[] = []): Promise<UpgradeReport> {
  const lines: string[] = [];
  await runCli(["check", "--root", dir, "--json"], { stdout: (l) => lines.push(l), stderr: () => undefined, forceInstalledMajor: 6, plugins });
  return boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json");
}

const cleanupDirs: string[] = [];
afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("offer/event-queue: the preview boot is the authority, with or without a plugin", () => {
  it("blocks a plugin-less project whose module list comes from a helper, instead of reporting clean", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-preview-authority-helper-"));
    cleanupDirs.push(dir);
    await buildProject(dir, "helper");
    const report = await runJson(dir);
    const offer = report.findings.find((f) => f.rule === "offer/event-queue");
    expect(offer?.fix.kind).not.toBe("ask");
    expect(offer?.message).toContain("events-direct is still in the booted module list");
  });

  it("blocks, naming the plugin, when a plugin's switchEdits run but leave events-direct booted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-preview-authority-plugin-"));
    cleanupDirs.push(dir);
    await buildProject(dir, "literal");
    const otherFile = join(dir, "shared-marker.ts");
    await writeFile(otherFile, "export const marker = 1;\n");
    const plugin: UpgradePlugin = {
      kind: "test-layer",
      detect: (root) => root === dir,
      load: (_root, scratchDir) => loadBackendProject(scratchDir),
      switchEdits: async (ctx) => {
        const markerFile = join(dirname(ctx.project.configFile), "shared-marker.ts");
        return { parts: { "an edit that never touches the config": [{ file: markerFile, start: 0, end: 0, text: "// switched\n" }] }, blockers: [] };
      },
    };
    const report = await runJson(dir, [plugin]);
    const offer = report.findings.find((f) => f.rule === "offer/event-queue");
    expect(offer?.fix.kind).not.toBe("ask");
    expect(offer?.message).toContain("events-direct is still in the booted module list");
    expect(offer?.message).toContain("still named at kestrel.config.ts");
    expect(offer?.message).toContain('"test-layer" plugin');
  });

  it("still offers the switch when a plugin's switchEdits genuinely remove events-direct from a preset config, even with a misleading comment naming the package", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-preview-authority-comment-"));
    cleanupDirs.push(dir);
    await buildProject(dir, "helper-with-comment");
    const plugin: UpgradePlugin = {
      kind: "test-layer",
      detect: (root) => root === dir,
      load: (_root, scratchDir) => loadBackendProject(scratchDir),
      switchEdits: async (ctx) => {
        const helperFile = join(dirname(ctx.project.configFile), "modulesHelper.ts");
        const source = ctx.readFile(helperFile);
        const literal = '"@michaelthielemann/kestrel-events-direct"';
        const index = source?.indexOf(literal) ?? -1;
        if (index === -1) return { parts: { "helper module swap": undefined }, blockers: [] };
        const edit = { file: helperFile, start: index, end: index + literal.length, text: '"@michaelthielemann/kestrel-events-queue"' };
        return { parts: { "helper module swap": [edit] }, blockers: [] };
      },
    };
    const report = await runJson(dir, [plugin]);
    const offer = report.findings.find((f) => f.rule === "offer/event-queue");
    expect(offer?.fix.kind).toBe("ask");
  });

  it("names the backtick-quoted site the built-in rewrite cannot locate, once the boot preview shows events-direct still active", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-preview-authority-backtick-"));
    cleanupDirs.push(dir);
    await buildProject(dir, "backtick");
    const report = await runJson(dir);
    const offer = report.findings.find((f) => f.rule === "offer/event-queue");
    expect(offer?.fix.kind).not.toBe("ask");
    expect(offer?.message).toContain("events-direct is still in the booted module list");
    expect(offer?.message).toContain("still named at kestrel.config.ts");
  });

  it("reports a blocker instead of crashing when a plugin's switchEdits proposes a create edit into a directory that does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-preview-authority-throwing-"));
    cleanupDirs.push(dir);
    await buildProject(dir, "literal");
    const plugin: UpgradePlugin = {
      kind: "test-layer",
      detect: (root) => root === dir,
      load: (_root, scratchDir) => loadBackendProject(scratchDir),
      switchEdits: async (ctx) => {
        const target = join(dirname(ctx.project.configFile), "does-not-exist", "new-file.ts");
        return { parts: { "a create edit into a missing directory": [{ file: target, start: 0, end: 0, text: "export {};\n", create: true }] }, blockers: [] };
      },
    };
    const lines: string[] = [];
    const errLines: string[] = [];
    const exitCode = await runCli(["check", "--root", dir, "--json"], { stdout: (l) => lines.push(l), stderr: (l) => errLines.push(l), forceInstalledMajor: 6, plugins: [plugin] });
    expect(exitCode).not.toBe(2);
    const report = boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json");
    const offer = report.findings.find((f) => f.rule === "offer/event-queue");
    expect(offer?.fix.kind).not.toBe("ask");
    expect(offer?.message).toContain("could not be verified");
    expect(offer?.message).toContain("ENOENT");
  });

  it("blocks the offer when modules.ts still imports events-direct and a plugin's switchEdits do not cover that import, instead of reporting the switch as clean", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-preview-authority-modules-ts-"));
    cleanupDirs.push(dir);
    await buildProject(dir, "literal");
    const modulesTsFile = join(dir, "modules.ts");
    await writeFile(modulesTsFile, 'import * as eventsDirect from "@michaelthielemann/kestrel-events-direct";\n\nexport default eventsDirect;\n');
    const plugin: UpgradePlugin = {
      kind: "test-layer",
      detect: (root) => root === dir,
      load: (_root, scratchDir) => loadBackendProject(scratchDir),
      switchEdits: async (ctx) => {
        const source = ctx.readFile(ctx.project.configFile) ?? "";
        const literal = '"@michaelthielemann/kestrel-events-direct"';
        const index = source.indexOf(literal);
        const edit = { file: ctx.project.configFile, start: index, end: index + literal.length, text: '"@michaelthielemann/kestrel-events-queue"' };
        return { parts: { "config module swap": [edit] }, blockers: [] };
      },
    };
    const report = await runJson(dir, [plugin]);
    const offer = report.findings.find((f) => f.rule === "offer/event-queue");
    expect(offer?.fix.kind).not.toBe("ask");
    expect(offer?.fix.kind).not.toBe("auto");
    expect(offer?.message).toContain("events-direct is imported where the switch cannot rewrite it");
    expect(offer?.message).toContain("modules.ts");
  });

  it("memoizes the boot preview of the same edit set within one check, instead of reloading it once per call site", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-preview-authority-memo-"));
    cleanupDirs.push(dir);
    await buildProject(dir, "literal");
    let loadCount = 0;
    const plugin: UpgradePlugin = {
      kind: "test-layer",
      detect: (root) => root === dir,
      load: async (_root, scratchDir) => {
        loadCount++;
        return loadBackendProject(scratchDir);
      },
    };
    await runJson(dir, [plugin]);
    expect(loadCount).toBeLessThanOrEqual(2);
  });
});
