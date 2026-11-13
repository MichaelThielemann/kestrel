import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PipelineDefinition } from "@michaelthielemann/kestrel";
import { applyEdits } from "./apply.ts";
import { parseTs } from "./ast.ts";
import type { LoadedProject, RuleContext } from "./plugin.ts";
import type { Edit, Finding } from "./report.ts";
import { exportLlmsRule, indexTriggersRule, robotsPolicyRule, siteUrlRule } from "./ruleDeliveryIndexes.ts";
import { upgradingDocs } from "./ruleHelpers.ts";
import { DEFAULT_RULES, readFileOrUndefined } from "./rules.ts";

const DELIVERY = "@michaelthielemann/kestrel-delivery-static";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-indexes-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function contextFor(project: LoadedProject): RuleContext {
  return { root: dir, scratch: dir, project, bootCheck: { errors: [], warnings: [], notChecked: [] }, readFile: readFileOrUndefined, answers: new Map() };
}

interface ProjectOptions {
  configSource?: string;
  deliveryConfig?: Record<string, unknown>;
  triggers?: unknown[];
  pipelines?: Array<{ name: string; steps: string[]; file?: string; source?: string }>;
}

async function project(options: ProjectOptions): Promise<LoadedProject> {
  const configFile = join(dir, "kestrel.config.ts");
  await writeFile(configFile, options.configSource ?? "export default defineConfig({ modules: [], triggers: [] });\n");
  const pipelineFiles: Array<{ file: string; pipelines: string[] }> = [];
  for (const p of options.pipelines ?? []) {
    const file = join(dir, "pipelines", p.file ?? `${p.name}.ts`);
    const existing = pipelineFiles.find((f) => f.file === file);
    if (existing) existing.pipelines.push(p.name);
    else pipelineFiles.push({ file, pipelines: [p.name] });
  }
  await rm(join(dir, "pipelines"), { recursive: true, force: true });
  await mkdir(join(dir, "pipelines"), { recursive: true });
  for (const { file, pipelines } of pipelineFiles) {
    const defs = (options.pipelines ?? []).filter((p) => pipelines.includes(p.name));
    const source = defs[0]?.source ?? defs.map((p) => `export const ${p.name} = definePipeline({ name: "${p.name}", steps: ${JSON.stringify(p.steps)} });\n`).join("");
    await writeFile(file, source);
  }
  const pipelines: PipelineDefinition[] = (options.pipelines ?? []).map((p) => ({ name: p.name, steps: p.steps }));
  return {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    input: { config: { modules: options.deliveryConfig === undefined ? [] : [{ use: DELIVERY, config: options.deliveryConfig }], triggers: (options.triggers ?? []) as never }, modules: [], pipelines },
    kind: "backend",
    configFile,
    moduleFiles: new Map(),
    pipelineFiles,
  };
}

function autoEdits(finding: Finding | undefined): Edit[] {
  return finding?.fix.kind === "auto" ? finding.fix.edits : [];
}

function applyTo(file: string, source: string, edits: Edit[]): string {
  return applyEdits(source, edits.filter((e) => e.file === file)).text;
}

describe("delivery/export-llms", () => {
  it("rewrites delivery.exportLlms run inside a request to delivery.requestIndexes", async () => {
    const p = await project({ triggers: [{ http: "POST /admin/publish-all/pages", pipeline: "publishAllPages" }], pipelines: [{ name: "publishAllPages", steps: ["delivery.publishAll:pages", "delivery.exportLlms"] }] });
    const findings = await exportLlmsRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "delivery/export-llms", severity: "error", where: { pipeline: "publishAllPages" }, docs: upgradingDocs("delivery-export-llms") });
    const file = p.pipelineFiles[0]!.file;
    const text = applyTo(file, readFileOrUndefined(file)!, autoEdits(findings[0]));
    expect(text).toContain('["delivery.publishAll:pages","delivery.requestIndexes"]');
  });

  it("rewrites delivery.exportLlms in a pipeline on delivery.llmsStale to delivery.exportLlmsFull", async () => {
    const p = await project({ triggers: [{ event: "delivery.llmsStale", pipeline: "refreshLlms" }], pipelines: [{ name: "refreshLlms", steps: ["delivery.exportLlms"] }] });
    const findings = await exportLlmsRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    const file = p.pipelineFiles[0]!.file;
    expect(applyTo(file, readFileOrUndefined(file)!, autoEdits(findings[0]))).toContain('["delivery.exportLlmsFull"]');
  });

  it("leaves a file to the user when it holds both a request pipeline and a delivery.llmsStale pipeline running the step", async () => {
    const p = await project({
      triggers: [{ event: "page.updated", pipeline: "publishPage" }, { event: "delivery.llmsStale", pipeline: "refreshLlms" }],
      pipelines: [
        { name: "publishPage", steps: ["delivery.publish:pages", "delivery.exportLlms"], file: "delivery.ts" },
        { name: "refreshLlms", steps: ["delivery.exportLlms"], file: "delivery.ts" },
      ],
    });
    const findings = await exportLlmsRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("manual");
    expect(findings[0]?.suggestion).toContain("delivery.requestIndexes");
    expect(findings[0]?.suggestion).toContain("delivery.exportLlmsFull");
  });

  it("rewrites a shared file when only the request pipeline in it runs the step", async () => {
    const p = await project({
      triggers: [{ event: "page.updated", pipeline: "publishPage" }, { event: "delivery.llmsStale", pipeline: "refreshLlms" }],
      pipelines: [
        { name: "publishPage", steps: ["delivery.publish:pages", "delivery.exportLlms"], file: "delivery.ts" },
        { name: "refreshLlms", steps: ["delivery.exportLlmsFull"], file: "delivery.ts" },
      ],
    });
    const findings = await exportLlmsRule.check(contextFor(p));
    const file = p.pipelineFiles[0]!.file;
    expect(applyTo(file, readFileOrUndefined(file)!, autoEdits(findings[0]))).toContain('["delivery.publish:pages","delivery.requestIndexes"]');
  });

  it("stays quiet when no pipeline names delivery.exportLlms", async () => {
    const p = await project({ pipelines: [{ name: "publishPage", steps: ["delivery.publish:pages", "delivery.requestIndexes"] }] });
    expect(await exportLlmsRule.check(contextFor(p))).toEqual([]);
  });
});

describe("delivery/site-url", () => {
  const withSiteUrl = 'export default defineConfig({ modules: [{ use: "@michaelthielemann/kestrel-delivery-static", config: { types: { pages: {} }, llms: { siteUrl: "https://example.org", full: true } } }], triggers: [] });\n';

  it("moves llms.siteUrl to the top-level siteUrl", async () => {
    const p = await project({ configSource: withSiteUrl, deliveryConfig: { types: { pages: {} }, llms: { siteUrl: "https://example.org", full: true } } });
    const findings = await siteUrlRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "delivery/site-url", severity: "error", where: { module: DELIVERY, path: "llms.siteUrl" }, docs: upgradingDocs("delivery-site-url") });
    const text = applyTo(p.configFile, withSiteUrl, autoEdits(findings[0]));
    expect(text).toContain('config: { types: { pages: {} }, llms: { full: true }, siteUrl: "https://example.org" }');
  });

  it("only removes llms.siteUrl when a top-level siteUrl is already set", async () => {
    const source = 'export default defineConfig({ modules: [{ use: "@michaelthielemann/kestrel-delivery-static", config: { siteUrl: "https://example.org", llms: { siteUrl: "https://example.org" } } }], triggers: [] });\n';
    const p = await project({ configSource: source, deliveryConfig: { siteUrl: "https://example.org", llms: { siteUrl: "https://example.org" } } });
    const findings = await siteUrlRule.check(contextFor(p));
    const text = applyTo(p.configFile, source, autoEdits(findings[0]));
    expect(text).toMatch(/config: \{ siteUrl: "https:\/\/example\.org", llms: \{\s*\} \}/);
  });

  it("falls back to manual when llms.siteUrl is not an object-literal property in the config file", async () => {
    const source = 'const llms = { siteUrl: "https://example.org" };\nexport default defineConfig({ modules: [{ use: "@michaelthielemann/kestrel-delivery-static", config: { llms } }], triggers: [] });\n';
    const p = await project({ configSource: source, deliveryConfig: { llms: { siteUrl: "https://example.org" } } });
    const findings = await siteUrlRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("manual");
    expect(findings[0]?.suggestion).toContain("by hand");
  });

  it("moves llms.siteUrl read from an environment variable that is unset while the check runs", async () => {
    const source = 'export default defineConfig({ modules: [{ use: "@michaelthielemann/kestrel-delivery-static", config: { llms: { siteUrl: process.env.SITE_URL, full: true } } }], triggers: [] });\n';
    const p = await project({ configSource: source, deliveryConfig: { llms: { siteUrl: undefined, full: true } } });
    const findings = await siteUrlRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(applyTo(p.configFile, source, autoEdits(findings[0]))).toContain("config: { llms: { full: true }, siteUrl: process.env.SITE_URL }");
  });

  it("only removes llms.siteUrl when the top-level siteUrl comes from an unset environment variable", async () => {
    const source = 'export default defineConfig({ modules: [{ use: "@michaelthielemann/kestrel-delivery-static", config: { siteUrl: process.env.SITE_URL, llms: { siteUrl: process.env.SITE_URL } } }], triggers: [] });\n';
    const p = await project({ configSource: source, deliveryConfig: { siteUrl: undefined, llms: { siteUrl: undefined } } });
    const findings = await siteUrlRule.check(contextFor(p));
    expect(applyTo(p.configFile, source, autoEdits(findings[0]))).toMatch(/config: \{ siteUrl: process\.env\.SITE_URL, llms: \{\s*\} \}/);
  });

  it("stays quiet without llms.siteUrl", async () => {
    const p = await project({ deliveryConfig: { siteUrl: "https://example.org", llms: { full: true } } });
    expect(await siteUrlRule.check(contextFor(p))).toEqual([]);
  });
});

describe("delivery/index-triggers", () => {
  const configSource = 'export default defineConfig({ modules: [], triggers: [{ event: "delivery.outputStale", pipeline: "republishOutput" }] });\n';
  const republish = { name: "republishOutput", steps: ["delivery.republishOutput"] };
  const outputStale = { event: "delivery.outputStale", pipeline: "republishOutput" };

  it("adds a refreshIndexes pipeline and its delivery.indexesStale trigger for render \"events\"", async () => {
    const p = await project({ configSource, deliveryConfig: { dependencies: { render: "events" } }, triggers: [outputStale], pipelines: [republish] });
    const findings = await indexTriggersRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "delivery/index-triggers", severity: "error", docs: upgradingDocs("delivery-index-triggers") });
    expect(findings[0]?.message).toContain("delivery.indexesStale");
    expect(findings[0]?.message).not.toContain("delivery.llmsStale");
    const edits = autoEdits(findings[0]);
    const created = edits.find((e) => e.create === true);
    expect(created?.file).toBe(join(dir, "pipelines", "refreshIndexes.ts"));
    expect(created?.text).toContain('steps: ["delivery.exportIndexes"]');
    const text = applyTo(p.configFile, configSource, edits);
    expect(text).toContain('{ event: "delivery.indexesStale", pipeline: "refreshIndexes" }');
    expect(() => parseTs(text)).not.toThrow();
  });

  it("adds refreshLlms with delivery.exportLlmsFull on delivery.llmsStale when llms.full is set", async () => {
    const p = await project({ configSource, deliveryConfig: { llms: { full: true }, dependencies: { render: "events" } }, triggers: [outputStale], pipelines: [republish] });
    const findings = await indexTriggersRule.check(contextFor(p));
    const edits = autoEdits(findings[0]);
    expect(edits.filter((e) => e.create === true).map((e) => e.file)).toEqual([join(dir, "pipelines", "refreshIndexes.ts"), join(dir, "pipelines", "refreshLlms.ts")]);
    expect(edits.find((e) => e.file.endsWith("refreshLlms.ts"))?.text).toContain('steps: ["delivery.exportLlmsFull"]');
    const text = applyTo(p.configFile, configSource, edits);
    expect(text).toContain('{ event: "delivery.llmsStale", pipeline: "refreshLlms" }');
  });

  it("counts a delivery.llmsStale pipeline still running delivery.exportLlms as wired, since delivery/export-llms renames it", async () => {
    const p = await project({
      configSource,
      deliveryConfig: { llms: { full: true }, dependencies: { render: "events" } },
      triggers: [outputStale, { event: "delivery.llmsStale", pipeline: "refreshLlms" }],
      pipelines: [republish, { name: "refreshLlms", steps: ["delivery.exportLlms"] }],
    });
    const findings = await indexTriggersRule.check(contextFor(p));
    expect(autoEdits(findings[0]).some((e) => e.file.endsWith("refreshLlms.ts"))).toBe(false);
    expect(findings[0]?.message).not.toContain("delivery.llmsStale");
  });

  it("only adds the trigger when a refreshIndexes pipeline running delivery.exportIndexes exists", async () => {
    const p = await project({ configSource, deliveryConfig: { dependencies: { render: "events" } }, triggers: [outputStale], pipelines: [republish, { name: "refreshIndexes", steps: ["delivery.exportIndexes"] }] });
    const edits = autoEdits((await indexTriggersRule.check(contextFor(p)))[0]);
    expect(edits.some((e) => e.create === true)).toBe(false);
    expect(applyTo(p.configFile, configSource, edits)).toContain('{ event: "delivery.indexesStale", pipeline: "refreshIndexes" }');
  });

  it("leaves it to the user when a pipeline named refreshIndexes runs something else", async () => {
    const p = await project({ configSource, deliveryConfig: { dependencies: { render: "events" } }, triggers: [outputStale], pipelines: [republish, { name: "refreshIndexes", steps: ["delivery.resumeStale"] }] });
    const findings = await indexTriggersRule.check(contextFor(p));
    expect(findings[0]?.fix.kind).toBe("manual");
    expect(findings[0]?.suggestion).toContain("refreshIndexes");
  });

  it("stays quiet for render \"background\" and for a complete wiring", async () => {
    expect(await indexTriggersRule.check(contextFor(await project({ deliveryConfig: { llms: { full: true } }, pipelines: [republish] })))).toEqual([]);
    const wired = await project({
      configSource,
      deliveryConfig: { llms: { full: true }, dependencies: { render: "events" } },
      triggers: [outputStale, { event: "delivery.indexesStale", pipeline: "refreshIndexes" }, { event: "delivery.llmsStale", pipeline: "refreshLlms" }],
      pipelines: [republish, { name: "refreshIndexes", steps: ["delivery.exportIndexes"] }, { name: "refreshLlms", steps: ["delivery.exportLlmsFull"] }],
    });
    expect(await indexTriggersRule.check(contextFor(wired))).toEqual([]);
  });
});

describe("delivery/robots-policy", () => {
  const source = 'export default defineConfig({ modules: [{ use: "@michaelthielemann/kestrel-delivery-static", config: { types: { pages: {} } } }], triggers: [] });\n';

  it("sets robots.policy to allow when delivery-static has none, keeping the site open to crawlers", async () => {
    const p = await project({ configSource: source, deliveryConfig: { types: { pages: {} } } });
    const findings = await robotsPolicyRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "delivery/robots-policy", severity: "warning", where: { module: DELIVERY, path: "robots.policy" }, docs: upgradingDocs("delivery-robots-policy") });
    expect(findings[0]?.message).toContain("Disallow: /");
    const text = applyTo(p.configFile, source, autoEdits(findings[0]));
    expect(text).toContain('config: { types: { pages: {} }, robots: { policy: "allow" } }');
    expect(() => parseTs(text)).not.toThrow();
  });

  it("leaves a robots object without a policy to the user", async () => {
    const withExtra = 'export default defineConfig({ modules: [{ use: "@michaelthielemann/kestrel-delivery-static", config: { robots: { extra: ["Disallow: /preview/"] } } }], triggers: [] });\n';
    const p = await project({ configSource: withExtra, deliveryConfig: { robots: { extra: ["Disallow: /preview/"] } } });
    const findings = await robotsPolicyRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("manual");
  });

  it("stays quiet with a policy, with one read from an unset environment variable, with robots: false and without delivery-static", async () => {
    for (const deliveryConfig of [{ robots: { policy: "disallow" } }, { robots: { policy: undefined } }, { robots: false }]) expect(await robotsPolicyRule.check(contextFor(await project({ deliveryConfig })))).toEqual([]);
    expect(await robotsPolicyRule.check(contextFor(await project({})))).toEqual([]);
  });
});

describe("the delivery index rules are part of the default rule set", () => {
  it("lists all four", () => {
    const ids = DEFAULT_RULES.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["delivery/export-llms", "delivery/site-url", "delivery/index-triggers", "delivery/robots-policy"]));
  });
});
