import { dirname, join } from "node:path";
import { pipelineSteps } from "@michaelthielemann/kestrel/definePipeline";
import { createPipelineFile, hoistModuleConfigProperty, insertTriggers, removeNestedModuleConfigProperty, renameStringLiterals } from "./edits.ts";
import { isRecord } from "./guards.ts";
import type { Rule, RuleContext } from "./plugin.ts";
import type { Edit, Finding } from "./report.ts";
import { combineEditParts, finding, moduleEntry, upgradingDocs } from "./ruleHelpers.ts";

const EXPORT_LLMS = "delivery.exportLlms";
const INDEXES_STALE = "delivery.indexesStale";
const LLMS_STALE = "delivery.llmsStale";

function runsStep(ctx: RuleContext): (pipeline: string, step: string) => boolean {
  const stepsOf = new Map(ctx.project.input.pipelines.map((p) => [p.name, pipelineSteps(p.steps)]));
  return (pipeline, step) => (stepsOf.get(pipeline) ?? []).some((s) => s === step || s.startsWith(`${step}:`));
}

function pipelinesOn(ctx: RuleContext, event: string): Set<string> {
  return new Set(ctx.project.input.config.triggers.flatMap((t) => ("event" in t && t.event === event ? [t.pipeline] : [])));
}

/** `delivery/export-llms`: `delivery.exportLlms` is gone; a request runs `delivery.requestIndexes` instead, and a `delivery.llmsStale` job runs `delivery.exportLlmsFull`. */
export const exportLlmsRule: Rule = {
  id: "delivery/export-llms",
  check(ctx) {
    const runs = runsStep(ctx);
    const llmsJobs = pipelinesOn(ctx, LLMS_STALE);
    const findings: Finding[] = [];
    for (const { file, pipelines } of ctx.project.pipelineFiles) {
      const source = ctx.readFile(file);
      if (source === undefined) continue;
      const toRequest = renameStringLiterals(file, source, EXPORT_LLMS, "delivery.requestIndexes");
      if (toRequest.length === 0) continue;
      const known = pipelines.filter((p) => runs(p, EXPORT_LLMS));
      const users = known.length > 0 ? known : pipelines;
      const jobs = users.filter((p) => llmsJobs.has(p));
      const where = users.length === 1 ? { file, pipeline: users[0]! } : { file };
      const message = `"${EXPORT_LLMS}" was removed: a request no longer writes the index files itself, and llms-full.txt has its own export step`;
      const docs = upgradingDocs("delivery-export-llms");
      if (jobs.length > 0 && jobs.length < users.length) {
        const suggestion = `by hand: run delivery.requestIndexes in ${users.filter((p) => !llmsJobs.has(p)).join(", ")} and delivery.exportLlmsFull in ${jobs.join(", ")}, the pipelines on ${LLMS_STALE}`;
        findings.push(finding(`delivery/export-llms:${file}`, "delivery/export-llms", message, suggestion, where, undefined, docs));
        continue;
      }
      const to = jobs.length > 0 ? "delivery.exportLlmsFull" : "delivery.requestIndexes";
      const suggestion = jobs.length > 0 ? `rename "${EXPORT_LLMS}" to "${to}" in the pipeline on ${LLMS_STALE}` : `rename "${EXPORT_LLMS}" to "${to}", which asks for the export of sitemap.xml, robots.txt and llms.txt outside the request`;
      const edits = jobs.length > 0 ? renameStringLiterals(file, source, EXPORT_LLMS, to) : toRequest;
      findings.push(finding(`delivery/export-llms:${file}`, "delivery/export-llms", message, suggestion, where, edits, docs));
    }
    return findings;
  },
};

/** `delivery/site-url`: `delivery-static` takes `siteUrl` at the top level of its config, shared by llms.txt, sitemap.xml and robots.txt, and refuses `llms.siteUrl`. */
export const siteUrlRule: Rule = {
  id: "delivery/site-url",
  check(ctx) {
    const entry = moduleEntry(ctx, "delivery-static");
    if (entry === undefined || !isRecord(entry.config) || !isRecord(entry.config.llms) || !("siteUrl" in entry.config.llms)) return [];
    const hasTopLevel = "siteUrl" in entry.config;
    const source = ctx.readFile(ctx.project.configFile);
    let edits: Edit[] | undefined;
    if (source !== undefined) {
      if (hasTopLevel) {
        const removal = removeNestedModuleConfigProperty(ctx.project.configFile, source, { use: entry.use, path: ["llms"], key: "siteUrl" });
        edits = removal === undefined ? undefined : [removal];
      } else {
        edits = hoistModuleConfigProperty(ctx.project.configFile, source, { use: entry.use, path: ["llms"], key: "siteUrl" });
      }
    }
    const message = "delivery-static's llms.siteUrl moved to a top-level siteUrl, which llms.txt, sitemap.xml and robots.txt share; boot fails on llms.siteUrl";
    const suggestion = hasTopLevel ? "remove llms.siteUrl; the top-level siteUrl is the one used" : "move llms.siteUrl to delivery-static's top-level siteUrl";
    return [finding("delivery/site-url", "delivery/site-url", message, edits === undefined ? `${suggestion} by hand` : suggestion, { file: ctx.project.configFile, module: entry.use, path: "llms.siteUrl" }, edits, upgradingDocs("delivery-site-url"))];
  },
};

/** `delivery/robots-policy`: `delivery-static` writes `<prefix>robots.txt`, and without `robots.policy` it is `Disallow: /` unless `NODE_ENV` is `production`. */
export const robotsPolicyRule: Rule = {
  id: "delivery/robots-policy",
  check(ctx) {
    const entry = moduleEntry(ctx, "delivery-static");
    if (entry === undefined || !isRecord(entry.config)) return [];
    const robots = entry.config.robots;
    if (robots === false || (isRecord(robots) && "policy" in robots)) return [];
    const message = "delivery-static writes and owns <prefix>robots.txt and <prefix>sitemap.xml; without robots.policy, robots.txt is \"Disallow: /\" unless NODE_ENV is production";
    const suggestion = 'run production with NODE_ENV=production, or set robots.policy by hand: "allow" (what a site without robots.txt had), "disallow" for a site crawlers must not index, a value read per deployment from an environment variable, or robots: false to keep your own robots.txt';
    return [finding("delivery/robots-policy", "delivery/robots-policy", message, suggestion, { file: ctx.project.configFile, module: entry.use, path: "robots.policy" }, undefined, upgradingDocs("delivery-robots-policy"), "warning")];
  },
};

interface ExportJob {
  event: string;
  pipeline: string;
  step: string;
}

function pipelinesDirOf(ctx: RuleContext): string | undefined {
  const first = ctx.project.pipelineFiles[0]?.file;
  return first === undefined ? undefined : dirname(first);
}

/** `delivery/index-triggers`: with `dependencies.render: "events"`, boot needs a job on `delivery.indexesStale` running `delivery.exportIndexes`, and with `llms.full` one on `delivery.llmsStale` running `delivery.exportLlmsFull`. */
export const indexTriggersRule: Rule = {
  id: "delivery/index-triggers",
  check(ctx) {
    const entry = moduleEntry(ctx, "delivery-static");
    if (entry === undefined || !isRecord(entry.config)) return [];
    const dependencies = isRecord(entry.config.dependencies) ? entry.config.dependencies : {};
    if (dependencies.render !== "events") return [];
    const full = isRecord(entry.config.llms) && entry.config.llms.full === true;
    const runs = runsStep(ctx);
    const subscribed = (event: string, steps: readonly string[]): boolean => [...pipelinesOn(ctx, event)].some((p) => steps.some((s) => runs(p, s)));
    const missing: ExportJob[] = [];
    if (!subscribed(INDEXES_STALE, ["delivery.exportIndexes"])) missing.push({ event: INDEXES_STALE, pipeline: "refreshIndexes", step: "delivery.exportIndexes" });
    if (full && !subscribed(LLMS_STALE, ["delivery.exportLlmsFull", EXPORT_LLMS])) missing.push({ event: LLMS_STALE, pipeline: "refreshLlms", step: "delivery.exportLlmsFull" });
    if (missing.length === 0) return [];

    const message = `dependencies.render is "events", but no trigger runs ${missing.map((j) => `${j.step} on ${j.event}`).join(" or ")}; boot fails without it`;
    const suggestion = `add ${missing.map((j) => `a ${j.pipeline} pipeline (steps: ${j.step}) with an event trigger on ${j.event}`).join(" and ")}`;
    const docs = upgradingDocs("delivery-index-triggers");
    const where = { file: ctx.project.configFile, module: entry.use };
    const dir = pipelinesDirOf(ctx);
    const configSource = ctx.readFile(ctx.project.configFile);
    if (dir === undefined || configSource === undefined) return [finding("delivery/index-triggers", "delivery/index-triggers", message, `${suggestion} by hand`, where, undefined, docs)];

    const parts: Record<string, Edit[] | undefined> = {};
    const triggers: string[] = [];
    for (const job of missing) {
      const trigger = `{ event: "${job.event}", pipeline: "${job.pipeline}" }`;
      if (ctx.project.input.pipelines.some((p) => p.name === job.pipeline)) {
        parts[`a ${job.pipeline} pipeline running ${job.step}`] = runs(job.pipeline, job.step) ? [] : undefined;
        triggers.push(trigger);
        continue;
      }
      const file = join(dir, `${job.pipeline}.ts`);
      parts[`${job.pipeline} pipeline file`] = ctx.readFile(file) === undefined ? [createPipelineFile(file, { name: job.pipeline, steps: [job.step] })] : undefined;
      triggers.push(trigger);
    }
    const triggerEdit = insertTriggers(ctx.project.configFile, configSource, triggers);
    parts["the event trigger(s)"] = triggerEdit === undefined ? undefined : [triggerEdit];
    const { edits, missing: unlocated } = combineEditParts(parts);
    return [finding("delivery/index-triggers", "delivery/index-triggers", message, unlocated.length > 0 ? `${suggestion} by hand; could not use: ${unlocated.join(", ")}` : suggestion, where, edits, docs)];
  },
};

export const DELIVERY_INDEX_RULES: readonly Rule[] = [exportLlmsRule, siteUrlRule, robotsPolicyRule, indexTriggersRule];
