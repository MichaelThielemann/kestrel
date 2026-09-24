import { pipelineSteps } from "@michaelthielemann/kestrel/definePipeline";
import { removeModuleConfigProperty, replaceModuleConfigProperty, setModuleConfigProperties } from "./edits.ts";
import { isRecord } from "./guards.ts";
import type { Rule, RuleContext } from "./plugin.ts";
import type { Finding } from "./report.ts";
import { combineEditParts, finding, hasModule, infoFinding, moduleEntry } from "./ruleHelpers.ts";

function normalizePublicPath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function stringConfig(config: unknown, key: string): string | undefined {
  return isRecord(config) && typeof config[key] === "string" ? config[key] : undefined;
}

const DELIVERY_MEDIA_RULE_ID = "modules/delivery-media";

/** `modules/delivery-media`: delivery-static's old `media` option is removed; media-default/images-default's `publicCopy` replaces the rewriting it did. */
export const deliveryMediaRule: Rule = {
  id: DELIVERY_MEDIA_RULE_ID,
  check(ctx) {
    const delivery = moduleEntry(ctx, "delivery-static");
    if (delivery === undefined || !isRecord(delivery.config) || !isRecord(delivery.config.media)) return [];
    const rawPublicPath = stringConfig(delivery.config.media, "publicPath") ?? "/media";
    const publicPath = normalizePublicPath(rawPublicPath);
    const deliveryPrefix = stringConfig(delivery.config, "prefix") ?? "";
    const where = { module: delivery.use, path: "media" };
    const message = 'delivery-static\'s "media" option is removed in 6.0.0; media-default and images-default\'s publicCopy replace the URL rewriting and copying it did';
    const publicPathNote = publicPath === "/media" ? "" : `, and publicPath: "${publicPath}" on media-default and images-default`;
    const suggestion = `remove "media" from delivery-static, set publicCopy: { prefix: "${deliveryPrefix}" } on media-default and images-default, add reservedPaths: ["${publicPath}"] to delivery-static${publicPathNote}`;
    const docs = "docs/upgrading.md#modules-delivery-media";

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
    const docs = "docs/upgrading.md#modules-media-public-path";
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
        "docs/upgrading.md#runtime-authz-anonymous-floor",
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
            "docs/upgrading.md#imports-removed-export",
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
            "docs/upgrading.md#imports-removed-export",
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

function anonymousGrants(ctx: RuleContext, permission: string): boolean {
  const authz = moduleEntry(ctx, "authz-roles");
  if (authz === undefined || !isRecord(authz.config) || !Array.isArray(authz.config.anonymous)) return false;
  return authz.config.anonymous.some((p) => p === permission || p === "*");
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

    if (mediaPublicCopy && !runsStep(ctx, "media.serve")) {
      findings.push(
        finding(
          `${MEDIA_SERVE_RULE_ID}:media.serve`,
          MEDIA_SERVE_RULE_ID,
          "media-default's publicCopy is set (or will be, once delivery-static's old media option is migrated), but no pipeline runs media.serve; boot fails without one",
          'add a pipeline (e.g. serveMediaFile) with steps ["authn.identifyUser", "authz.require:media.read", "media.serve"] and an HTTP trigger GET <publicPath>/:id/:name',
          {},
          undefined,
          "docs/upgrading.md#pipelines-media-serve",
        ),
      );
    }
    if (imagesPublicCopy && !runsStep(ctx, "images.serve")) {
      findings.push(
        finding(
          `${MEDIA_SERVE_RULE_ID}:images.serve`,
          MEDIA_SERVE_RULE_ID,
          "images-default's publicCopy is set (or will be, once delivery-static's old media option is migrated), but no pipeline runs images.serve; boot fails without one",
          'add a pipeline (e.g. serveImageVariant) with steps ["authn.identifyUser", "authz.require:media.read", "images.serve"] and an HTTP trigger GET <publicPath>/:id/variants/:file',
          {},
          undefined,
          "docs/upgrading.md#pipelines-media-serve",
        ),
      );
    }
    if ((mediaPublicCopy || imagesPublicCopy) && hasModule(ctx, "authz-roles") && !anonymousGrants(ctx, "media.read")) {
      findings.push(
        finding(
          `${MEDIA_SERVE_RULE_ID}:anonymous-media-read`,
          MEDIA_SERVE_RULE_ID,
          "publicCopy is set, but authz-roles' anonymous grants do not include media.read; boot fails once the serve pipeline declares its output public",
          'grant media.read in authz-roles\' anonymous, or drop publicCopy',
          {},
          undefined,
          "docs/upgrading.md#pipelines-media-serve",
        ),
      );
    }
    return findings;
  },
};

export const mediaRules: readonly Rule[] = [deliveryMediaRule, mediaPublicPathRule, mediaServeRule, authzAnonymousFloorRule, removedExportRule];
