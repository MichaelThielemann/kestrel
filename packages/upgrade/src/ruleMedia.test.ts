import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BootCheck, PipelineDefinition } from "@michaelthielemann/kestrel";
import { applyEdits } from "./apply.ts";
import type { InternalRuleContext } from "./cli-run.ts";
import type { LoadedProject, MediaWiring, RuleContext } from "./plugin.ts";
import { upgradingDocs } from "./ruleHelpers.ts";
import { readFileOrUndefined } from "./rules.ts";
import {
  anonymousMediaListRule,
  authzAnonymousFloorRule,
  binaryCacheControlRule,
  deliveryMediaRule,
  imagesMediaOptionRule,
  imagesPlanRule,
  imagesRenderTimeoutRule,
  imagesResumeCronRule,
  imagesVariantsChangedRule,
  mediaDeleteOrderRule,
  mediaPublicPathRule,
  mediaRepairRule,
  mediaServeRule,
  referencesMediaTargetRule,
  removedExportRule,
} from "./ruleMedia.ts";

interface ModuleSpec {
  use: string;
  config?: Record<string, unknown>;
  defaults?: { from: string; values: Record<string, unknown> };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-media-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function bootCheck(): BootCheck {
  return { errors: [], warnings: [], notChecked: [] };
}

async function project(
  modules: ModuleSpec[],
  extra: { pipelines?: PipelineDefinition[]; triggers?: unknown[]; moduleFiles?: Record<string, string>; withPipelinesDir?: boolean } = {},
): Promise<LoadedProject> {
  const configFile = join(dir, "kestrel.config.ts");
  const modulesText = modules.map((m) => `{ use: "${m.use}", config: ${JSON.stringify(m.config ?? {})}${m.defaults === undefined ? "" : `, defaults: ${JSON.stringify(m.defaults)}`} }`).join(", ");
  await writeFile(configFile, `export default defineConfig({ modules: [${modulesText}], triggers: ${JSON.stringify(extra.triggers ?? [])} });\n`);
  const pipelineFiles = extra.withPipelinesDir === true ? [{ file: join(dir, "pipelines", "existing.ts"), pipelines: ["existing"] }] : [];
  return {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    input: { config: { modules, triggers: (extra.triggers ?? []) as never }, modules: [], pipelines: extra.pipelines ?? [] },
    kind: "backend",
    configFile,
    moduleFiles: new Map(Object.entries(extra.moduleFiles ?? {})),
    pipelineFiles,
  };
}

function contextFor(p: LoadedProject): RuleContext {
  return { root: dir, scratch: dir, project: p, bootCheck: bootCheck(), readFile: readFileOrUndefined, answers: new Map() };
}

function contextWithWiring(p: LoadedProject, wiring: MediaWiring): InternalRuleContext {
  return { ...contextFor(p), hostMediaWiring: wiring };
}

const DELIVERY = "@michaelthielemann/kestrel-delivery-static";
const MEDIA_DEFAULT = "@michaelthielemann/kestrel-media-default";
const IMAGES_DEFAULT = "@michaelthielemann/kestrel-images-default";
const AUTHZ_ROLES = "@michaelthielemann/kestrel-authz-roles";
const REFERENCES = "@michaelthielemann/kestrel-references-default";

function applied(p: LoadedProject, edits: Parameters<typeof applyEdits>[1]): string {
  return applyEdits(readFileOrUndefined(p.configFile)!, edits).text;
}

describe("modules/delivery-media", () => {
  it("does not fire without an old media option", async () => {
    const p = await project([{ use: DELIVERY, config: { prefix: "site/" } }]);
    expect(await deliveryMediaRule.check(contextFor(p))).toEqual([]);
  });

  it("removes media, adds publicCopy on media-default and images-default, and reservedPaths on delivery-static", async () => {
    const p = await project([
      { use: DELIVERY, config: { prefix: "site/", media: { publicPath: "/media" } } },
      { use: MEDIA_DEFAULT, config: { prefix: "media/" } },
      { use: IMAGES_DEFAULT, config: {} },
    ]);
    const findings = await deliveryMediaRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("auto");
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const source = readFileOrUndefined(p.configFile)!;
    const { text } = applyEdits(source, edits);
    expect(text).not.toContain("media:");
    expect(text).toContain('kestrel-delivery-static", config: {"prefix":"site/",reservedPaths: ["/media"]}');
    expect(text).toContain('kestrel-media-default", config: {"prefix":"media/", publicCopy: { prefix: "site/" }}');
    expect(text).toContain('kestrel-images-default", config: {publicCopy: { prefix: "site/" }}');
  });

  it("carries a non-default publicPath over to both media modules", async () => {
    const p = await project([
      { use: DELIVERY, config: { prefix: "site/", media: { publicPath: "/gallery" } } },
      { use: MEDIA_DEFAULT, config: {} },
      { use: IMAGES_DEFAULT, config: {} },
    ]);
    const findings = await deliveryMediaRule.check(contextFor(p));
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const source = readFileOrUndefined(p.configFile)!;
    const { text } = applyEdits(source, edits);
    expect(text).toContain('reservedPaths: ["/gallery"]');
    expect(text).toContain('publicPath: "/gallery"');
  });

  it("normalises a trailing slash on the old media.publicPath", async () => {
    const p = await project([
      { use: DELIVERY, config: { media: { publicPath: "/gallery/" } } },
      { use: MEDIA_DEFAULT, config: {} },
    ]);
    const findings = await deliveryMediaRule.check(contextFor(p));
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const source = readFileOrUndefined(p.configFile)!;
    const { text } = applyEdits(source, edits);
    expect(text).toContain('reservedPaths: ["/gallery"]');
  });

  it("goes manual, never guessing a path, when the old media.publicPath nests under a reserved API or admin mount", async () => {
    const p = await project([
      { use: DELIVERY, config: { prefix: "site/", media: { publicPath: "/api/media" } } },
      { use: MEDIA_DEFAULT, config: {} },
      { use: IMAGES_DEFAULT, config: {} },
    ]);
    const findings = await deliveryMediaRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).not.toBe("auto");
    expect(findings[0]?.suggestion).toContain("reserve for their own API or admin UI");
    expect(findings[0]?.suggestion).not.toContain('reservedPaths: ["/api/media"]');
    expect(findings[0]?.suggestion).not.toContain('publicPath: "/api/media"');
    expect(findings[0]?.suggestion).toContain("cannot see where your project mounts its API");
  });

  it("goes manual for a bare /admin publicPath the same way", async () => {
    const p = await project([
      { use: DELIVERY, config: { media: { publicPath: "/admin" } } },
      { use: MEDIA_DEFAULT, config: {} },
    ]);
    const findings = await deliveryMediaRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).not.toBe("auto");
  });

  it("falls back to manual, naming the missing part, when reservedPaths already has entries", async () => {
    const p = await project([
      { use: DELIVERY, config: { media: { publicPath: "/media" }, reservedPaths: ["/admin"] } },
      { use: MEDIA_DEFAULT, config: {} },
    ]);
    const findings = await deliveryMediaRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).not.toBe("auto");
    expect(findings[0]?.suggestion).toContain("reservedPaths");
  });

  it("reads media from the entry's host-supplied defaults", async () => {
    const p = await project([
      { use: DELIVERY, config: {}, defaults: { from: "site-preset", values: { media: { publicPath: "/media" } } } },
      { use: MEDIA_DEFAULT, config: {} },
    ]);
    const findings = await deliveryMediaRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("modules/delivery-media");
  });

  it("keeps host-supplied reservedPaths: goes manual instead of writing an array that would replace them", async () => {
    const p = await project([
      { use: DELIVERY, config: { media: { publicPath: "/media" } }, defaults: { from: "site-preset", values: { reservedPaths: ["/admin"] } } },
      { use: MEDIA_DEFAULT, config: {} },
    ]);
    const findings = await deliveryMediaRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).not.toBe("auto");
    expect(findings[0]?.suggestion).toContain("reservedPaths");
  });

  it("only removes media when host-supplied reservedPaths already hold the public path", async () => {
    const p = await project([
      { use: DELIVERY, config: { media: { publicPath: "/media" } }, defaults: { from: "site-preset", values: { reservedPaths: ["/admin", "/media"] } } },
      { use: MEDIA_DEFAULT, config: {} },
    ]);
    const findings = await deliveryMediaRule.check(contextFor(p));
    expect(findings[0]?.fix.kind).toBe("auto");
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const text = applied(p, edits);
    expect(text).not.toContain('"media":');
    expect(text).not.toContain("reservedPaths: [");
    expect(text).toContain('"reservedPaths":["/admin","/media"]');
  });

  it("with host wiring, goes manual on delivery-static when host-supplied reservedPaths lack the wiring's paths", async () => {
    const wiring: MediaWiring = { publicPath: "/media", copyPrefix: "site/", reservedPaths: ["/api/media"] };
    const p = await project([
      { use: DELIVERY, config: { media: { publicPath: "/media" } }, defaults: { from: "site-preset", values: { reservedPaths: ["/admin"] } } },
      { use: MEDIA_DEFAULT, config: {} },
    ]);
    const findings = await deliveryMediaRule.check(contextWithWiring(p, wiring));
    const delivery = findings.find((f) => f.where.module === DELIVERY);
    expect(delivery?.fix.kind).not.toBe("auto");
  });

  it("stays manual when media-default is not configured at all", async () => {
    const p = await project([{ use: DELIVERY, config: { media: { publicPath: "/media" } } }]);
    const findings = await deliveryMediaRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).not.toBe("auto");
    expect(findings[0]?.suggestion).toContain("media-default");
  });

  it("with a host mediaWiring hook, auto-fixes even under a reserved mount, one finding per module entry", async () => {
    const p = await project([
      { use: DELIVERY, config: { prefix: "site/", media: { publicPath: "/api/media" } } },
      { use: MEDIA_DEFAULT, config: {} },
      { use: IMAGES_DEFAULT, config: {} },
    ]);
    const wiring: MediaWiring = { publicPath: "/media", copyPrefix: "site/", reservedPaths: ["/api/media"] };
    const findings = await deliveryMediaRule.check(contextWithWiring(p, wiring));
    expect(findings.map((f) => f.id)).toEqual([`modules/delivery-media:${DELIVERY}`, `modules/delivery-media:${MEDIA_DEFAULT}`, `modules/delivery-media:${IMAGES_DEFAULT}`]);
    expect(findings.every((f) => f.rule === "modules/delivery-media")).toBe(true);
    expect(findings.every((f) => f.fix.kind === "auto")).toBe(true);
    const edits = findings.flatMap((f) => (f.fix.kind === "auto" ? f.fix.edits : []));
    const source = readFileOrUndefined(p.configFile)!;
    const { text } = applyEdits(source, edits);
    expect(text).not.toContain("media:");
    expect(text).toContain('kestrel-delivery-static", config: {"prefix":"site/",reservedPaths: ["/api/media"]}');
    expect(text).toContain('kestrel-media-default", config: {publicCopy: { prefix: "site/" }, publicPath: "/media"}');
    expect(text).toContain('kestrel-images-default", config: {publicCopy: { prefix: "site/" }, publicPath: "/media"}');
  });

  it("with a host mediaWiring hook, skips a module entry whose config already matches it", async () => {
    const p = await project([
      { use: DELIVERY, config: { prefix: "site/", media: { publicPath: "/media" } } },
      { use: MEDIA_DEFAULT, config: { publicPath: "/media", publicCopy: { prefix: "site/" } } },
      { use: IMAGES_DEFAULT, config: {} },
    ]);
    const wiring: MediaWiring = { publicPath: "/media", copyPrefix: "site/", reservedPaths: ["/media"] };
    const findings = await deliveryMediaRule.check(contextWithWiring(p, wiring));
    expect(findings.map((f) => f.id)).toEqual([`modules/delivery-media:${DELIVERY}`, `modules/delivery-media:${IMAGES_DEFAULT}`]);
  });

  it("with a host mediaWiring hook, removes the media option outright once reservedPaths already covers it", async () => {
    const p = await project([
      { use: DELIVERY, config: { prefix: "site/", media: { publicPath: "/media" }, reservedPaths: ["/media"] } },
      { use: MEDIA_DEFAULT, config: {} },
    ]);
    const wiring: MediaWiring = { publicPath: "/media", copyPrefix: "site/", reservedPaths: ["/media"] };
    const findings = await deliveryMediaRule.check(contextWithWiring(p, wiring));
    const deliveryFinding = findings.find((f) => f.id === `modules/delivery-media:${DELIVERY}`);
    expect(deliveryFinding?.fix.kind).toBe("auto");
    const edits = deliveryFinding?.fix.kind === "auto" ? deliveryFinding.fix.edits : [];
    const source = readFileOrUndefined(p.configFile)!;
    const { text } = applyEdits(source, edits);
    expect(text).not.toContain("media:");
    expect(text).toContain('"reservedPaths":["/media"]');
  });
});

describe("modules/media-public-path", () => {
  it("does not fire when both publicPaths already match", async () => {
    const p = await project([
      { use: MEDIA_DEFAULT, config: { publicPath: "/api" } },
      { use: IMAGES_DEFAULT, config: { publicPath: "/api" } },
    ]);
    expect(await mediaPublicPathRule.check(contextFor(p))).toEqual([]);
  });

  it("sets images-default's publicPath to match media-default's", async () => {
    const p = await project([
      { use: MEDIA_DEFAULT, config: { publicPath: "/api" } },
      { use: IMAGES_DEFAULT, config: { publicPath: "/media" } },
    ]);
    const findings = await mediaPublicPathRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.fix.kind).toBe("auto");
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const source = readFileOrUndefined(p.configFile)!;
    const { text } = applyEdits(source, edits);
    expect(text).toContain('kestrel-images-default", config: {"publicPath":"/api"}');
  });

  it("fires on a trailing slash a 5.x regex allowed, even when the paths otherwise agree", async () => {
    const p = await project([
      { use: MEDIA_DEFAULT, config: { publicPath: "/api" } },
      { use: IMAGES_DEFAULT, config: { publicPath: "/api/" } },
    ]);
    const findings = await mediaPublicPathRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
  });
});

describe("runtime/authz-anonymous-floor", () => {
  it("does not fire without authz-roles configured", async () => {
    const p = await project([]);
    expect(await authzAnonymousFloorRule.check(contextFor(p))).toEqual([]);
  });

  it("does not fire when anonymous is empty", async () => {
    const p = await project([{ use: AUTHZ_ROLES, config: { anonymous: [] } }]);
    expect(await authzAnonymousFloorRule.check(contextFor(p))).toEqual([]);
  });

  it("reports the anonymous grants once anonymous is non-empty", async () => {
    const p = await project([{ use: AUTHZ_ROLES, config: { anonymous: ["media.read"] } }]);
    const findings = await authzAnonymousFloorRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("info");
    expect(findings[0]?.message).toContain("media.read");
  });
});

describe("imports/removed-export", () => {
  it("does not fire for a module that does not import the removed exports", async () => {
    const file = join(dir, "custom.ts");
    await writeFile(file, 'export default defineModule({ name: "custom/module" });\n');
    const p = await project([], { moduleFiles: { "custom/module": file } });
    expect(await removedExportRule.check(contextFor(p))).toEqual([]);
  });

  it("reports an import of a removed export from delivery-static/impl", async () => {
    const file = join(dir, "custom.ts");
    await writeFile(file, 'import { rewriteMedia } from "@michaelthielemann/kestrel-delivery-static/impl";\nexport default defineModule({ name: "custom/module" });\n');
    const p = await project([], { moduleFiles: { "custom/module": file } });
    const findings = await removedExportRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("manual");
    expect(findings[0]?.message).toContain("rewriteMedia");
  });

  it("reports a migrateKeys call regardless of where it was imported from", async () => {
    const file = join(dir, "custom.ts");
    await writeFile(file, 'import { migrateKeys } from "./legacy.ts";\nmigrateKeys();\nexport default defineModule({ name: "custom/module" });\n');
    const p = await project([], { moduleFiles: { "custom/module": file } });
    const findings = await removedExportRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("migrateKeys");
  });
});

describe("pipelines/media-serve", () => {
  it("does not fire without publicCopy configured anywhere", async () => {
    const p = await project([{ use: MEDIA_DEFAULT, config: {} }]);
    expect(await mediaServeRule.check(contextFor(p))).toEqual([]);
  });

  it("fires when media-default's publicCopy is set and no pipeline runs media.serve", async () => {
    const p = await project([{ use: MEDIA_DEFAULT, config: { publicCopy: { prefix: "site/" } } }]);
    const findings = await mediaServeRule.check(contextFor(p));
    const missing = findings.find((f) => f.id.endsWith(":missing"));
    expect(missing?.message).toContain("media.serve");
    expect(missing?.fix.kind).toBe("manual");
  });

  it("does not fire the missing-pipeline finding once a pipeline runs it", async () => {
    const p = await project([{ use: MEDIA_DEFAULT, config: { publicCopy: { prefix: "site/" } } }], { pipelines: [{ name: "serveMediaFile", steps: ["authn.identifyUser", "authz.require:media.read", "media.serve"] }] });
    const findings = await mediaServeRule.check(contextFor(p));
    expect(findings.some((f) => f.id.endsWith(":missing"))).toBe(false);
  });

  it("also fires for images-default's publicCopy, independently of media-default's", async () => {
    const p = await project([{ use: IMAGES_DEFAULT, config: { publicCopy: { prefix: "site/" } } }]);
    const findings = await mediaServeRule.check(contextFor(p));
    const missing = findings.find((f) => f.id.endsWith(":missing"));
    expect(missing?.message).toContain("images.serve");
  });

  it("fires as soon as delivery-static's old media option is present, even before it is migrated", async () => {
    const p = await project([{ use: DELIVERY, config: { media: { publicPath: "/media" } } }, { use: MEDIA_DEFAULT, config: {} }]);
    const findings = await mediaServeRule.check(contextFor(p));
    const missing = findings.find((f) => f.id.endsWith(":missing"));
    expect(missing?.message).toContain("media.serve");
  });

  it("names both missing steps in one finding when neither pipeline exists", async () => {
    const p = await project([
      { use: MEDIA_DEFAULT, config: { publicCopy: { prefix: "site/" } } },
      { use: IMAGES_DEFAULT, config: { publicCopy: { prefix: "site/" } } },
    ]);
    const findings = await mediaServeRule.check(contextFor(p));
    const missing = findings.filter((f) => f.id.endsWith(":missing"));
    expect(missing).toHaveLength(1);
    expect(missing[0]?.message).toContain("media.serve");
    expect(missing[0]?.message).toContain("images.serve");
  });

  it("auto-fixes by creating both pipeline files and both HTTP triggers in one edit set, when the project has a pipelines directory", async () => {
    const p = await project(
      [
        { use: MEDIA_DEFAULT, config: { publicPath: "/media", publicCopy: { prefix: "site/" } } },
        { use: IMAGES_DEFAULT, config: { publicCopy: { prefix: "site/" } } },
      ],
      { triggers: [{ http: "GET /me", pipeline: "me" }], withPipelinesDir: true },
    );
    const findings = await mediaServeRule.check(contextFor(p));
    const missing = findings.find((f) => f.id.endsWith(":missing"));
    expect(missing?.fix.kind).toBe("auto");
    const edits = missing!.fix.kind === "auto" ? missing!.fix.edits : [];
    const byFile = new Map(edits.map((e) => [e.file, e]));
    const mediaFile = join(dir, "pipelines", "serveMediaFile.ts");
    const imagesFile = join(dir, "pipelines", "serveImageVariant.ts");
    expect(byFile.get(mediaFile)?.create).toBe(true);
    expect(byFile.get(mediaFile)?.text).toContain('"media.serve", "authz.fields:mediaFile?shape=file"');
    expect(byFile.get(imagesFile)?.create).toBe(true);
    expect(byFile.get(imagesFile)?.text).toContain('"images.serve", "authz.fields:mediaFile?shape=file"');
    const configEdit = edits.find((e) => e.file === p.configFile)!;
    const source = readFileOrUndefined(p.configFile)!;
    const { text } = applyEdits(source, [configEdit]);
    expect(text).toContain('{ http: "GET /media/:id/:name", pipeline: "serveMediaFile" }');
    expect(text).toContain('{ http: "GET /media/:id/variants/:file", pipeline: "serveImageVariant" }');
  });

  it("flags a missing anonymous media.read grant once a serve pipeline runs", async () => {
    const p = await project(
      [
        { use: MEDIA_DEFAULT, config: { publicCopy: { prefix: "site/" } } },
        { use: AUTHZ_ROLES, config: { anonymous: [] } },
      ],
      { pipelines: [{ name: "serveMediaFile", steps: ["authn.identifyUser", "authz.require:media.read", "media.serve"] }] },
    );
    const findings = await mediaServeRule.check(contextFor(p));
    expect(findings.some((f) => f.id.endsWith("anonymous-media-read"))).toBe(true);
  });

  it("does not flag the anonymous grant once media.read is granted", async () => {
    const p = await project(
      [
        { use: MEDIA_DEFAULT, config: { publicCopy: { prefix: "site/" } } },
        { use: AUTHZ_ROLES, config: { anonymous: ["media.read"] } },
      ],
      { pipelines: [{ name: "serveMediaFile", steps: ["authn.identifyUser", "authz.require:media.read", "media.serve"] }] },
    );
    const findings = await mediaServeRule.check(contextFor(p));
    expect(findings.some((f) => f.id.endsWith("anonymous-media-read"))).toBe(false);
  });
});

describe("pipelines/media-repair", () => {
  it("does not fire without publicCopy configured anywhere", async () => {
    const p = await project([{ use: MEDIA_DEFAULT, config: {} }]);
    expect(await mediaRepairRule.check(contextFor(p))).toEqual([]);
  });

  it("does not fire once a pipeline runs media.syncPublic or images.syncPublic", async () => {
    const p = await project([{ use: MEDIA_DEFAULT, config: { publicCopy: { prefix: "site/" } } }], { pipelines: [{ name: "syncPublicMedia", steps: ["media.syncPublic", "images.syncPublic"] }] });
    expect(await mediaRepairRule.check(contextFor(p))).toEqual([]);
  });

  it("fires manual, without a pipelines directory to scaffold into", async () => {
    const p = await project([{ use: MEDIA_DEFAULT, config: { publicCopy: { prefix: "site/" } } }]);
    const findings = await mediaRepairRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("manual");
    expect(findings[0]?.severity).toBe("info");
  });

  it("auto-fixes by creating both pipeline files and both triggers, when the project has a pipelines directory", async () => {
    const p = await project([{ use: MEDIA_DEFAULT, config: { publicCopy: { prefix: "site/" } } }], { triggers: [{ http: "GET /me", pipeline: "me" }], withPipelinesDir: true });
    const findings = await mediaRepairRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("auto");
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const byFile = new Map(edits.map((e) => [e.file, e]));
    expect(byFile.get(join(dir, "pipelines", "repairPublicMedia.ts"))?.text).toContain("authz.require:media.manage");
    expect(byFile.get(join(dir, "pipelines", "syncPublicMedia.ts"))?.text).toContain('"images.syncPublic"');
    const configEdit = edits.find((e) => e.file === p.configFile)!;
    const { text } = applyEdits(readFileOrUndefined(p.configFile)!, [configEdit]);
    expect(text).toContain('{ http: "POST /admin/media/repair-public", pipeline: "repairPublicMedia" }');
    expect(text).toContain('{ cron: "45 3 * * *", pipeline: "syncPublicMedia" }');
  });
});

describe("pipelines/images-resume-cron", () => {
  it("does not fire without images-default configured", async () => {
    const p = await project([]);
    expect(await imagesResumeCronRule.check(contextFor(p))).toEqual([]);
  });

  it("fires when no pipeline runs images.resume at all", async () => {
    const p = await project([{ use: IMAGES_DEFAULT, config: {} }]);
    const findings = await imagesResumeCronRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("no pipeline runs images.resume");
  });

  it("fires a different message when a pipeline runs it but has no cron trigger", async () => {
    const p = await project([{ use: IMAGES_DEFAULT, config: {} }], { pipelines: [{ name: "resumeImages", steps: ["images.resume"] }], triggers: [{ http: "POST /admin/images/retry-failed", pipeline: "resumeImages" }] });
    const findings = await imagesResumeCronRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("no cron trigger");
  });

  it("does not fire once a cron-triggered pipeline runs images.resume", async () => {
    const p = await project([{ use: IMAGES_DEFAULT, config: {} }], { pipelines: [{ name: "resumeImages", steps: ["images.resume"] }], triggers: [{ cron: "*/5 * * * *", pipeline: "resumeImages" }] });
    expect(await imagesResumeCronRule.check(contextFor(p))).toEqual([]);
  });
});

describe("pipelines/media-delete-order", () => {
  async function pipelineFile(name: string, steps: string[]): Promise<{ file: string; pipelines: string[] }> {
    const file = join(dir, `${name}.ts`);
    await writeFile(file, `definePipeline({ name: "${name}", steps: ${JSON.stringify(steps)} });\n`);
    return { file, pipelines: [name] };
  }

  it("does not fire for a correctly-ordered pipeline", async () => {
    const pf = await pipelineFile("deleteMedia", ["media.remove", "images.remove", "events.emit:media.deleted"]);
    const p = { ...(await project([], { pipelines: [{ name: "deleteMedia", steps: ["media.remove", "images.remove", "events.emit:media.deleted"] }] })), pipelineFiles: [pf] };
    expect(await mediaDeleteOrderRule.check(contextFor(p))).toEqual([]);
  });

  it("auto-fixes the order when images.remove runs before media.remove", async () => {
    const pf = await pipelineFile("deleteMedia", ["images.remove", "media.remove"]);
    const p = { ...(await project([], { pipelines: [{ name: "deleteMedia", steps: ["images.remove", "media.remove"] }] })), pipelineFiles: [pf] };
    const findings = await mediaDeleteOrderRule.check(contextFor(p));
    const order = findings.find((f) => f.id.includes("images.remove") && !f.id.endsWith(":emit"));
    expect(order?.fix.kind).toBe("auto");
    const edits = order!.fix.kind === "auto" ? order!.fix.edits : [];
    const source = readFileOrUndefined(pf.file)!;
    const { text } = applyEdits(source, edits);
    expect(text).toContain('"media.remove","images.remove"');
  });

  it("auto-fixes images.removeMany/media.removeFolder the same way", async () => {
    const pf = await pipelineFile("deleteMediaFolder", ["images.removeMany", "media.removeFolder", "events.emit:media.deleted"]);
    const p = { ...(await project([], { pipelines: [{ name: "deleteMediaFolder", steps: ["images.removeMany", "media.removeFolder", "events.emit:media.deleted"] }] })), pipelineFiles: [pf] };
    const findings = await mediaDeleteOrderRule.check(contextFor(p));
    const order = findings.find((f) => f.id.includes("images.removeMany"));
    expect(order?.fix.kind).toBe("auto");
    const edits = order!.fix.kind === "auto" ? order!.fix.edits : [];
    const { text } = applyEdits(readFileOrUndefined(pf.file)!, edits);
    expect(text).toContain('"media.removeFolder","images.removeMany"');
  });

  it("auto-fixes images.removeMany/media.purge the same way and accepts the purge in front of it", async () => {
    const steps = ["media.selectTrash", "references.dropReferenced:media", "images.removeMany", "media.purge", "events.emit:media.deleted"];
    const pf = await pipelineFile("purgeMedia", steps);
    const p = { ...(await project([], { pipelines: [{ name: "purgeMedia", steps }] })), pipelineFiles: [pf] };
    const findings = await mediaDeleteOrderRule.check(contextFor(p));
    expect(findings.map((f) => f.id)).toEqual(["pipelines/media-delete-order:purgeMedia:images.removeMany"]);
    const order = findings[0]!;
    expect(order.message).toContain("runs images.removeMany before media.purge");
    expect(order.fix.kind).toBe("auto");
    const edits = order.fix.kind === "auto" ? order.fix.edits : [];
    const { text } = applyEdits(readFileOrUndefined(pf.file)!, edits);
    expect(text).toContain('"media.purge","images.removeMany"');

    const fixed = ["media.selectExpiredTrash", "references.dropReferenced:media", "media.purge", "images.removeMany", "events.emit:media.deleted"];
    const ordered = await project([], { pipelines: [{ name: "purgeExpiredMedia", steps: fixed }] });
    expect(await mediaDeleteOrderRule.check(contextFor(ordered))).toEqual([]);
  });

  it("falls back to manual when the pipeline's file cannot be read", async () => {
    const p = await project([], { pipelines: [{ name: "deleteMedia", steps: ["images.remove", "media.remove"] }] });
    const findings = await mediaDeleteOrderRule.check(contextFor(p));
    const order = findings.find((f) => f.id.includes("images.remove"));
    expect(order?.fix.kind).toBe("manual");
  });

  it("reports media.removeFolder without events.emit:media.deleted afterwards", async () => {
    const pf = await pipelineFile("deleteMediaFolder", ["media.removeFolder", "images.removeMany"]);
    const p = { ...(await project([], { pipelines: [{ name: "deleteMediaFolder", steps: ["media.removeFolder", "images.removeMany"] }] })), pipelineFiles: [pf] };
    const findings = await mediaDeleteOrderRule.check(contextFor(p));
    const emitFinding = findings.find((f) => f.id.endsWith(":emit"));
    expect(emitFinding).toBeDefined();
    expect(emitFinding?.severity).toBe("info");
  });
});

describe("runtime/anonymous-media-list", () => {
  it("does not fire without authz-roles granting anonymous media.read", async () => {
    const p = await project([{ use: MEDIA_DEFAULT, config: {} }]);
    expect(await anonymousMediaListRule.check(contextFor(p))).toEqual([]);
  });

  it("does not fire without media-default configured", async () => {
    const p = await project([{ use: AUTHZ_ROLES, config: { anonymous: ["media.read"] } }]);
    expect(await anonymousMediaListRule.check(contextFor(p))).toEqual([]);
  });

  it("does not fire once anonymousList is set to all", async () => {
    const p = await project([
      { use: MEDIA_DEFAULT, config: { anonymousList: "all" } },
      { use: AUTHZ_ROLES, config: { anonymous: ["media.read"] } },
    ]);
    expect(await anonymousMediaListRule.check(contextFor(p))).toEqual([]);
  });

  it("fires when anonymous grants media.read but anonymousList stays the ids default", async () => {
    const p = await project([
      { use: MEDIA_DEFAULT, config: {} },
      { use: AUTHZ_ROLES, config: { anonymous: ["media.read"] } },
    ]);
    const findings = await anonymousMediaListRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("info");
  });
});

describe("responses/binary-cache-control", () => {
  it("does not fire for a module that never mentions cache-control", async () => {
    const file = join(dir, "custom.ts");
    await writeFile(file, 'export default defineModule({ name: "custom/module" });\n');
    const p = await project([], { moduleFiles: { "custom/module": file } });
    expect(await binaryCacheControlRule.check(contextFor(p))).toEqual([]);
  });

  it("fires info once a module mentions cache-control on its own binary result", async () => {
    const file = join(dir, "custom.ts");
    await writeFile(file, 'export function serve() { return { binary: true, data, contentType, headers: { "cache-control": "public, max-age=60" } }; }\n');
    const p = await project([], { moduleFiles: { "custom/module": file } });
    const findings = await binaryCacheControlRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("info");
  });

  it("never fires for an installed package's own file, reached through a pnpm-style node_modules layout", async () => {
    const file = join(dir, "node_modules", ".pnpm", "@michaelthielemann+kestrel-delivery-static@6.0.0", "node_modules", "@michaelthielemann", "kestrel-delivery-static", "dist", "index.js");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, 'exports.serve = function serve() { return { binary: true, headers: { "cache-control": "public, max-age=60" } }; };\n');
    const p = await project([], { moduleFiles: { "@michaelthielemann/kestrel-delivery-static": file } });
    expect(await binaryCacheControlRule.check(contextFor(p))).toEqual([]);
  });
});

describe("pipelines/images-plan", () => {
  it("does not fire without images-default configured", async () => {
    const p = await project([], { pipelines: [{ name: "generateImageVariants", steps: ["images.plan"] }] });
    expect(await imagesPlanRule.check(contextFor(p))).toEqual([]);
  });

  it("does not fire for a pipeline that never calls images.plan", async () => {
    const p = await project([{ use: IMAGES_DEFAULT, config: {} }], { pipelines: [{ name: "generateImageVariants", steps: ["images.generate"] }] });
    expect(await imagesPlanRule.check(contextFor(p))).toEqual([]);
  });

  it("reports (manual, warning) a pipeline that calls images.plan directly", async () => {
    const p = await project([{ use: IMAGES_DEFAULT, config: {} }], { pipelines: [{ name: "planImageVariants", steps: ["images.plan"] }] });
    const findings = await imagesPlanRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).toBe("manual");
    expect(findings[0]?.severity).toBe("warning");
  });

  it("stays quiet for a queue-mode split already correctly composed: a plan-only pipeline and a separate generate pipeline triggered on images.planned", async () => {
    const p = await project([{ use: IMAGES_DEFAULT, config: {} }], {
      pipelines: [
        { name: "planImageVariants", steps: ["images.plan"] },
        { name: "generateImageVariants", steps: ["images.generate"] },
      ],
      triggers: [{ event: "media.uploaded", pipeline: "planImageVariants" }, { event: "images.planned", pipeline: "generateImageVariants" }],
    });
    expect(await imagesPlanRule.check(contextFor(p))).toEqual([]);
  });

  it("still fires when images.plan and images.generate sit in the same pipeline, even with an images.planned trigger elsewhere", async () => {
    const p = await project([{ use: IMAGES_DEFAULT, config: {} }], {
      pipelines: [
        { name: "planAndGenerate", steps: ["images.plan", "images.generate"] },
        { name: "otherOnPlanned", steps: ["images.generate"] },
      ],
      triggers: [{ event: "images.planned", pipeline: "otherOnPlanned" }],
    });
    const findings = await imagesPlanRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.where.pipeline).toBe("planAndGenerate");
  });

  it("still fires for a lone images.plan with no images.planned-triggered pipeline generating anything", async () => {
    const p = await project([{ use: IMAGES_DEFAULT, config: {} }], {
      pipelines: [{ name: "planImageVariants", steps: ["images.plan"] }],
      triggers: [{ event: "media.uploaded", pipeline: "planImageVariants" }],
    });
    const findings = await imagesPlanRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
  });
});

describe("modules/images-media-option", () => {
  it("does not fire without images-default, or without its media option", async () => {
    expect(await imagesMediaOptionRule.check(contextFor(await project([{ use: MEDIA_DEFAULT, config: {} }])))).toEqual([]);
    expect(await imagesMediaOptionRule.check(contextFor(await project([{ use: IMAGES_DEFAULT, config: { publicCopy: { prefix: "site/" } } }])))).toEqual([]);
  });

  it("removes the option with an auto fix, an error since the config fails boot", async () => {
    const p = await project([
      { use: MEDIA_DEFAULT, config: {} },
      { use: IMAGES_DEFAULT, config: { chunk: 10, media: { collection: "media_items" }, publicCopy: { prefix: "site/" } } },
    ]);
    const findings = await imagesMediaOptionRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "modules/images-media-option", severity: "error", where: { module: IMAGES_DEFAULT, path: "media" }, docs: upgradingDocs("modules-images-media-option") });
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const text = applied(p, edits);
    expect(text).toContain('kestrel-images-default", config: {"chunk":10,"publicCopy":{"prefix":"site/"}}');
    expect(text).not.toContain("media_items");
  });

  it("still removes a custom collection, as a warning that the store behind it must provide media@1", async () => {
    const p = await project([{ use: IMAGES_DEFAULT, config: { media: { collection: "asset_rows" } } }]);
    const findings = await imagesMediaOptionRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.fix.kind).toBe("auto");
    expect(findings[0]?.suggestion).toContain("provides media@1");
    expect(findings[0]?.message).toContain("asset_rows");
  });
});

describe("modules/images-render-timeout", () => {
  it("does not fire without images-default, with the defaults, or with renderTimeoutMs below staleAfterMs", async () => {
    expect(await imagesRenderTimeoutRule.check(contextFor(await project([{ use: MEDIA_DEFAULT, config: {} }])))).toEqual([]);
    expect(await imagesRenderTimeoutRule.check(contextFor(await project([{ use: IMAGES_DEFAULT, config: {} }])))).toEqual([]);
    expect(await imagesRenderTimeoutRule.check(contextFor(await project([{ use: IMAGES_DEFAULT, config: { staleAfterMs: 20000, renderTimeoutMs: 10000 } }])))).toEqual([]);
    expect(await imagesRenderTimeoutRule.check(contextFor(await project([{ use: IMAGES_DEFAULT, config: { staleAfterMs: 120000 } }])))).toEqual([]);
  });

  it("reports a staleAfterMs at or below the default renderTimeoutMs, which fails config validation", async () => {
    const findings = await imagesRenderTimeoutRule.check(contextFor(await project([{ use: IMAGES_DEFAULT, config: { staleAfterMs: 20000 } }])));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "modules/images-render-timeout", severity: "error", tier: "source", where: { module: IMAGES_DEFAULT, path: "staleAfterMs" }, fix: { kind: "manual" }, docs: upgradingDocs("modules-images-render-timeout") });
    expect(findings[0]?.message).toContain("renderTimeoutMs (30000, the default)");
    expect(findings[0]?.message).toContain("staleAfterMs (20000)");
    expect(findings[0]?.message).toContain("renderTimeoutMs must be less than staleAfterMs");
    expect(findings[0]?.suggestion).toContain("raise staleAfterMs above 30000");
    expect(findings[0]?.suggestion).toContain("lower renderTimeoutMs below 20000");
  });

  it("reports a renderTimeoutMs at or above the default staleAfterMs", async () => {
    const findings = await imagesRenderTimeoutRule.check(contextFor(await project([{ use: IMAGES_DEFAULT, config: { renderTimeoutMs: 60000 } }])));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ where: { module: IMAGES_DEFAULT, path: "renderTimeoutMs" } });
    expect(findings[0]?.message).toContain("staleAfterMs (60000, the default)");
  });

  it("leaves values it cannot read as numbers to config validation", async () => {
    expect(await imagesRenderTimeoutRule.check(contextFor(await project([{ use: IMAGES_DEFAULT, config: { staleAfterMs: "20000" } }])))).toEqual([]);
  });

  it("names the module of the boot error it explains, so that error is not listed again", async () => {
    const reason = "invalid config: renderTimeoutMs: renderTimeoutMs must be less than staleAfterMs";
    const ctx = { ...contextFor(await project([{ use: IMAGES_DEFAULT, config: { staleAfterMs: 20000 } }])), bootCheck: { ...bootCheck(), errors: [{ code: "invalid-module-config" as const, owner: "images/default", module: "images/default", reason }] } };
    const findings = await imagesRenderTimeoutRule.check(ctx);
    expect(findings[0]?.where).toEqual({ module: "images/default", path: "staleAfterMs" });
  });

  it("leaves a boot error that names another config issue too to the boot tier", async () => {
    const reason = "invalid config: renderTimeoutMs: renderTimeoutMs must be less than staleAfterMs; chunk: Expected number, received string";
    const ctx = { ...contextFor(await project([{ use: IMAGES_DEFAULT, config: { staleAfterMs: 20000, chunk: "5" } }])), bootCheck: { ...bootCheck(), errors: [{ code: "invalid-module-config" as const, owner: "images/default", module: "images/default", reason }] } };
    const findings = await imagesRenderTimeoutRule.check(ctx);
    expect(findings[0]?.where).toEqual({ module: IMAGES_DEFAULT, path: "staleAfterMs" });
  });
});

describe("modules/references-media-target", () => {
  it("does not fire without references-default, or for a content target", async () => {
    expect(await referencesMediaTargetRule.check(contextFor(await project([{ use: MEDIA_DEFAULT, config: {} }])))).toEqual([]);
    const p = await project([{ use: MEDIA_DEFAULT, config: {} }, { use: REFERENCES, config: { targets: { pages: { content: "pages" }, media: { media: true } } } }]);
    expect(await referencesMediaTargetRule.check(contextFor(p))).toEqual([]);
  });

  it("turns a target on media-default's collection into { media: true } with an auto fix", async () => {
    const p = await project([
      { use: MEDIA_DEFAULT, config: {} },
      { use: REFERENCES, config: { targets: { pages: { content: "pages" }, media: { collection: "media_items" } } } },
    ]);
    const findings = await referencesMediaTargetRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "modules/references-media-target", severity: "warning", where: { module: REFERENCES, path: "targets.media" }, docs: upgradingDocs("modules-references-media-target") });
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    expect(applied(p, edits)).toContain('"targets":{"pages":{"content":"pages"},"media":{ media: true }}');
  });

  it("leaves the media_items target alone without media-default, which would provide media@1", async () => {
    const p = await project([{ use: REFERENCES, config: { targets: { media: { collection: "media_items" } } } }]);
    expect(await referencesMediaTargetRule.check(contextFor(p))).toEqual([]);
  });

  it("notes a target on any other collection: it must be the project's own", async () => {
    const p = await project([{ use: MEDIA_DEFAULT, config: {} }, { use: REFERENCES, config: { targets: { products: { collection: "shop_products" } } } }]);
    const findings = await referencesMediaTargetRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("info");
    expect(findings[0]?.message).toContain("shop_products");
  });
});

describe("events/images-variants-changed", () => {
  it("does not fire without images-default, or when the pipeline also listens to images.variantsChanged", async () => {
    const triggers = [{ event: "media.updated", pipeline: "mediaDependents" }];
    expect(await imagesVariantsChangedRule.check(contextFor(await project([{ use: MEDIA_DEFAULT, config: {} }], { triggers })))).toEqual([]);
    const both = [...triggers, { event: "images.variantsChanged", pipeline: "mediaDependents" }];
    expect(await imagesVariantsChangedRule.check(contextFor(await project([{ use: IMAGES_DEFAULT, config: {} }], { triggers: both })))).toEqual([]);
  });

  it("notes each pipeline on media.updated that does not also listen to images.variantsChanged", async () => {
    const triggers = [
      { event: "media.updated", pipeline: "mediaDependents" },
      { event: "media.updated", pipeline: "auditMedia" },
      { event: "images.variantsChanged", pipeline: "auditMedia" },
    ];
    const findings = await imagesVariantsChangedRule.check(contextFor(await project([{ use: IMAGES_DEFAULT, config: {} }], { triggers })));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "events/images-variants-changed", severity: "info", where: { pipeline: "mediaDependents" }, docs: upgradingDocs("events-images-variants-changed") });
    expect(findings[0]?.suggestion).toContain('{ event: "images.variantsChanged", pipeline: "mediaDependents" }');
    expect(findings[0]?.message).toContain("a re-crop rendered, the focus changed");
    expect(findings[0]?.message).toContain("any render that gave a variant a new ?v= (a changed size or format, a repair by images.resume, images.retryFailed, a size registered again after a prune)");
  });
});
