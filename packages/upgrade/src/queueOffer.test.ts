import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { BootCheck, BootProblem, ModuleDefinition, PipelineDefinition } from "@michaelthielemann/kestrel";
import { defineContract } from "@michaelthielemann/kestrel/defineContract";
import { applyEdits } from "./apply.ts";
import type { LoadedProject, RuleContext } from "./plugin.ts";
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

function contextFor(
  project: LoadedProject,
  answers: ReadonlyMap<string, string> = new Map(),
  previewBoot?: (edits: readonly Edit[]) => Promise<BootCheck | undefined>,
): RuleContext {
  const check: BootCheck = { errors: [], warnings: [], notChecked: [] };
  return { root: dir, scratch: dir, project, bootCheck: check, readFile: readFileOrUndefined, answers, ...(previewBoot === undefined ? {} : { previewBoot }) };
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
    pipelineFiles: new Map([["createPage", createPageFile], ["publishPage", publishPageFile]]),
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
