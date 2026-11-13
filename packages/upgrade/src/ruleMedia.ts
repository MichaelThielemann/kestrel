import { dirname, join } from "node:path";
import { pipelineSteps } from "@michaelthielemann/kestrel/definePipeline";
import type { InternalRuleContext } from "./cli-run.ts";
import { createPipelineFile, insertTriggers, removeModuleConfigProperty, replaceModuleConfigProperty, replaceModuleConfigValue, setModuleConfigProperties, swapPipelineSteps } from "./edits.ts";
import { isRecord } from "./guards.ts";
import type { MediaWiring, Rule, RuleContext } from "./plugin.ts";
import type { Edit, Finding } from "./report.ts";
import { combineEditParts, finding, fileForPipeline, hasModule, infoFinding, localModuleFiles, moduleEntry, pipelinesTriggeredBy, upgradingDocs } from "./ruleHelpers.ts";

function normalizePublicPath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function stringConfig(config: unknown, key: string): string | undefined {
  return isRecord(config) && typeof config[key] === "string" ? config[key] : undefined;
}

const RESERVED_MOUNT_SEGMENTS = new Set(["api", "admin"]);

function underReservedMount(path: string): boolean {
  const [, first] = path.split("/");
  return first !== undefined && RESERVED_MOUNT_SEGMENTS.has(first);
}

const DELIVERY_MEDIA_RULE_ID = "modules/delivery-media";

type ModuleListEntry = NonNullable<ReturnType<typeof moduleEntry>>;

function mediaWiringFindings(ctx: RuleContext, delivery: ModuleListEntry, mediaDefault: ModuleListEntry | undefined, imagesDefault: ModuleListEntry | undefined, source: string | undefined, message: string, docs: string, wiring: MediaWiring): Finding[] {
  const findings: Finding[] = [];
  const reservedPathsText = `[${wiring.reservedPaths.map((p) => `"${p}"`).join(", ")}]`;
  const deliveryWhere = { module: delivery.use, path: "media" };
  const existingReserved = isRecord(delivery.config) && Array.isArray(delivery.config.reservedPaths) ? delivery.config.reservedPaths : [];
  const alreadyReserved = wiring.reservedPaths.every((p) => existingReserved.includes(p));
  const deliverySuggestion = `remove "media" from delivery-static, set reservedPaths: ${reservedPathsText}`;
  const deliveryEdit =
    source === undefined
      ? undefined
      : alreadyReserved
        ? removeModuleConfigProperty(ctx.project.configFile, source, { use: delivery.use, key: "media" })
        : existingReserved.length > 0
          ? undefined
          : replaceModuleConfigProperty(ctx.project.configFile, source, { use: delivery.use, fromKey: "media", toText: `reservedPaths: ${reservedPathsText}` });
  findings.push(finding(`${DELIVERY_MEDIA_RULE_ID}:${delivery.use}`, DELIVERY_MEDIA_RULE_ID, message, deliveryEdit === undefined ? `${deliverySuggestion} by hand` : deliverySuggestion, deliveryWhere, deliveryEdit === undefined ? undefined : [deliveryEdit], docs));

  for (const entry of [mediaDefault, imagesDefault]) {
    if (entry === undefined) continue;
    const currentPublicPath = stringConfig(entry.config, "publicPath");
    const currentPrefix = isRecord(entry.config) && isRecord(entry.config.publicCopy) ? stringConfig(entry.config.publicCopy, "prefix") : undefined;
    if (currentPublicPath === wiring.publicPath && currentPrefix === wiring.copyPrefix) continue;
    const where = { module: entry.use, path: "publicPath" };
    const assignments: Record<string, string> = { publicCopy: `{ prefix: "${wiring.copyPrefix}" }` };
    if (currentPublicPath !== wiring.publicPath) assignments.publicPath = `"${wiring.publicPath}"`;
    const suggestion = `set publicPath: "${wiring.publicPath}" and publicCopy: { prefix: "${wiring.copyPrefix}" }`;
    const edits = source === undefined ? undefined : setModuleConfigProperties(ctx.project.configFile, source, { use: entry.use, assignments });
    findings.push(finding(`${DELIVERY_MEDIA_RULE_ID}:${entry.use}`, DELIVERY_MEDIA_RULE_ID, message, edits === undefined ? `${suggestion} by hand` : suggestion, where, edits, docs));
  }

  return findings;
}

/** `modules/delivery-media`: delivery-static's old `media` option is removed; media-default/images-default's `publicCopy` replaces the rewriting it did. */
export const deliveryMediaRule: Rule = {
  id: DELIVERY_MEDIA_RULE_ID,
  check(untypedCtx) {
    const ctx = untypedCtx as InternalRuleContext;
    const delivery = moduleEntry(ctx, "delivery-static");
    if (delivery === undefined || !isRecord(delivery.config) || !isRecord(delivery.config.media)) return [];
    const message = 'delivery-static\'s "media" option is removed in 6.0.0; media-default and images-default\'s publicCopy replace the URL rewriting and copying it did';
    const docs = upgradingDocs("modules-delivery-media");

    if (ctx.hostMediaWiring !== undefined) {
      const source = ctx.readFile(ctx.project.configFile);
      return mediaWiringFindings(ctx, delivery, moduleEntry(ctx, "media-default"), moduleEntry(ctx, "images-default"), source, message, docs, ctx.hostMediaWiring);
    }

    const rawPublicPath = stringConfig(delivery.config.media, "publicPath") ?? "/media";
    const publicPath = normalizePublicPath(rawPublicPath);
    const deliveryPrefix = stringConfig(delivery.config, "prefix") ?? "";
    const where = { module: delivery.use, path: "media" };

    if (underReservedMount(publicPath)) {
      const suggestion = `the old media.publicPath ("${publicPath}") lies under a path many projects reserve for their own API or admin UI; pick a publicPath outside your project's own mounts (commonly "/media"), add it to delivery-static's reservedPaths alongside your actual mounts, and set publicCopy: { prefix: "${deliveryPrefix}" } on media-default and images-default by hand — this assistant cannot see where your project mounts its API`;
      return [finding(DELIVERY_MEDIA_RULE_ID, DELIVERY_MEDIA_RULE_ID, message, suggestion, where, undefined, docs)];
    }

    const publicPathNote = publicPath === "/media" ? "" : `, and publicPath: "${publicPath}" on media-default and images-default`;
    const suggestion = `remove "media" from delivery-static, set publicCopy: { prefix: "${deliveryPrefix}" } on media-default and images-default, add reservedPaths: ["${publicPath}"] to delivery-static${publicPathNote}`;

    const mediaDefault = moduleEntry(ctx, "media-default");
    const source = ctx.readFile(ctx.project.configFile);
    if (source === undefined || mediaDefault === undefined) {
      return [finding(DELIVERY_MEDIA_RULE_ID, DELIVERY_MEDIA_RULE_ID, message, `${suggestion} by hand; could not locate media-default's module-list entry`, where, undefined, docs)];
    }

    const existingReserved = Array.isArray(delivery.config.reservedPaths) ? delivery.config.reservedPaths : [];
    const alreadyReserved = existingReserved.includes(publicPath);
    const mediaAndReservedPaths = alreadyReserved
      ? removeModuleConfigProperty(ctx.project.configFile, source, { use: delivery.use, key: "media" })
      : existingReserved.length > 0
        ? undefined
        : replaceModuleConfigProperty(ctx.project.configFile, source, { use: delivery.use, fromKey: "media", toText: `reservedPaths: ["${publicPath}"]` });

    const publicCopyAssignments: Record<string, string> = { publicCopy: `{ prefix: "${deliveryPrefix}" }` };
    if (publicPath !== "/media") publicCopyAssignments.publicPath = `"${publicPath}"`;
    const mediaDefaultEdits = setModuleConfigProperties(ctx.project.configFile, source, { use: mediaDefault.use, assignments: publicCopyAssignments });
    const imagesDefault = moduleEntry(ctx, "images-default");
    const imagesDefaultEdits = imagesDefault === undefined ? [] : setModuleConfigProperties(ctx.project.configFile, source, { use: imagesDefault.use, assignments: publicCopyAssignments });

    const { edits, missing } = combineEditParts({
      "delivery-static's media option and reservedPaths": mediaAndReservedPaths === undefined ? undefined : [mediaAndReservedPaths],
      "media-default's publicCopy/publicPath": mediaDefaultEdits,
      ...(imagesDefault === undefined ? {} : { "images-default's publicCopy/publicPath": imagesDefaultEdits }),
    });

    return [finding(DELIVERY_MEDIA_RULE_ID, DELIVERY_MEDIA_RULE_ID, message, missing.length > 0 ? `${suggestion} by hand; could not locate: ${missing.join(", ")}` : suggestion, where, edits, docs)];
  },
};

const MEDIA_PUBLIC_PATH_RULE_ID = "modules/media-public-path";

/** `modules/media-public-path`: images-default's `publicPath` must match media-default's, without a trailing slash a 5.x regex once allowed. */
export const mediaPublicPathRule: Rule = {
  id: MEDIA_PUBLIC_PATH_RULE_ID,
  check(ctx) {
    const mediaDefault = moduleEntry(ctx, "media-default");
    const imagesDefault = moduleEntry(ctx, "images-default");
    if (mediaDefault === undefined || imagesDefault === undefined) return [];
    const mediaPath = normalizePublicPath(stringConfig(mediaDefault.config, "publicPath") ?? "/media");
    const rawImagesPath = stringConfig(imagesDefault.config, "publicPath") ?? "/media";
    const imagesPath = normalizePublicPath(rawImagesPath);
    if (imagesPath === mediaPath && rawImagesPath === imagesPath) return [];

    const where = { module: imagesDefault.use, path: "publicPath" };
    const message = `images-default's publicPath ("${rawImagesPath}") does not match media-default's ("${mediaPath}"); a mismatch answers 404 for every image variant path`;
    const suggestion = `set images-default's publicPath to "${mediaPath}"`;
    const docs = upgradingDocs("modules-media-public-path");
    const source = ctx.readFile(ctx.project.configFile);
    if (source === undefined) return [finding(MEDIA_PUBLIC_PATH_RULE_ID, MEDIA_PUBLIC_PATH_RULE_ID, message, `${suggestion} by hand`, where, undefined, docs, "warning")];
    const edits = setModuleConfigProperties(ctx.project.configFile, source, { use: imagesDefault.use, assignments: { publicPath: `"${mediaPath}"` } });
    return [finding(MEDIA_PUBLIC_PATH_RULE_ID, MEDIA_PUBLIC_PATH_RULE_ID, message, edits === undefined ? `${suggestion} by hand` : suggestion, where, edits, docs, "warning")];
  },
};

const AUTHZ_ANONYMOUS_FLOOR_RULE_ID = "runtime/authz-anonymous-floor";

/** `runtime/authz-anonymous-floor`: `authz-roles` now also grants a signed-in caller whatever `anonymous` grants. */
export const authzAnonymousFloorRule: Rule = {
  id: AUTHZ_ANONYMOUS_FLOOR_RULE_ID,
  check(ctx) {
    const authz = moduleEntry(ctx, "authz-roles");
    if (authz === undefined || !isRecord(authz.config) || !Array.isArray(authz.config.anonymous)) return [];
    const anonymous = authz.config.anonymous.filter((p): p is string => typeof p === "string");
    if (anonymous.length === 0) return [];
    return [
      infoFinding(
        AUTHZ_ANONYMOUS_FLOOR_RULE_ID,
        AUTHZ_ANONYMOUS_FLOOR_RULE_ID,
        `authz-roles's anonymous grants (${anonymous.join(", ")}) are now also held by every signed-in caller, in authz.require, can and describePipelineAccess — a signed-in caller refused one of these before is served now`,
        "remove a permission from anonymous if a signed-in caller lacking it must still be refused",
        { module: authz.use },
        upgradingDocs("runtime-authz-anonymous-floor"),
      ),
    ];
  },
};

const REMOVED_EXPORT_RULE_ID = "imports/removed-export";
const REMOVED_EXPORTS = ["rewriteMedia", "MediaMatch", "MediaConfig", "contentTypeByExtension"];
const IMPORT_FROM_DELIVERY_STATIC_IMPL = /import\s*\{([^}]*)\}\s*from\s*["'][^"']*kestrel-delivery-static\/impl["']/g;

function removedExportsImported(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(IMPORT_FROM_DELIVERY_STATIC_IMPL)) {
    const names = match[1] ?? "";
    for (const name of REMOVED_EXPORTS) if (new RegExp(`\\b${name}\\b`).test(names)) found.add(name);
  }
  return [...found];
}

/** `imports/removed-export`: `rewriteMedia`, `MediaMatch`, `MediaConfig`, `contentTypeByExtension` are no longer exported from `kestrel-delivery-static/impl`, and `migrateKeys` no longer exists — custom code using any of them must be rewritten by hand. */
export const removedExportRule: Rule = {
  id: REMOVED_EXPORT_RULE_ID,
  check(ctx) {
    const findings: Finding[] = [];
    for (const [moduleName, file] of ctx.project.moduleFiles) {
      const source = ctx.readFile(file);
      if (source === undefined) continue;
      const names = removedExportsImported(source);
      if (names.length > 0) {
        findings.push(
          finding(
            `${REMOVED_EXPORT_RULE_ID}:${moduleName}`,
            REMOVED_EXPORT_RULE_ID,
            `module "${moduleName}" imports ${names.join(", ")} from kestrel-delivery-static/impl, removed in 6.0.0`,
            "rewrite this by hand: delivery-static no longer rewrites, copies or reads media; reach a media file through the API's own path (media.get/media.list's path field) and set publicCopy on the media modules for a static copy instead",
            { file, module: moduleName },
            undefined,
            upgradingDocs("imports-removed-export"),
          ),
        );
      }
      if (/\bmigrateKeys\s*\(/.test(source)) {
        findings.push(
          finding(
            `${REMOVED_EXPORT_RULE_ID}:${moduleName}:migrateKeys`,
            REMOVED_EXPORT_RULE_ID,
            `module "${moduleName}" calls migrateKeys, removed in 6.0.0: the startup media key migration is gone`,
            "remove the call; a stored item's key not matching <prefix><id>/<name> now fails setup instead, naming the first such item",
            { file, module: moduleName },
            undefined,
            upgradingDocs("imports-removed-export"),
          ),
        );
      }
    }
    return findings;
  },
};

const MEDIA_SERVE_RULE_ID = "pipelines/media-serve";

function publicCopyConfigured(ctx: RuleContext, token: string): boolean {
  const entry = moduleEntry(ctx, token);
  return entry !== undefined && isRecord(entry.config) && isRecord(entry.config.publicCopy);
}

function deliveryStaticHasOldMedia(ctx: RuleContext): boolean {
  const entry = moduleEntry(ctx, "delivery-static");
  return entry !== undefined && isRecord(entry.config) && isRecord(entry.config.media);
}

function runsStep(ctx: RuleContext, step: string): boolean {
  return ctx.project.input.pipelines.some((def) => pipelineSteps(def.steps).some((s) => s.split(":")[0] === step));
}

function pipelinesRunning(ctx: RuleContext, step: string): string[] {
  return ctx.project.input.pipelines.filter((def) => pipelineSteps(def.steps).some((s) => s.split(":")[0] === step)).map((def) => def.name);
}

function anonymousGrants(ctx: RuleContext, permission: string): boolean {
  const authz = moduleEntry(ctx, "authz-roles");
  if (authz === undefined || !isRecord(authz.config) || !Array.isArray(authz.config.anonymous)) return false;
  return authz.config.anonymous.some((p) => p === permission || p === "*");
}

function expectedPublicPath(ctx: RuleContext): string {
  const mediaDefault = moduleEntry(ctx, "media-default");
  if (mediaDefault !== undefined) return normalizePublicPath(stringConfig(mediaDefault.config, "publicPath") ?? "/media");
  const delivery = moduleEntry(ctx, "delivery-static");
  if (delivery !== undefined && isRecord(delivery.config) && isRecord(delivery.config.media)) return normalizePublicPath(stringConfig(delivery.config.media, "publicPath") ?? "/media");
  return "/media";
}

function pipelinesDirOf(ctx: RuleContext): string | undefined {
  const first = ctx.project.pipelineFiles[0]?.file;
  return first === undefined ? undefined : dirname(first);
}

/** `pipelines/media-serve`: `publicCopy` set on media-default or images-default (or about to be, once `modules/delivery-media` migrates the old option) needs a pipeline running `media.serve`/`images.serve`, and anonymous callers must be able to reach it. */
export const mediaServeRule: Rule = {
  id: MEDIA_SERVE_RULE_ID,
  check(ctx) {
    const findings: Finding[] = [];
    const migrating = deliveryStaticHasOldMedia(ctx);
    const mediaPublicCopy = publicCopyConfigured(ctx, "media-default") || migrating;
    const imagesPublicCopy = hasModule(ctx, "images-default") && (publicCopyConfigured(ctx, "images-default") || migrating);
    if (!mediaPublicCopy && !imagesPublicCopy) return [];

    const needsMediaServe = mediaPublicCopy && !runsStep(ctx, "media.serve");
    const needsImagesServe = imagesPublicCopy && !runsStep(ctx, "images.serve");
    const docs = upgradingDocs("pipelines-media-serve");
    if (needsMediaServe || needsImagesServe) {
      const publicPath = expectedPublicPath(ctx);
      const missingSteps = [needsMediaServe ? "media.serve" : undefined, needsImagesServe ? "images.serve" : undefined].filter((s): s is string => s !== undefined);
      const message = `no pipeline runs ${missingSteps.join(" or ")}; boot fails once publicCopy is set without a pipeline serving it`;
      const suggestionParts = [
        needsMediaServe ? `a serveMediaFile pipeline (steps: authn.identifyUser, authz.require:media.read, media.serve, authz.fields:mediaFile?shape=file) with an HTTP trigger GET ${publicPath}/:id/:name` : undefined,
        needsImagesServe ? `a serveImageVariant pipeline (steps: authn.identifyUser, authz.require:media.read, images.serve, authz.fields:mediaFile?shape=file) with an HTTP trigger GET ${publicPath}/:id/variants/:file` : undefined,
      ].filter((s): s is string => s !== undefined);
      const suggestion = `add ${suggestionParts.join(" and ")}`;
      const dir = pipelinesDirOf(ctx);
      const configSource = ctx.readFile(ctx.project.configFile);
      if (dir === undefined || configSource === undefined) {
        findings.push(finding(`${MEDIA_SERVE_RULE_ID}:missing`, MEDIA_SERVE_RULE_ID, message, `${suggestion} by hand`, {}, undefined, docs));
      } else {
        const parts: Record<string, Edit[] | undefined> = {};
        const triggers: string[] = [];
        if (needsMediaServe) {
          parts["serveMediaFile pipeline file"] = [createPipelineFile(join(dir, "serveMediaFile.ts"), { name: "serveMediaFile", steps: ["authn.identifyUser", "authz.require:media.read", "media.serve", "authz.fields:mediaFile?shape=file"] })];
          triggers.push(`{ http: "GET ${publicPath}/:id/:name", pipeline: "serveMediaFile" }`);
        }
        if (needsImagesServe) {
          parts["serveImageVariant pipeline file"] = [createPipelineFile(join(dir, "serveImageVariant.ts"), { name: "serveImageVariant", steps: ["authn.identifyUser", "authz.require:media.read", "images.serve", "authz.fields:mediaFile?shape=file"] })];
          triggers.push(`{ http: "GET ${publicPath}/:id/variants/:file", pipeline: "serveImageVariant" }`);
        }
        const triggerEdit = insertTriggers(ctx.project.configFile, configSource, triggers);
        parts["the HTTP trigger(s)"] = triggerEdit === undefined ? undefined : [triggerEdit];
        const { edits, missing } = combineEditParts(parts);
        findings.push(finding(`${MEDIA_SERVE_RULE_ID}:missing`, MEDIA_SERVE_RULE_ID, message, missing.length > 0 ? `${suggestion} by hand; could not locate: ${missing.join(", ")}` : suggestion, {}, edits, docs));
      }
    }
    if ((mediaPublicCopy || imagesPublicCopy) && hasModule(ctx, "authz-roles") && !anonymousGrants(ctx, "media.read")) {
      findings.push(
        finding(
          `${MEDIA_SERVE_RULE_ID}:anonymous-media-read`,
          MEDIA_SERVE_RULE_ID,
          "publicCopy is set, but authz-roles' anonymous grants do not include media.read; boot fails once the serve pipeline declares its output public",
          "grant media.read in authz-roles' anonymous, or drop publicCopy",
          {},
          undefined,
          docs,
        ),
      );
    }
    return findings;
  },
};

const MEDIA_REPAIR_RULE_ID = "pipelines/media-repair";

/** `pipelines/media-repair`: `publicCopy` needs a pipeline running `media.syncPublic`/`images.syncPublic`, or the public copy tree never repairs itself once it drifts from what is stored. */
export const mediaRepairRule: Rule = {
  id: MEDIA_REPAIR_RULE_ID,
  check(ctx) {
    const migrating = deliveryStaticHasOldMedia(ctx);
    const mediaPublicCopy = publicCopyConfigured(ctx, "media-default") || migrating;
    const imagesPublicCopy = hasModule(ctx, "images-default") && (publicCopyConfigured(ctx, "images-default") || migrating);
    if (!mediaPublicCopy && !imagesPublicCopy) return [];
    if (runsStep(ctx, "media.syncPublic") || runsStep(ctx, "images.syncPublic")) return [];

    const message = "publicCopy is set, but no pipeline runs media.syncPublic or images.syncPublic; the public copy tree drifts from what is stored without a repair pass";
    const suggestion =
      "add a repairPublicMedia pipeline (steps: authn.requireUser, authz.require:media.manage, media.syncPublic, images.syncPublic) behind an admin HTTP trigger, and a syncPublicMedia pipeline (steps: media.syncPublic, images.syncPublic) on a nightly cron trigger";
    const docs = upgradingDocs("pipelines-media-repair");
    const dir = pipelinesDirOf(ctx);
    const configSource = ctx.readFile(ctx.project.configFile);
    if (dir === undefined || configSource === undefined) {
      return [finding(MEDIA_REPAIR_RULE_ID, MEDIA_REPAIR_RULE_ID, message, `${suggestion} by hand`, {}, undefined, docs, "info")];
    }
    const triggerEdit = insertTriggers(ctx.project.configFile, configSource, [
      '{ http: "POST /admin/media/repair-public", pipeline: "repairPublicMedia" }',
      '{ cron: "45 3 * * *", pipeline: "syncPublicMedia" }',
    ]);
    const { edits, missing } = combineEditParts({
      "repairPublicMedia pipeline file": [createPipelineFile(join(dir, "repairPublicMedia.ts"), { name: "repairPublicMedia", steps: ["authn.requireUser", "authz.require:media.manage", "media.syncPublic", "images.syncPublic"] })],
      "syncPublicMedia pipeline file": [createPipelineFile(join(dir, "syncPublicMedia.ts"), { name: "syncPublicMedia", steps: ["media.syncPublic", "images.syncPublic"] })],
      "the HTTP and cron triggers": triggerEdit === undefined ? undefined : [triggerEdit],
    });
    return [finding(MEDIA_REPAIR_RULE_ID, MEDIA_REPAIR_RULE_ID, message, missing.length > 0 ? `${suggestion} by hand; could not locate: ${missing.join(", ")}` : suggestion, {}, edits, docs, "info")];
  },
};

const IMAGES_RESUME_CRON_RULE_ID = "pipelines/images-resume-cron";

/** `pipelines/images-resume-cron`: images-default's availability now depends on the background repair pass (`images.resume`) running on a schedule. */
export const imagesResumeCronRule: Rule = {
  id: IMAGES_RESUME_CRON_RULE_ID,
  check(ctx) {
    if (!hasModule(ctx, "images-default")) return [];
    const runners = pipelinesRunning(ctx, "images.resume");
    const cronPipelines = pipelinesTriggeredBy(ctx, "cron");
    if (runners.some((name) => cronPipelines.has(name))) return [];
    const message =
      runners.length === 0
        ? "images-default is configured, but no pipeline runs images.resume; availability now depends on the background repair pass for a failed placement, a missed plan or an idempotent re-upload"
        : `images-default is configured and ${runners.join(", ")} runs images.resume, but it has no cron trigger, so the repair pass never runs on a schedule`;
    return [
      finding(
        IMAGES_RESUME_CRON_RULE_ID,
        IMAGES_RESUME_CRON_RULE_ID,
        message,
        'add a resumeImages pipeline (steps: ["images.resume"]) on a cron trigger, e.g. { cron: "*/5 * * * *", pipeline: "resumeImages" }',
        {},
        undefined,
        upgradingDocs("pipelines-images-resume-cron"),
        "warning",
      ),
    ];
  },
};

const MEDIA_DELETE_ORDER_RULE_ID = "pipelines/media-delete-order";
const DELETE_ORDER_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["media.remove", "images.remove"],
  ["media.removeFolder", "images.removeMany"],
  ["media.purge", "images.removeMany"],
];

/** `pipelines/media-delete-order`: a delete must run before the images cleanup it triggers, or a render finishing in between leaves a public copy or a private blob behind; a folder delete should also raise `media.deleted` for a subscriber to react to. */
export const mediaDeleteOrderRule: Rule = {
  id: MEDIA_DELETE_ORDER_RULE_ID,
  check(ctx) {
    const findings: Finding[] = [];
    for (const def of ctx.project.input.pipelines) {
      const steps = pipelineSteps(def.steps);
      const base = steps.map((s) => s.split(":")[0]!);
      for (const [mediaStep, imagesStep] of DELETE_ORDER_PAIRS) {
        const mediaIndex = base.indexOf(mediaStep);
        const imagesIndex = base.indexOf(imagesStep);
        if (mediaIndex === -1 || imagesIndex === -1 || mediaIndex < imagesIndex) continue;
        const message = `pipeline "${def.name}" runs ${imagesStep} before ${mediaStep}; a render finishing after the delete can leave a public copy or a private blob behind`;
        const suggestion = `move ${mediaStep} before ${imagesStep}`;
        const docs = upgradingDocs("pipelines-media-delete-order");
        const file = fileForPipeline(ctx, def.name);
        const source = file === undefined ? undefined : ctx.readFile(file);
        if (file === undefined || source === undefined) {
          findings.push(finding(`${MEDIA_DELETE_ORDER_RULE_ID}:${def.name}:${imagesStep}`, MEDIA_DELETE_ORDER_RULE_ID, message, `${suggestion} by hand`, { pipeline: def.name }, undefined, docs, "warning"));
          continue;
        }
        const edits = swapPipelineSteps(file, source, { pipelineName: def.name, earlier: mediaStep, later: imagesStep });
        findings.push(finding(`${MEDIA_DELETE_ORDER_RULE_ID}:${def.name}:${imagesStep}`, MEDIA_DELETE_ORDER_RULE_ID, message, edits === undefined ? `${suggestion} by hand` : suggestion, { pipeline: def.name }, edits, docs, "warning"));
      }
      if (base.includes("media.removeFolder") && !steps.includes("events.emit:media.deleted")) {
        findings.push(
          infoFinding(
            `${MEDIA_DELETE_ORDER_RULE_ID}:${def.name}:emit`,
            MEDIA_DELETE_ORDER_RULE_ID,
            `pipeline "${def.name}" runs media.removeFolder without events.emit:media.deleted afterwards`,
            "add events.emit:media.deleted (and events.relay) after the removal, so a subscriber can react to the deleted ids",
            { pipeline: def.name },
            upgradingDocs("pipelines-media-delete-order"),
          ),
        );
      }
    }
    return findings;
  },
};

const ANONYMOUS_MEDIA_LIST_RULE_ID = "runtime/anonymous-media-list";

/** `runtime/anonymous-media-list`: an anonymous `media.read` grant no longer opens listing and folders — media-default's own `anonymousList: "all"` does that now. */
export const anonymousMediaListRule: Rule = {
  id: ANONYMOUS_MEDIA_LIST_RULE_ID,
  check(ctx) {
    if (!anonymousGrants(ctx, "media.read")) return [];
    const mediaDefault = moduleEntry(ctx, "media-default");
    if (mediaDefault === undefined) return [];
    const anonymousList = stringConfig(mediaDefault.config, "anonymousList") ?? "ids";
    if (anonymousList === "all") return [];
    return [
      infoFinding(
        ANONYMOUS_MEDIA_LIST_RULE_ID,
        ANONYMOUS_MEDIA_LIST_RULE_ID,
        'authz-roles grants anonymous media.read, but media-default\'s anonymousList is "ids" (the default): an anonymous caller can still only fetch media by explicit ids, not list or browse folders (401)',
        'set media-default\'s anonymousList to "all" to let anonymous callers list and browse folders too, or leave it as is if that is intended',
        { module: mediaDefault.use },
        upgradingDocs("runtime-anonymous-media-list"),
      ),
    ];
  },
};

const BINARY_CACHE_CONTROL_RULE_ID = "responses/binary-cache-control";

/** `responses/binary-cache-control`: 6.0.0 sends a binary step result's own `cache-control` header as given, where 5.x silently replaced it with `no-store`. */
export const binaryCacheControlRule: Rule = {
  id: BINARY_CACHE_CONTROL_RULE_ID,
  check(ctx) {
    const findings: Finding[] = [];
    for (const [moduleName, file] of localModuleFiles(ctx)) {
      const source = ctx.readFile(file);
      if (source === undefined || !/cache-control/i.test(source)) continue;
      findings.push(
        infoFinding(
          `${BINARY_CACHE_CONTROL_RULE_ID}:${moduleName}`,
          BINARY_CACHE_CONTROL_RULE_ID,
          `module "${moduleName}" mentions cache-control in its own code; a binary step result's own cache-control header used to be silently replaced with no-store, but 6.0.0 sends it as given`,
          "review any binary step result this module returns: a non-empty cache-control it sets is now honoured instead of being overridden",
          { file, module: moduleName },
          upgradingDocs("responses-binary-cache-control"),
        ),
      );
    }
    return findings;
  },
};

const IMAGES_PLAN_RULE_ID = "pipelines/images-plan";

/** `pipelines/images-plan`: a pipeline calling `images.plan` directly needs a by-hand review — the right replacement depends on the delivery mode and whether lane-based bulk pipelines are in use, which this tool cannot safely decide on its own. Silent once a pipeline already does only the planning half, and some pipeline triggered on `images.planned` does the generating half — the lane-based split its own suggestion recommends. */
export const imagesPlanRule: Rule = {
  id: IMAGES_PLAN_RULE_ID,
  check(ctx) {
    if (!hasModule(ctx, "images-default")) return [];
    const stepsOf = new Map(ctx.project.input.pipelines.map((p) => [p.name, pipelineSteps(p.steps)]));
    const plannedPipelines = new Set(ctx.project.input.config.triggers.flatMap((t) => ("event" in t && t.event === "images.planned" ? [t.pipeline] : [])));
    const isSplit = [...plannedPipelines].some((name) => (stepsOf.get(name) ?? []).some((s) => s.split(":")[0] === "images.generate"));

    const findings: Finding[] = [];
    for (const [name, steps] of stepsOf) {
      if (!steps.some((s) => s.split(":")[0] === "images.plan")) continue;
      if (isSplit && !steps.some((s) => s.split(":")[0] === "images.generate")) continue;
      findings.push(
        finding(
          `${IMAGES_PLAN_RULE_ID}:${name}`,
          IMAGES_PLAN_RULE_ID,
          `pipeline "${name}" calls images.plan directly`,
          "review by hand: with direct event delivery, images.generate now plans internally, so a standalone images.plan step can usually be removed; with queue delivery and lane-based bulk pipelines, split this into a main-lane planImageVariants and a generateImageVariants triggered on images.planned instead",
          { pipeline: name },
          undefined,
          upgradingDocs("pipelines-images-plan"),
          "warning",
        ),
      );
    }
    return findings;
  },
};

const IMAGES_MEDIA_OPTION_RULE_ID = "modules/images-media-option";
const MEDIA_COLLECTION = "media_items";

/** `modules/images-media-option`: images-default's `media` option (the collection it read media-default's rows from) is removed; it reads media only through `media@1` now. */
export const imagesMediaOptionRule: Rule = {
  id: IMAGES_MEDIA_OPTION_RULE_ID,
  check(ctx) {
    const images = moduleEntry(ctx, "images-default");
    if (images === undefined || !isRecord(images.config) || !("media" in images.config)) return [];
    const collection = isRecord(images.config.media) ? stringConfig(images.config.media, "collection") : undefined;
    const custom = collection !== undefined && collection !== MEDIA_COLLECTION;
    const where = { module: images.use, path: "media" };
    const message = custom
      ? `images-default's "media" option (collection "${collection}") is removed in 6.0.0; images-default reads media only through media@1 and fails boot while the option is set`
      : 'images-default\'s "media" option is removed in 6.0.0; images-default reads media only through media@1 (media-default provides it) and fails boot while the option is set';
    const suggestion = custom ? 'remove "media" from images-default; images-default reads media only through media@1 now, so make sure the module that owns that store provides media@1' : 'remove "media" from images-default';
    const docs = upgradingDocs("modules-images-media-option");
    const severity = custom ? "warning" : "error";
    const source = ctx.readFile(ctx.project.configFile);
    const edit = source === undefined ? undefined : removeModuleConfigProperty(ctx.project.configFile, source, { use: images.use, key: "media" });
    return [finding(IMAGES_MEDIA_OPTION_RULE_ID, IMAGES_MEDIA_OPTION_RULE_ID, message, edit === undefined ? `${suggestion} by hand` : suggestion, where, edit === undefined ? undefined : [edit], docs, severity)];
  },
};

const IMAGES_RENDER_TIMEOUT_RULE_ID = "modules/images-render-timeout";
const DEFAULT_STALE_AFTER_MS = 60000;
const DEFAULT_RENDER_TIMEOUT_MS = 30000;
const RENDER_TIMEOUT_ONLY_ISSUE = /^invalid config(?: \(with defaults from "[^"]*"\))?: renderTimeoutMs: renderTimeoutMs must be less than staleAfterMs$/;

/** `modules/images-render-timeout`: images-default's config requires `renderTimeoutMs` below `staleAfterMs` from 6.0.0 on, so a render ends before the item lease it renews runs out. When the boot check's config error for the module names only this issue, the finding carries that module's name and stands in for the error. */
export const imagesRenderTimeoutRule: Rule = {
  id: IMAGES_RENDER_TIMEOUT_RULE_ID,
  check(ctx) {
    const images = moduleEntry(ctx, "images-default");
    if (images === undefined) return [];
    const config = isRecord(images.config) ? images.config : {};
    const stale = config.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const timeout = config.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
    if (typeof stale !== "number" || typeof timeout !== "number" || timeout < stale) return [];
    const staleText = `staleAfterMs (${stale}${config.staleAfterMs === undefined ? ", the default" : ""})`;
    const timeoutText = `renderTimeoutMs (${timeout}${config.renderTimeoutMs === undefined ? ", the default" : ""})`;
    const message = `images-default's ${timeoutText} is not below its ${staleText}; from 6.0.0 on its config fails validation with "renderTimeoutMs must be less than staleAfterMs", since a render has to end before the lease on its media item runs out`;
    const suggestion = `raise staleAfterMs above ${timeout} or lower renderTimeoutMs below ${stale}`;
    const explained = ctx.bootCheck.errors.find((e) => e.code === "invalid-module-config" && e.module !== undefined && RENDER_TIMEOUT_ONLY_ISSUE.test(e.reason));
    const where = { module: explained?.module ?? images.use, path: config.renderTimeoutMs === undefined ? "staleAfterMs" : "renderTimeoutMs" };
    return [finding(IMAGES_RENDER_TIMEOUT_RULE_ID, IMAGES_RENDER_TIMEOUT_RULE_ID, message, suggestion, where, undefined, upgradingDocs("modules-images-render-timeout"))];
  },
};

const REFERENCES_MEDIA_TARGET_RULE_ID = "modules/references-media-target";

/** `modules/references-media-target`: a references-default target reading media-default's collection becomes `{ media: true }`, which reads the ready files through `media@1`; any other `{ collection }` target must name the project's own collection. */
export const referencesMediaTargetRule: Rule = {
  id: REFERENCES_MEDIA_TARGET_RULE_ID,
  check(ctx) {
    const references = moduleEntry(ctx, "references-default");
    if (references === undefined || !isRecord(references.config) || !isRecord(references.config.targets)) return [];
    const mediaProvided = hasModule(ctx, "media-default");
    const docs = upgradingDocs("modules-references-media-target");
    const source = ctx.readFile(ctx.project.configFile);
    const findings: Finding[] = [];
    for (const [name, target] of Object.entries(references.config.targets)) {
      const collection = isRecord(target) ? stringConfig(target, "collection") : undefined;
      if (collection === undefined) continue;
      const id = `${REFERENCES_MEDIA_TARGET_RULE_ID}:${name}`;
      const where = { module: references.use, path: `targets.${name}` };
      if (collection !== MEDIA_COLLECTION) {
        findings.push(infoFinding(id, REFERENCES_MEDIA_TARGET_RULE_ID, `references-default's target "${name}" reads the collection "${collection}" directly`, 'keep it only if the collection is the project\'s own; for another module\'s data, use a target that reads through that module\'s contract ({ content: "<type>" }, { media: true })', where, docs));
        continue;
      }
      if (!mediaProvided) continue;
      const message = `references-default's target "${name}" reads media-default's collection "${MEDIA_COLLECTION}" directly; { media: true } reads the ready files through media@1 instead, so an upload in flight or a file being deleted no longer counts as existing`;
      const suggestion = `set references-default's target "${name}" to { media: true }`;
      const edit = source === undefined ? undefined : replaceModuleConfigValue(ctx.project.configFile, source, { use: references.use, path: ["targets", name], toText: "{ media: true }" });
      findings.push(finding(id, REFERENCES_MEDIA_TARGET_RULE_ID, message, edit === undefined ? `${suggestion} by hand` : suggestion, where, edit === undefined ? undefined : [edit], docs, "warning"));
    }
    return findings;
  },
};

const IMAGES_VARIANTS_CHANGED_RULE_ID = "events/images-variants-changed";

/** `events/images-variants-changed`: images-default announces a changed variant set as its own event, `images.variantsChanged`, never as `media.updated`. */
export const imagesVariantsChangedRule: Rule = {
  id: IMAGES_VARIANTS_CHANGED_RULE_ID,
  check(ctx) {
    if (!hasModule(ctx, "images-default")) return [];
    const triggers = ctx.project.input.config.triggers.flatMap((t) => ("event" in t ? [t] : []));
    const onVariants = new Set(triggers.filter((t) => t.event === "images.variantsChanged").map((t) => t.pipeline));
    const pipelines = [...new Set(triggers.filter((t) => t.event === "media.updated" && !onVariants.has(t.pipeline)).map((t) => t.pipeline))];
    return pipelines.map((pipeline) =>
      infoFinding(
        `${IMAGES_VARIANTS_CHANGED_RULE_ID}:${pipeline}`,
        IMAGES_VARIANTS_CHANGED_RULE_ID,
        `pipeline "${pipeline}" runs on media.updated; images-default announces that an item's variants changed (placed, a size added or changed, a size pruned, a re-crop rendered, the focus changed, or any render that gave a variant a new ?v= (a changed size or format, a repair by images.resume, images.retryFailed, a size registered again after a prune)) as images.variantsChanged, never as media.updated`,
        `if "${pipeline}" should also react to variant changes (it re-renders pages that show media, for one), add the trigger { event: "images.variantsChanged", pipeline: "${pipeline}" }`,
        { pipeline },
        upgradingDocs("events-images-variants-changed"),
      ),
    );
  },
};

export const mediaRules: readonly Rule[] = [
  imagesMediaOptionRule,
  imagesRenderTimeoutRule,
  referencesMediaTargetRule,
  imagesVariantsChangedRule,
  deliveryMediaRule,
  mediaPublicPathRule,
  mediaServeRule,
  mediaRepairRule,
  imagesResumeCronRule,
  mediaDeleteOrderRule,
  anonymousMediaListRule,
  binaryCacheControlRule,
  imagesPlanRule,
  authzAnonymousFloorRule,
  removedExportRule,
];
