import { pipelineSteps } from "@michaelthielemann/kestrel/definePipeline";
import { isRecord } from "./guards.ts";
import type { Rule, SourceRule } from "./plugin.ts";
import type { Finding } from "./report.ts";
import { hasModule, infoFinding, localModuleFiles, moduleEntry, upgradingDocs } from "./ruleHelpers.ts";

const PUBLISH_STEPS = ["delivery.publish", "delivery.unpublish"];

/** `responses/delivery-members`: an HTTP-triggered pipeline running a delivery step answers with the 6.0.0 response shape, not the 5.8 one. */
export const deliveryMembersRule: Rule = {
  id: "responses/delivery-members",
  check(ctx) {
    const findings: Finding[] = [];
    for (const t of ctx.project.input.config.triggers) {
      if (!("http" in t)) continue;
      const def = ctx.project.input.pipelines.find((p) => p.name === t.pipeline);
      if (def === undefined) continue;
      const names = pipelineSteps(def.steps).map((s) => s.split(":")[0]!);
      const changes: string[] = [];
      if (names.some((n) => PUBLISH_STEPS.includes(n))) changes.push("delivery.publish now merges { document, delivery } into _delivery instead of replacing the result with it, and a missing id is 400 instead of 500");
      if (names.includes("delivery.exportLlms")) changes.push("delivery.exportLlms is gone and delivery.requestIndexes, which replaces it, adds nothing to the result, so the response has no llms member");
      if (changes.length === 0) continue;
      findings.push(infoFinding(`responses/delivery-members:${t.http}`, "responses/delivery-members", `${t.http} runs a delivery step whose response shape changed: ${changes.join("; ")}`, "update any client reading the old field names", { file: ctx.project.configFile, pipeline: t.pipeline }, upgradingDocs("responses-delivery-members")));
    }
    return findings;
  },
};

const ON_CALL = /\.on\(\s*(['"])([^'"]+)\1/g;

function subscribedEventsIn(source: string): string[] {
  const events = new Set<string>();
  for (const match of source.matchAll(ON_CALL)) events.add(match[2]!);
  return [...events];
}

/** `runtime/bus-handler-throws`: a programmatic `events.on` subscriber whose handler throws now fails the emitting run with 500 under events-direct. */
export const busHandlerThrowsRule: Rule = {
  id: "runtime/bus-handler-throws",
  check(ctx) {
    if (!hasModule(ctx, "events-direct")) return [];
    const findings: Finding[] = [];
    for (const [, file] of localModuleFiles(ctx)) {
      const source = ctx.readFile(file);
      if (source === undefined || subscribedEventsIn(source).length === 0) continue;
      findings.push(infoFinding(`runtime/bus-handler-throws:${file}`, "runtime/bus-handler-throws", "a local module subscribes to events@1 with .on(...); with events-direct, a handler that throws now fails the emitting run with 500 instead of being logged and ignored", "make sure the handler cannot throw for an input it does not control, or catch and log inside it", { file }, upgradingDocs("runtime-bus-handler-throws")));
    }
    return findings;
  },
};

/** `runtime/bus-subscriber-queue`: with events-queue, a programmatic `events.on` subscriber no longer sees events a pipeline step emits — the queue never touches the bus. */
export const busSubscriberQueueRule: Rule = {
  id: "runtime/bus-subscriber-queue",
  check(ctx) {
    if (!hasModule(ctx, "events-queue")) return [];
    const triggerEvents = new Set(ctx.project.input.config.triggers.flatMap((t) => ("event" in t ? [t.event] : [])));
    const findings: Finding[] = [];
    for (const [moduleName, file] of localModuleFiles(ctx)) {
      const source = ctx.readFile(file);
      if (source === undefined) continue;
      const subscribed = subscribedEventsIn(source).filter((e) => triggerEvents.has(e));
      if (subscribed.length === 0) continue;
      findings.push(infoFinding(`runtime/bus-subscriber-queue:${moduleName}`, "runtime/bus-subscriber-queue", `module "${moduleName}" subscribes to ${subscribed.join(", ")} with .on(...); with events-queue, a pipeline step's events.emit never touches the bus, so this subscriber stops seeing it`, "move the logic into a pipeline the event triggers, or keep events-direct", { file, module: moduleName }, upgradingDocs("runtime-bus-subscriber-queue")));
    }
    return findings;
  },
};

/** `types/breaking-signatures`: `Deps`, `Introspection`, `PipelineDefinition["steps"]`, `ModuleManifest`, `FakePersistence`, `Manifest`, `Kestrel["contracts"]`, `Media`, `MediaItem`, `MediaStatus` and `Images` all gained required members or values; only the consumer's own typecheck sees a violation. */
export const typeSignaturesRule: SourceRule = {
  id: "types/breaking-signatures",
  needs: "source",
  check() {
    return [
      infoFinding("types/breaking-signatures", "types/breaking-signatures", "Deps.eventTriggers, Introspection.health(), PipelineDefinition[\"steps\"] (readonly PipelineEntry[]), ModuleManifest.atomicScope, FakePersistence's atomic members, Manifest.warnings and Kestrel[\"contracts\"].names() are all required now. Media: Media lost migrateKeys, gained serveFile, syncPublic, toPublicItem, publicCopyEnabled, anonymousListAllowed, sanitizesSvg and attach, and upload takes a fourth svgSanitized argument; MediaItem gained location and svgSanitized. Images: Images gained plan, syncPublic, publicCopyEnabled, variantCounts and attach, and its Renderer takes a third planned argument; VariantState gained planned. Reading media through media@1: createImages takes deps.media (a media@1 provider) and images-default's Config lost media; Media extends MediaFiles (file, files, load, scan, count); MediaStatus gained removing. The media trash: MediaStatus gained trashed; MediaItem gained trashedAt and trashVersion, and its location may be null; Media gained trash, trashFolder, restore, listTrash, trashIds, selectTrash and purge; Images gained hide, show and hidden. Focus and crop: Images gained setFraming and framingsOf; Variant gained crop, renderedCrop, originalWidth and originalHeight", "run your own typecheck after installing the 6.0.0 packages; a hand-built implementation of any of these needs the new members", {}, upgradingDocs("types-breaking-signatures")),
    ];
  },
};

const STEP_SHAPE_CHANGES: Record<string, string> = {
  "redirects.lookup": "its hit is now terminalOutput: { redirect: { to, status } }, combined with the 200 as anyOf; status is narrowed to 301 | 302 | 307 | 308 and the schema is closed",
  "media.upload":
    "its 200 is now anyOf, not oneOf: the continuing branch (after events.relay) carries _events alongside the item or list result, a ctx.done() branch does not -- narrow with '_events' in res, not res._events. Its output gains path, and drops key/checksum/status. a declared type that is not exactly one type/subtype (a list such as 'image/png, text/html', or an empty type) is refused with 415, and only its lower-cased type/subtype is stored (plus a text/* type's charset), so allowedTypes/deniedTypes match it without parameters and a parameterised type that passed a denylist is refused. The stored name's extension comes from the stored type: a listed type keeps its own, any other type -- and an SVG that sanitize.svg did not clean in the same pipeline -- is stored as '<name>.bin' and published as application/octet-stream",
  "media.get": "its output gains path (the item's one public URL, <publicPath>/<id>/<name>); key, checksum and status are gone",
  "media.list": "its items gain path and drop key/checksum/status; an anonymous caller without ids now answers 401",
  "media.update": "its output gains path and drops key/checksum/status",
  "media.listFolders": "an anonymous caller now answers 401 (unless anonymousList is \"all\")",
  "media.remove": "a failed blob delete now fails the step with the blob store's error, instead of being logged and ignored",
  "media.removeFolder": "a failed blob delete now fails the step; its result gains ids; run images.removeMany before it, not after",
  "media.renameFolder": "renames metadata only; no blob moves and no path changes",
  "images.attach": "gains available (false while a size still lacks a variant path, and such a size lists no path); no row is ever in state planned in an output; an attached variant carries its final width/height and path in every state",
  "images.serve": "answers the size's current file and every file a format change or a prune retired, never 404 for either; a size that never rendered, or whose render failed for good, answers with the original's bytes and type instead of 404; any other file is 404",
  "images.prune": "a pruned size's old path keeps answering with the original's bytes and type until the item is deleted, instead of 404 right away",
  "images.generate": "renders for ready media items only, and a variant row can be in state planned before it is called; it answers 404 for an item that is not ready (still uploading, failed, or being deleted), where it answered 200 with no variants",
  "images.retryFailed": "answers 404 for an item that is not ready (still uploading, failed, or being deleted)",
  "images.sync": "job.total counts the ready items that get variants, and done/failed count the same items, not every media item",
  "images.readStatus": "job.total counts the ready items that get variants, and done/failed count the same items, not every media item",
  "media.reconcile": "counts a key as orphaned only when it has the module's own <prefix><id>/<name> shape and no item has that id: a file directly under prefix, deeper than <id>/<name> or under an existing item's id is no longer reported, and never deleted",
  "media.reconcileDelete": "counts a key as orphaned only when it has the module's own <prefix><id>/<name> shape and no item has that id: a file directly under prefix, deeper than <id>/<name> or under an existing item's id is no longer reported, and never deleted",
  "insights.readManifest": "its output schema follows Manifest's two new fields, atomicScope and warnings, and a step description's new narrows (the shape of a narrowed answer and the member paths each audience keeps)",
  "events.listDead": "its items now carry pipeline and runId, and rows are no longer ordered across pipelines",
};

/** `responses/breaking-step-shapes`: flags a pipeline running one of a handful of steps whose 6.0.0 response or manifest shape differs from 5.8's. */
export const breakingStepShapesRule: Rule = {
  id: "responses/breaking-step-shapes",
  check(ctx) {
    const findings: Finding[] = [];
    for (const def of ctx.project.input.pipelines) {
      for (const step of pipelineSteps(def.steps)) {
        const bareName = step.split(":")[0]!;
        const change = STEP_SHAPE_CHANGES[bareName];
        if (change === undefined) continue;
        findings.push(infoFinding(`responses/breaking-step-shapes:${def.name}:${bareName}`, "responses/breaking-step-shapes", `pipeline "${def.name}" runs "${bareName}", whose shape changed in 6.0.0: ${change}`, "update any client or test reading the old shape", { pipeline: def.name, step: bareName }, upgradingDocs("responses-breaking-step-shapes")));
      }
    }
    return findings;
  },
};

/** `steps/ctx-done-terminal-output`: a local module calling `ctx.done()` needs `terminalOutput` on that step's `describe()` entry now; boot cannot detect a missing one. */
export const ctxDoneTerminalOutputRule: Rule = {
  id: "steps/ctx-done-terminal-output",
  check(ctx) {
    const findings: Finding[] = [];
    for (const [moduleName, file] of localModuleFiles(ctx)) {
      const source = ctx.readFile(file);
      if (source === undefined || !source.includes("ctx.done(")) continue;
      findings.push(infoFinding(`steps/ctx-done-terminal-output:${moduleName}`, "steps/ctx-done-terminal-output", `module "${moduleName}" calls ctx.done(); a step that ends the run this way without declaring terminalOutput now fails that run in every mode, one whose early result does not match its terminalOutput fails under validateOutput, and boot cannot see either by itself`, "add terminalOutput (the same schema as output when the early result has that shape) to every step that calls ctx.done()", { file, module: moduleName }, upgradingDocs("steps-ctx-done-terminal-output")));
    }
    return findings;
  },
};

/** `tests/run-pipeline-validates`: `testing/runPipeline` now always validates `ctx.result` against the folded output schema. */
export const runPipelineValidatesRule: Rule = {
  id: "tests/run-pipeline-validates",
  check(ctx) {
    const findings: Finding[] = [];
    for (const [, file] of ctx.project.moduleFiles) {
      const source = ctx.readFile(file);
      if (source !== undefined && /testing\/runPipeline/.test(source)) {
        findings.push(infoFinding(`tests/run-pipeline-validates:${file}`, "tests/run-pipeline-validates", "testing/runPipeline always validates ctx.result against the folded output schema now", "run your tests; one that produced an undeclared shape now fails", { file }, upgradingDocs("tests-run-pipeline-validates")));
      }
    }
    return findings;
  },
};

/** `runtime/restore-freshness`: `replication-sqlite`/`backup-blobstore` now fail boot when the database file was created during this boot while a restore point exists, if `restoreOnStart` is on (the default). */
export const restoreFreshnessRule: Rule = {
  id: "runtime/restore-freshness",
  check(ctx) {
    const findings: Finding[] = [];
    for (const token of ["replication-sqlite", "backup-blobstore"]) {
      const entry = moduleEntry(ctx, token);
      if (entry === undefined) continue;
      const restoreOnStart = isRecord(entry.config) && entry.config.restoreOnStart === false ? false : true;
      if (!restoreOnStart) continue;
      findings.push(infoFinding(`runtime/restore-freshness:${token}`, "runtime/restore-freshness", `${entry.use} fails boot now when the database file was created during this boot while a restore point exists (restoreOnStart is on)`, "deploy so the database file already exists before the first 6.0.0 boot, or set restoreOnStart: false where that is not wanted", { module: entry.use }, upgradingDocs("runtime-restore-freshness")));
    }
    return findings;
  },
};

/** `delivery/dependents`: a `delivery-static` project that publishes on events but does not mark dependent outputs refreshes a page only when that page itself is saved. */
export const deliveryDependentsRule: Rule = {
  id: "delivery/dependents",
  check(ctx) {
    const entry = moduleEntry(ctx, "delivery-static");
    if (entry === undefined) return [];
    const { config, pipelines } = ctx.project.input;
    const stepsOf = new Map(pipelines.map((p) => [p.name, pipelineSteps(p.steps)]));
    const runs = (pipeline: string, step: string): boolean => (stepsOf.get(pipeline) ?? []).some((s) => s === step || s.startsWith(`${step}:`));
    const eventTriggers = config.triggers.flatMap((t) => ("event" in t ? [t] : []));
    if (!eventTriggers.some((t) => runs(t.pipeline, "delivery.publish"))) return [];
    const missing: string[] = [];
    if (!pipelines.some((p) => runs(p.name, "delivery.markDependents"))) missing.push("no pipeline runs delivery.markDependents:<type>, so a page is re-rendered only when it is saved itself, not when the settings, a referenced document or a linked page change");
    if (!config.triggers.some((t) => "cron" in t && runs(t.pipeline, "delivery.resumeStale"))) missing.push("no cron runs delivery.resumeStale, the recovery pass for re-renders a stopped process left behind");
    const dependencies = isRecord(entry.config) && isRecord(entry.config.dependencies) ? entry.config.dependencies : {};
    if (dependencies.render === "events" && !eventTriggers.some((t) => t.event === "delivery.outputStale" && runs(t.pipeline, "delivery.republishOutput"))) missing.push('dependencies.render is "events" but no trigger runs delivery.republishOutput on delivery.outputStale, which fails boot');
    if (missing.length === 0) return [];
    return [infoFinding("delivery/dependents", "delivery/dependents", `delivery-static publishes on events, but ${missing.join("; ")}`, "add dependents pipelines (delivery.markDependents:<type>) on the change events of pages, settings, media and every collection a page shows, and a resumeStale cron; with render \"events\", also the job triggers on delivery.outputStale, delivery.indexesStale and, with llms.full, delivery.llmsStale", { file: ctx.project.configFile }, upgradingDocs("delivery-dependents"))];
  },
};

/** `http/trusted-proxies`: forwarding headers now count only from `http.trustedProxies`, which defaults to loopback, so a proxy on another address makes every request look like it came from the proxy. */
export const trustedProxiesRule: Rule = {
  id: "http/trusted-proxies",
  check(ctx) {
    const http: unknown = ctx.project.input.config.http;
    if (!isRecord(http) || http.trustedProxies !== undefined) return [];
    const policy = http.trustProxy === true ? "http.trustProxy" : typeof http.trustedHeader === "string" ? "http.trustedHeader" : undefined;
    if (policy === undefined) return [];
    return [infoFinding("http/trusted-proxies", "http/trusted-proxies", `${policy} is set without http.trustedProxies; forwarding headers now count only from a peer in trustedProxies, which defaults to loopback, so a proxy connecting from any other address is ignored and every request is attributed to the proxy`, "if the proxy does not connect over loopback, list its address or network in http.trustedProxies; a warning in the log names each peer whose forwarding headers were ignored", { file: ctx.project.configFile }, upgradingDocs("http-trusted-proxies"))];
  },
};

export const INFO_RULES: readonly Rule[] = [deliveryMembersRule, busHandlerThrowsRule, busSubscriberQueueRule, typeSignaturesRule, breakingStepShapesRule, ctxDoneTerminalOutputRule, runPipelineValidatesRule, restoreFreshnessRule, deliveryDependentsRule, trustedProxiesRule];
