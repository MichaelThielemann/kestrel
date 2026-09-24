import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BootCheck, PipelineDefinition } from "@michaelthielemann/kestrel";
import { applyEdits } from "./apply.ts";
import type { LoadedProject, RuleContext } from "./plugin.ts";
import { readFileOrUndefined } from "./rules.ts";
import { authzAnonymousFloorRule, deliveryMediaRule, mediaPublicPathRule, mediaServeRule, removedExportRule } from "./ruleMedia.ts";

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

async function project(modules: ModuleSpec[], extra: { pipelines?: PipelineDefinition[]; triggers?: unknown[]; moduleFiles?: Record<string, string> } = {}): Promise<LoadedProject> {
  const configFile = join(dir, "kestrel.config.ts");
  const modulesText = modules.map((m) => `{ use: "${m.use}", config: ${JSON.stringify(m.config ?? {})} }`).join(", ");
  await writeFile(configFile, `export default defineConfig({ modules: [${modulesText}], triggers: ${JSON.stringify(extra.triggers ?? [])} });\n`);
  return {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    input: { config: { modules, triggers: (extra.triggers ?? []) as never }, modules: [], pipelines: extra.pipelines ?? [] },
    kind: "backend",
    configFile,
    moduleFiles: new Map(Object.entries(extra.moduleFiles ?? {})),
    pipelineFiles: [],
  };
}

function contextFor(p: LoadedProject): RuleContext {
  return { root: dir, scratch: dir, project: p, bootCheck: bootCheck(), readFile: readFileOrUndefined, answers: new Map(), ownsPackages: [] };
}

const DELIVERY = "@michaelthielemann/kestrel-delivery-static";
const MEDIA_DEFAULT = "@michaelthielemann/kestrel-media-default";
const IMAGES_DEFAULT = "@michaelthielemann/kestrel-images-default";
const AUTHZ_ROLES = "@michaelthielemann/kestrel-authz-roles";

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
    expect(findings.some((f) => f.id.endsWith("media.serve"))).toBe(true);
    expect(findings.find((f) => f.id.endsWith("media.serve"))?.fix.kind).toBe("manual");
  });

  it("does not fire the media.serve finding once a pipeline runs it", async () => {
    const p = await project([{ use: MEDIA_DEFAULT, config: { publicCopy: { prefix: "site/" } } }], { pipelines: [{ name: "serveMediaFile", steps: ["authn.identifyUser", "authz.require:media.read", "media.serve"] }] });
    const findings = await mediaServeRule.check(contextFor(p));
    expect(findings.some((f) => f.id.endsWith("media.serve"))).toBe(false);
  });

  it("also fires for images-default's publicCopy, independently of media-default's", async () => {
    const p = await project([{ use: IMAGES_DEFAULT, config: { publicCopy: { prefix: "site/" } } }]);
    const findings = await mediaServeRule.check(contextFor(p));
    expect(findings.some((f) => f.id.endsWith("images.serve"))).toBe(true);
  });

  it("fires as soon as delivery-static's old media option is present, even before it is migrated", async () => {
    const p = await project([{ use: DELIVERY, config: { media: { publicPath: "/media" } } }, { use: MEDIA_DEFAULT, config: {} }]);
    const findings = await mediaServeRule.check(contextFor(p));
    expect(findings.some((f) => f.id.endsWith("media.serve"))).toBe(true);
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
