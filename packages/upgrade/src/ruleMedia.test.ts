import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BootCheck, PipelineDefinition } from "@michaelthielemann/kestrel";
import { applyEdits } from "./apply.ts";
import type { LoadedProject, RuleContext } from "./plugin.ts";
import { upgradingDocs } from "./ruleHelpers.ts";
import { readFileOrUndefined } from "./rules.ts";
import {
  anonymousMediaListRule,
  authzAnonymousFloorRule,
  binaryCacheControlRule,
  deliveryMediaRule,
  imagesMediaOptionRule,
  imagesPlanRule,
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
  const modulesText = modules.map((m) => `{ use: "${m.use}", config: ${JSON.stringify(m.config ?? {})} }`).join(", ");
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
      { use: DELIVERY, config: { prefix: "site/", media: { publicPath: "/api" } } },
      { use: MEDIA_DEFAULT, config: {} },
      { use: IMAGES_DEFAULT, config: {} },
    ]);
    const findings = await deliveryMediaRule.check(contextFor(p));
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const source = readFileOrUndefined(p.configFile)!;
    const { text } = applyEdits(source, edits);
    expect(text).toContain('reservedPaths: ["/api"]');
    expect(text).toContain('publicPath: "/api"');
  });

  it("normalises a trailing slash on the old media.publicPath", async () => {
    const p = await project([
      { use: DELIVERY, config: { media: { publicPath: "/api/" } } },
      { use: MEDIA_DEFAULT, config: {} },
    ]);
    const findings = await deliveryMediaRule.check(contextFor(p));
    const edits = findings[0]!.fix.kind === "auto" ? findings[0]!.fix.edits : [];
    const source = readFileOrUndefined(p.configFile)!;
    const { text } = applyEdits(source, edits);
    expect(text).toContain('reservedPaths: ["/api"]');
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

  it("stays manual when media-default is not configured at all", async () => {
    const p = await project([{ use: DELIVERY, config: { media: { publicPath: "/media" } } }]);
    const findings = await deliveryMediaRule.check(contextFor(p));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fix.kind).not.toBe("auto");
    expect(findings[0]?.suggestion).toContain("media-default");
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
  });
});
