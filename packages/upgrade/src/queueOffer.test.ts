import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { BootCheck, BootProblem, ModuleDefinition, PipelineDefinition } from "@michaelthielemann/kestrel";
import { defineContract } from "@michaelthielemann/kestrel/defineContract";
import { applyEdits } from "./apply.ts";
import type { InternalRuleContext } from "./cli-run.ts";
import type { LoadedProject, LoadIssue, RuleContext } from "./plugin.ts";
import type { Edit } from "./report.ts";
import { readFileOrUndefined } from "./rules.ts";
import { queueOfferRule } from "./ruleQueueOffer.ts";

const PERSISTENCE = defineContract<{ x(): void }>()("persistence@1", ["x"]);

function persistenceModule(): ModuleDefinition {
  return { name: "persistence/sqlite", provides: [PERSISTENCE], requires: [], configSchema: z.object({}), async setup() { return {}; } };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-queue-offer-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const cleanPreviewBoot = async (): Promise<BootCheck> => ({ errors: [], warnings: [], notChecked: [] });

function contextFor(
  project: LoadedProject,
  answers: ReadonlyMap<string, string> = new Map(),
  previewBoot: (edits: readonly Edit[]) => Promise<BootCheck | undefined> = cleanPreviewBoot,
): RuleContext {
  const check: BootCheck = { errors: [], warnings: [], notChecked: [] };
  return { root: dir, scratch: dir, project, bootCheck: check, readFile: readFileOrUndefined, answers, previewBoot };
}

async function directProject(options: { sqliteFile?: string; publishPipeline?: boolean; groupedEmit?: boolean } = {}): Promise<LoadedProject> {
  const configFile = join(dir, "kestrel.config.ts");
  const configSource = 'export default defineConfig({ modules: [{ use: "@michaelthielemann/kestrel-events-inmemory" }, { use: "@michaelthielemann/kestrel-events-direct" }, { use: "@michaelthielemann/kestrel-persistence-sqlite" }], triggers: [] });\n';
  await writeFile(configFile, configSource);
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { "@michaelthielemann/kestrel-events-direct": "^6.0.0" } }, null, 2));

  const createPageFile = join(dir, "createPage.ts");
  const createPageSteps = options.publishPipeline ? ["content.create", "events.emit:page.created"] : ["content.create"];
  const createPageSource = options.groupedEmit
    ? `definePipeline({ name: "createPage", steps: [{ atomic: [${createPageSteps.map((s) => `"${s}"`).join(", ")}] }] });\n`
    : `definePipeline({ name: "createPage", steps: [${createPageSteps.map((s) => `"${s}"`).join(", ")}] });\n`;
  await writeFile(createPageFile, createPageSource);
  const publishPageFile = join(dir, "publishPage.ts");
  await writeFile(publishPageFile, 'definePipeline({ name: "publishPage", steps: ["delivery.publish:pages"] });\n');

  const pipelines: PipelineDefinition[] = [
    { name: "createPage", steps: createPageSteps },
    { name: "publishPage", steps: ["delivery.publish:pages"] },
  ];

  return {
    input: {
      config: {
        modules: [
          { use: "@michaelthielemann/kestrel-events-inmemory", config: {} },
          { use: "@michaelthielemann/kestrel-events-direct", config: {} },
          { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: options.sqliteFile ?? "./data/kestrel.db" } },
        ],
        triggers: [
          { http: "POST /pages", pipeline: "createPage" },
          { event: "page.created", pipeline: "publishPage" },
        ],
      },
      modules: [persistenceModule()],
      pipelines,
    },
    kind: "backend",
    configFile,
    moduleFiles: new Map(),
    pipelineFiles: [
      { file: createPageFile, pipelines: ["createPage"] },
      { file: publishPageFile, pipelines: ["publishPage"] },
    ],
  };
}

describe("offer/event-queue", () => {
  it("does not fire once the project is already on the queue", async () => {
    const p = await directProject();
    p.input.config.modules = p.input.config.modules.filter((m) => !m.use.includes("events-direct"));
    expect(await queueOfferRule.check(contextFor(p))).toEqual([]);
  });

  it("reports the unmet conditions when storage is not durable", async () => {
    const p = await directProject({ sqliteFile: ":memory:" });
    const findings = await queueOfferRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(":memory:");
  });

  it("reports the unmet conditions when nothing emits an event", async () => {
    const p = await directProject();
    p.input.config.triggers = p.input.config.triggers.filter((t) => !("event" in t));
    const findings = await queueOfferRule.check(contextFor(p));
    expect(findings[0]?.message).toContain("no event trigger");
  });

  it("offers the switch, with default no, when every condition is met", async () => {
    const p = await directProject();
    const findings = await queueOfferRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("ask");
    expect(findings[0]?.fix.kind === "ask" ? findings[0].fix.defaultValue : undefined).toBe("no");
  });

  it("asks idempotent per consumer event pipeline once switch-to-queue is yes", async () => {
    const p = await directProject();
    const findings = await queueOfferRule.check(contextFor(p, new Map([["switch-to-queue", "yes"]])));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind === "ask" ? findings[0].fix.question : undefined).toBe("idempotent:publishPage");
  });

  it("withdraws the switch once an idempotent answer is no", async () => {
    const p = await directProject();
    const answers = new Map([["switch-to-queue", "yes"], ["idempotent:publishPage", "no"]]);
    expect(await queueOfferRule.check(contextFor(p, answers))).toEqual([]);
  });

  it("asks relay-pipelines, defaulting to pipelines that publish or unpublish", async () => {
    const p = await directProject();
    const answers = new Map([["switch-to-queue", "yes"], ["idempotent:publishPage", "yes"]]);
    const findings = await queueOfferRule.check(contextFor(p, answers));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind === "ask" ? findings[0].fix.defaultValue : undefined).toBe("publishPage");
  });

  it("does not default to a publishing pipeline the event does not trigger, only to event-triggered subscribers", async () => {
    const p = await directProject();
    p.input.pipelines = [...p.input.pipelines, { name: "adminRepublish", steps: ["delivery.publish:pages"] }];
    p.input.config.triggers = [...p.input.config.triggers, { http: "POST /admin/republish", pipeline: "adminRepublish" }];
    const answers = new Map([["switch-to-queue", "yes"], ["idempotent:publishPage", "yes"]]);
    const findings = await queueOfferRule.check(contextFor(p, answers));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind === "ask" ? findings[0].fix.defaultValue : undefined).toBe("publishPage");
  });

  it("applies the codemod once relay-pipelines is answered: module swap, relayPipelines, events.relay after the emit", async () => {
    const p = await directProject({ publishPipeline: true });
    const answers = new Map([["switch-to-queue", "yes"], ["idempotent:publishPage", "yes"], ["relay-pipelines", "publishPage"]]);
    const findings = await queueOfferRule.check(contextFor(p, answers));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("auto");
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];

    const configSource = readFileOrUndefined(p.configFile)!;
    const configEdits = edits.filter((e) => e.file === p.configFile);
    const { text: configText } = applyEdits(configSource, configEdits);
    expect(configText).toContain('@michaelthielemann/kestrel-events-queue", config: { relayPipelines: ["publishPage"] }');
    expect(configText).not.toContain("events-direct");

    const pkgFile = join(dir, "package.json");
    const pkgSource = readFileOrUndefined(pkgFile)!;
    const pkgEdits = edits.filter((e) => e.file === pkgFile);
    const { text: pkgText } = applyEdits(pkgSource, pkgEdits);
    expect(pkgText).toContain("@michaelthielemann/kestrel-events-queue");
    expect(pkgText).not.toContain("events-direct");

    const createPageFile = join(dir, "createPage.ts");
    const createPageSource = readFileOrUndefined(createPageFile)!;
    const createPageEdits = edits.filter((e) => e.file === createPageFile);
    const { text: createPageText } = applyEdits(createPageSource, createPageEdits);
    expect(createPageText).toContain('"events.emit:page.created", "events.relay"');
  });

  it("blocks the write, never a partial one, when a relay pipeline's emit step cannot be located", async () => {
    const p = await directProject({ publishPipeline: true });
    const createPageFile = join(dir, "createPage.ts");
    await writeFile(createPageFile, 'const STEPS = ["content.create", "events.emit:page.created"];\ndefinePipeline({ name: "createPage", steps: STEPS });\n');
    const answers = new Map([["switch-to-queue", "yes"], ["idempotent:publishPage", "yes"], ["relay-pipelines", "publishPage"]]);
    const findings = await queueOfferRule.check(contextFor(p, answers));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).not.toBe("auto");
    expect(findings[0]?.suggestion).toContain("createPage");
  });

  it("also swaps events-direct for events-queue in a sibling modules.ts", async () => {
    const p = await directProject({ publishPipeline: true });
    const modulesTsFile = join(dir, "modules.ts");
    const modulesTsSource = `import { pipelineDefiner, type StepCatalogue } from "@michaelthielemann/kestrel";
import eventsInmemory from "@michaelthielemann/kestrel-events-inmemory";
import eventsDirect from "@michaelthielemann/kestrel-events-direct";
import persistenceSqlite from "@michaelthielemann/kestrel-persistence-sqlite";

const modules = [eventsInmemory, eventsDirect, persistenceSqlite] as const;

export default modules;
export type KnownStep = StepCatalogue<typeof modules>;
export const definePipeline = pipelineDefiner<KnownStep>();
`;
    await writeFile(modulesTsFile, modulesTsSource);
    const answers = new Map([["switch-to-queue", "yes"], ["idempotent:publishPage", "yes"], ["relay-pipelines", "publishPage"]]);
    const findings = await queueOfferRule.check(contextFor(p, answers));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("auto");
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const modulesTsEdits = edits.filter((e) => e.file === modulesTsFile);
    expect(modulesTsEdits.length).toBeGreaterThan(0);
    const { text } = applyEdits(modulesTsSource, modulesTsEdits);
    expect(text).toContain('import eventsQueue from "@michaelthielemann/kestrel-events-queue";');
    expect(text).not.toContain("events-direct");
    expect(text).not.toContain("eventsDirect");
    expect(text).toContain("const modules = [eventsInmemory, eventsQueue, persistenceSqlite] as const;");
  });

  it("blocks the offer when a file other than kestrel.config.ts or modules.ts imports events-direct directly", async () => {
    const p = await directProject({ publishPipeline: true });
    const createPageFile = join(dir, "createPage.ts");
    const createPageSource = readFileOrUndefined(createPageFile)!;
    await writeFile(createPageFile, `import eventsDirect from "@michaelthielemann/kestrel-events-direct";\n${createPageSource}`);
    const findings = await queueOfferRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).not.toBe("ask");
    expect(findings[0]?.message).toContain("createPage.ts");
  });

  it("blocks the offer, never a partial write, when the config's use is a constant the switch cannot rewrite", async () => {
    const p = await directProject();
    await writeFile(
      p.configFile,
      'const DELIVERY = "@michaelthielemann/kestrel-events-direct";\nexport default defineConfig({ modules: [{ use: "@michaelthielemann/kestrel-events-inmemory" }, { use: DELIVERY }, { use: "@michaelthielemann/kestrel-persistence-sqlite" }], triggers: [] });\n',
    );
    const previewDetails = async (): Promise<{ moduleUses?: readonly string[]; issues: readonly LoadIssue[] }> => ({
      moduleUses: ["@michaelthielemann/kestrel-events-inmemory", "@michaelthielemann/kestrel-events-direct", "@michaelthielemann/kestrel-persistence-sqlite"],
      issues: [],
    });
    const ctx: InternalRuleContext = { root: dir, scratch: dir, project: p, bootCheck: { errors: [], warnings: [], notChecked: [] }, readFile: readFileOrUndefined, answers: new Map(), previewBoot: cleanPreviewBoot, previewDetails };
    const findings = await queueOfferRule.check(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).not.toBe("ask");
    expect(findings[0]?.fix.kind).not.toBe("auto");
    expect(findings[0]?.message).toContain("events-direct is still in the booted module list");
  });

  it("produces valid, parseable JSON when events-direct was appended last in an unsorted package.json", async () => {
    const p = await directProject({ publishPipeline: true });
    const pkgFile = join(dir, "package.json");
    await writeFile(pkgFile, '{\n  "name": "app",\n  "dependencies": {\n    "@michaelthielemann/kestrel": "^6.0.0",\n    "@michaelthielemann/kestrel-persistence-sqlite": "^6.0.0",\n    "@michaelthielemann/kestrel-insights": "^6.0.0",\n    "@michaelthielemann/kestrel-events-direct": "^6.0.0"\n  }\n}\n');
    const answers = new Map([["switch-to-queue", "yes"], ["idempotent:publishPage", "yes"], ["relay-pipelines", "publishPage"]]);
    const findings = await queueOfferRule.check(contextFor(p, answers));
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const pkgSource = readFileOrUndefined(pkgFile)!;
    const pkgEdits = edits.filter((e) => e.file === pkgFile);
    const { text } = applyEdits(pkgSource, pkgEdits);
    expect(text).not.toContain(",,");
    const parsed = boundaryCast<{ dependencies: Record<string, string> }>(JSON.parse(text), "json");
    expect(parsed.dependencies["@michaelthielemann/kestrel-events-direct"]).toBeUndefined();
    expect(parsed.dependencies["@michaelthielemann/kestrel-events-queue"]).toBe("^6.0.0");
    expect(parsed.dependencies["@michaelthielemann/kestrel-insights"]).toBe("^6.0.0");
  });

  it("places events.relay after the whole atomic group when the emit is grouped, never inside it", async () => {
    const p = await directProject({ publishPipeline: true, groupedEmit: true });
    const answers = new Map([["switch-to-queue", "yes"], ["idempotent:publishPage", "yes"], ["relay-pipelines", "publishPage"]]);
    const findings = await queueOfferRule.check(contextFor(p, answers));
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const createPageFile = join(dir, "createPage.ts");
    const createPageSource = readFileOrUndefined(createPageFile)!;
    const createPageEdits = edits.filter((e) => e.file === createPageFile);
    const { text } = applyEdits(createPageSource, createPageEdits);
    expect(text).toContain('steps: [{ atomic: ["content.create", "events.emit:page.created"] }, "events.relay"]');
  });

  it("blocks the offer and reports the errors when the switch's own boot preview finds new ones", async () => {
    const p = await directProject();
    const newError: BootProblem = { code: "setup-failed", owner: "events-queue", reason: "queue setup boom" };
    const previewBoot = async (): Promise<BootCheck> => ({ errors: [newError], warnings: [], notChecked: [] });
    const findings = await queueOfferRule.check(contextFor(p, new Map(), previewBoot));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("none");
    expect(findings[0]?.message).toContain("fails to boot");
    expect(findings[0]?.message).toContain("queue setup boom");
  });

  it("treats no boot tier at all (kestrel not yet on 6) as unverified, not clean", async () => {
    const p = await directProject();
    const check: BootCheck = { errors: [], warnings: [], notChecked: [] };
    const ctx: RuleContext = { root: dir, scratch: dir, project: p, bootCheck: check, readFile: readFileOrUndefined, answers: new Map() };
    const findings = await queueOfferRule.check(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("ask");
    expect(findings[0]?.fix.kind === "ask" ? findings[0].fix.defaultValue : "n/a").toBeUndefined();
    expect(findings[0]?.fix.kind === "ask" ? findings[0].fix.prompt : "").toContain("upgrade @michaelthielemann/kestrel to 6");
  });

  it("still offers the switch when the boot preview finds no new errors", async () => {
    const p = await directProject();
    const previewBoot = async (): Promise<BootCheck> => ({ errors: [], warnings: [], notChecked: [] });
    const findings = await queueOfferRule.check(contextFor(p, new Map(), previewBoot));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("ask");
  });

  it("does not count a boot error already present before the switch as new", async () => {
    const p = await directProject();
    const existing: BootProblem = { code: "setup-failed", owner: "events-direct", reason: "already broken" };
    const check: BootCheck = { errors: [existing], warnings: [], notChecked: [] };
    const previewBoot = async (): Promise<BootCheck> => ({ errors: [existing], warnings: [], notChecked: [] });
    const ctx: RuleContext = { root: dir, scratch: dir, project: p, bootCheck: check, readFile: readFileOrUndefined, answers: new Map(), previewBoot };
    const findings = await queueOfferRule.check(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("ask");
  });

  it("re-checks the boot preview using the answered relay pipelines before writing, not the default", async () => {
    const p = await directProject({ publishPipeline: true });
    const answers = new Map([["switch-to-queue", "yes"], ["idempotent:publishPage", "yes"], ["relay-pipelines", ""]]);
    const newError: BootProblem = { code: "setup-failed", owner: "events-queue", reason: "boom without any relay" };
    const previewBoot = async (edits: readonly Edit[]): Promise<BootCheck> => {
      const relaysPublishPage = edits.some((e) => e.text.includes("publishPage"));
      return relaysPublishPage ? { errors: [], warnings: [], notChecked: [] } : { errors: [newError], warnings: [], notChecked: [] };
    };
    const findings = await queueOfferRule.check(contextFor(p, answers, previewBoot));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).not.toBe("auto");
    expect(findings[0]?.message).toContain("boom without any relay");
  });

  it("names the unchecked relay pipeline and its own reason in the final could-not-verify message, not events-queue may not be installed", async () => {
    const p = await directProject({ publishPipeline: true });
    const answers = new Map([["switch-to-queue", "yes"], ["idempotent:publishPage", "yes"], ["relay-pipelines", "publishPage"]]);
    const previewBoot = async (): Promise<BootCheck> => ({ errors: [], warnings: [], notChecked: [{ kind: "pipeline", name: "publishPage", because: "config.modules does not pair reliably with the loaded modules" }] });
    const findings = await queueOfferRule.check(contextFor(p, answers, previewBoot));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).not.toBe("auto");
    expect(findings[0]?.message).toContain("publishPage");
    expect(findings[0]?.message).toContain("config.modules does not pair reliably with the loaded modules");
    expect(findings[0]?.message).not.toContain("may not be installed");
  });

  it("rejects a relay-pipelines answer naming a pipeline the project does not have", async () => {
    const p = await directProject({ publishPipeline: true });
    const answers = new Map([["switch-to-queue", "yes"], ["idempotent:publishPage", "yes"], ["relay-pipelines", "publishPaeg"]]);
    const findings = await queueOfferRule.check(contextFor(p, answers));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).not.toBe("auto");
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.message).toContain("publishPaeg");
  });
});

describe("offer/event-queue: UpgradePlugin.switchEdits", () => {
  it("uses the plugin's own edits for the switch, keeping every built-in gate", async () => {
    const p = await directProject({ publishPipeline: true });
    await writeFile(p.configFile, 'export default defineConfig(presetModuleConfig({ persistenceFile: "./data/kestrel.db" }));\n');
    const markerFile = join(dir, "marker.ts");
    const pluginSwitchEdits = async (): Promise<{ parts: Record<string, Edit[] | undefined>; blockers: readonly string[] }> => ({
      parts: { "plugin's own module swap": [{ file: markerFile, start: 0, end: 0, text: "// switched\n" }] },
      blockers: [],
    });
    const previewDetails = async (): Promise<{ moduleUses?: readonly string[]; issues: readonly LoadIssue[] }> => ({
      moduleUses: ["@michaelthielemann/kestrel-events-inmemory", "@michaelthielemann/kestrel-events-queue", "@michaelthielemann/kestrel-persistence-sqlite"],
      issues: [],
    });
    const answers = new Map([["switch-to-queue", "yes"], ["idempotent:publishPage", "yes"], ["relay-pipelines", "publishPage"]]);
    const ctx: InternalRuleContext = { root: dir, scratch: dir, project: p, bootCheck: { errors: [], warnings: [], notChecked: [] }, readFile: readFileOrUndefined, answers, previewBoot: cleanPreviewBoot, switchEdits: pluginSwitchEdits, previewDetails };
    const findings = await queueOfferRule.check(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("auto");
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    expect(edits).toEqual([{ file: markerFile, start: 0, end: 0, text: "// switched\n" }]);
  });

  it("blocks the offer using the plugin's own deployment markers", async () => {
    const p = await directProject();
    const pluginSwitchEdits = async (): Promise<{ parts: Record<string, Edit[] | undefined>; blockers: readonly string[] }> => ({ parts: {}, blockers: ['nitro.preset is "vercel" with no long-running worker'] });
    const ctx: RuleContext = { root: dir, scratch: dir, project: p, bootCheck: { errors: [], warnings: [], notChecked: [] }, readFile: readFileOrUndefined, answers: new Map(), previewBoot: cleanPreviewBoot, switchEdits: pluginSwitchEdits };
    const findings = await queueOfferRule.check(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("none");
    expect(findings[0]?.message).toContain("nitro.preset");
  });

  it("still runs the built-in SERVERLESS_MARKERS check alongside the plugin's own blockers, instead of replacing it", async () => {
    const p = await directProject();
    await writeFile(join(dir, "vercel.json"), "{}");
    const pluginSwitchEdits = async (): Promise<{ parts: Record<string, Edit[] | undefined>; blockers: readonly string[] }> => ({ parts: {}, blockers: ["the plugin's own marker"] });
    const ctx: RuleContext = { root: dir, scratch: dir, project: p, bootCheck: { errors: [], warnings: [], notChecked: [] }, readFile: readFileOrUndefined, answers: new Map(), previewBoot: cleanPreviewBoot, switchEdits: pluginSwitchEdits };
    const findings = await queueOfferRule.check(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("vercel.json");
    expect(findings[0]?.message).toContain("the plugin's own marker");
  });

  it("goes manual, naming the missing part, when the plugin's switchEdits cannot locate one", async () => {
    const p = await directProject({ publishPipeline: true });
    await writeFile(p.configFile, 'export default defineConfig(presetModuleConfig({ persistenceFile: "./data/kestrel.db" }));\n');
    const pluginSwitchEdits = async (): Promise<{ parts: Record<string, Edit[] | undefined>; blockers: readonly string[] }> => ({ parts: { "plugin's own module swap": undefined }, blockers: [] });
    const answers = new Map([["switch-to-queue", "yes"], ["idempotent:publishPage", "yes"], ["relay-pipelines", "publishPage"]]);
    const ctx: RuleContext = { root: dir, scratch: dir, project: p, bootCheck: { errors: [], warnings: [], notChecked: [] }, readFile: readFileOrUndefined, answers, previewBoot: cleanPreviewBoot, switchEdits: pluginSwitchEdits };
    const findings = await queueOfferRule.check(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).not.toBe("auto");
    expect(findings[0]?.suggestion).toContain("plugin's own module swap");
  });

  it("lets a plugin's switchEdits handle a config that never literally names events-direct, verified through the booted module list", async () => {
    const p = await directProject();
    await writeFile(p.configFile, 'export default defineConfig(presetModuleConfig({ persistenceFile: "./data/kestrel.db" }));\n');
    const pluginSwitchEdits = async (): Promise<{ parts: Record<string, Edit[] | undefined>; blockers: readonly string[] }> => ({
      parts: { "plugin's own module swap": [{ file: join(dir, "shared", "model.ts"), start: 0, end: 0, text: "// switched\n" }] },
      blockers: [],
    });
    const previewDetails = async (): Promise<{ moduleUses?: readonly string[]; issues: readonly LoadIssue[] }> => ({
      moduleUses: ["@michaelthielemann/kestrel-events-inmemory", "@michaelthielemann/kestrel-events-queue", "@michaelthielemann/kestrel-persistence-sqlite"],
      issues: [],
    });
    const ctx: InternalRuleContext = { root: dir, scratch: dir, project: p, bootCheck: { errors: [], warnings: [], notChecked: [] }, readFile: readFileOrUndefined, answers: new Map(), previewBoot: cleanPreviewBoot, switchEdits: pluginSwitchEdits, previewDetails };
    const findings = await queueOfferRule.check(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("ask");
  });

  it("blocks, naming the plugin, when the preview boot shows events-direct still in the booted module list", async () => {
    const p = await directProject();
    await writeFile(p.configFile, 'export default defineConfig(presetModuleConfig({ persistenceFile: "./data/kestrel.db" }));\n');
    const pluginSwitchEdits = async (): Promise<{ parts: Record<string, Edit[] | undefined>; blockers: readonly string[] }> => ({ parts: {}, blockers: [] });
    const previewDetails = async (): Promise<{ moduleUses?: readonly string[]; issues: readonly LoadIssue[] }> => ({
      moduleUses: ["@michaelthielemann/kestrel-events-inmemory", "@michaelthielemann/kestrel-events-direct", "@michaelthielemann/kestrel-persistence-sqlite"],
      issues: [],
    });
    const ctx: InternalRuleContext = { root: dir, scratch: dir, project: p, bootCheck: { errors: [], warnings: [], notChecked: [] }, readFile: readFileOrUndefined, answers: new Map(), previewBoot: cleanPreviewBoot, switchEdits: pluginSwitchEdits, previewDetails, pluginKind: "test-host" };
    const findings = await queueOfferRule.check(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).not.toBe("ask");
    expect(findings[0]?.message).toContain("did not remove it");
    expect(findings[0]?.message).toContain('"test-host" plugin');
  });
});

describe("offer/event-queue: verifyEdits' notChecked-awareness", () => {
  it("treats a relay pipeline the boot preview did not check as unverified, even with no new errors", async () => {
    const p = await directProject({ publishPipeline: true });
    const previewBoot = async (): Promise<BootCheck> => ({ errors: [], warnings: [], notChecked: [{ kind: "pipeline", name: "publishPage", because: "excluded by --run-setup" }] });
    const ctx: RuleContext = { root: dir, scratch: dir, project: p, bootCheck: { errors: [], warnings: [], notChecked: [] }, readFile: readFileOrUndefined, answers: new Map(), previewBoot };
    const findings = await queueOfferRule.check(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("ask");
    expect(findings[0]?.fix.kind === "ask" ? findings[0].fix.defaultValue : "n/a").toBeUndefined();
  });

  it("names the unchecked relay pipeline and its own reason in the prompt, instead of guessing events-queue is not installed", async () => {
    const p = await directProject({ publishPipeline: true });
    const previewBoot = async (): Promise<BootCheck> => ({ errors: [], warnings: [], notChecked: [{ kind: "pipeline", name: "publishPage", because: "config.modules does not pair reliably with the loaded modules" }] });
    const ctx: RuleContext = { root: dir, scratch: dir, project: p, bootCheck: { errors: [], warnings: [], notChecked: [] }, readFile: readFileOrUndefined, answers: new Map(), previewBoot };
    const findings = await queueOfferRule.check(ctx);
    expect(findings).toHaveLength(1);
    const prompt = findings[0]?.fix.kind === "ask" ? findings[0].fix.prompt : "";
    expect(prompt).toContain("publishPage");
    expect(prompt).toContain("config.modules does not pair reliably with the loaded modules");
    expect(prompt).not.toContain("may not be installed");
  });

  it("still offers the switch when every relay pipeline was checked and no new error appeared", async () => {
    const p = await directProject({ publishPipeline: true });
    const previewBoot = async (): Promise<BootCheck> => ({ errors: [], warnings: [], notChecked: [{ kind: "pipeline", name: "someOtherPipeline", because: "unrelated" }] });
    const ctx: RuleContext = { root: dir, scratch: dir, project: p, bootCheck: { errors: [], warnings: [], notChecked: [] }, readFile: readFileOrUndefined, answers: new Map(), previewBoot };
    const findings = await queueOfferRule.check(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("ask");
    expect(findings[0]?.fix.kind === "ask" ? findings[0].fix.defaultValue : "n/a").toBe("no");
  });
});
