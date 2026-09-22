import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { boot, defineModule, definePipeline, err, failure, KestrelBootError } from "@michaelthielemann/kestrel";
import { loadConfig, loadModules, loadPipelines } from "@michaelthielemann/kestrel/load";
import type { RevisionPage } from "@michaelthielemann/kestrel-contracts/revisions";
import type { PersistenceError } from "@michaelthielemann/kestrel-contracts/persistence";
import { STATUS as DELIVERY_STATUS_COLLECTION } from "@michaelthielemann/kestrel-delivery-static/impl";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { KestrelConfigInput } from "@michaelthielemann/kestrel/defineConfig";
import { pipelineSteps, type PipelineDefinition } from "@michaelthielemann/kestrel/definePipeline";
import type { Result } from "@michaelthielemann/kestrel/result";

const root = dirname(fileURLToPath(import.meta.url));

describe("static delivery media rewrite wiring", () => {
  it("configures the media publicPath for delivery-static", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    const delivery = boundaryCast<{ media?: { publicPath: string } }>(config.modules.find((m) => m.use === "@michaelthielemann/kestrel-delivery-static")!.config, "json");
    expect(delivery.media?.publicPath).toBe("/media");
  });
});

describe("site wiring", () => {
  it("declares site-default between content-default and delivery-static", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    const modules = config.modules.map((m) => m.use);
    expect(modules.indexOf("@michaelthielemann/kestrel-content-default")).toBeLessThan(modules.indexOf("@michaelthielemann/kestrel-site-default"));
    expect(modules.indexOf("@michaelthielemann/kestrel-site-default")).toBeLessThan(modules.indexOf("@michaelthielemann/kestrel-delivery-static"));
  });

  it("resolves the site path through site@1", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("resolvePage")).toEqual([
      "authn.identifyUser",
      "authz.require:pages.read",
      "redirects.lookup",
      "site.resolve:pages?home=home&status=published&fallback=true",
      "site.resolveLinks:pages?home=home&status=published&fallback=true",
    ]);
  });
});

describe("examples/minimal redirects wiring", () => {
  it("declares the singleton, the module and the routes", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    const modules = config.modules.map((m) => m.use);
    expect(modules).toContain("@michaelthielemann/kestrel-redirects-default");
    const content = boundaryCast<{ types: Record<string, unknown> }>(config.modules.find((m) => m.use === "@michaelthielemann/kestrel-content-default")!.config, "json");
    expect(content.types.redirects).toEqual({ kind: "single", fields: { rules: { type: "json" } } });
    const routes = config.triggers.filter((t) => "http" in t).map((t) => [(t as { http: string }).http, t.pipeline]);
    expect(routes).toEqual(expect.arrayContaining([["GET /redirects", "getRedirects"], ["PUT /redirects", "setRedirects"], ["GET /redirects.json", "renderRedirects"]]));
  });
  it("runs redirects.lookup before site.resolve and exports after save and publish-all", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    const resolve = pipelines.get("resolvePage")!;
    expect(resolve.indexOf("redirects.lookup")).toBeGreaterThan(-1);
    expect(resolve.indexOf("redirects.lookup")).toBeLessThan(resolve.findIndex((s) => s.startsWith("site.resolve:pages")));
    expect(pipelines.get("setRedirects")).toEqual(["authn.requireUser", "authz.require:redirects.write", "validate.check:redirects.rules", "redirects.validate", "content.set:redirects", "redirects.export"]);
    expect(pipelines.get("publishAllPages")).toEqual(["authn.requireUser", "authz.require:pages.manage", "delivery.publishAll:pages", "redirects.export", "delivery.exportLlms"]);
    expect(pipelines.get("renderRedirects")).toEqual(["redirects.render"]);
  });
});

describe("examples/minimal single translation removal", () => {
  it("routes DELETE /pages/:id/translations/:locale through the update-style pipeline", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    expect(config.triggers.filter((t) => "http" in t).map((t) => [(t as { http: string }).http, t.pipeline])).toContainEqual(["DELETE /pages/:id/translations/:locale", "deletePageTranslation"]);
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("deletePageTranslation")).toEqual(["authn.requireUser", "authz.require:pages.write", "content.removeTranslation:pages", "revisions.removeTranslation:pages", "references.index:pages", "links.extract:pages", "events.emit:page.translationRemoved", "events.relay"]);
  });
});

describe("examples/minimal revisions wiring", () => {
  it("declares the module and the four admin routes plus the prune cron", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    const modules = config.modules.map((m) => m.use);
    expect(modules.indexOf("@michaelthielemann/kestrel-content-default")).toBeLessThan(modules.indexOf("@michaelthielemann/kestrel-revisions-default"));
    const routes = config.triggers.filter((t) => "http" in t).map((t) => [(t as { http: string }).http, t.pipeline]);
    expect(routes).toEqual(
      expect.arrayContaining([
        ["GET /admin/pages/:id/revisions", "pageRevisions"],
        ["GET /admin/pages/:id/revisions/:revisionId", "pageRevision"],
        ["POST /admin/pages/:id/revisions/:revisionId/restore", "restorePageRevision"],
        ["PATCH /admin/pages/:id/revisions/:revisionId", "labelPageRevision"],
      ]),
    );
    expect(config.triggers.filter((t) => "cron" in t).map((t) => t.pipeline)).toContain("pruneRevisions");
  });

  it("records a revision right after every content write and drops them with the document", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    for (const [name, after] of [["createPage", "content.create:pages"], ["updatePage", "content.update:pages"]] as const) {
      const steps = pipelines.get(name)!;
      expect(steps.indexOf("revisions.record:pages"), name).toBe(steps.indexOf(after) + 1);
    }
    expect(pipelines.get("deletePage")).toContain("revisions.remove:pages");
  });

  it("restores through the same chain an update takes, so validation, references and delivery all run", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    const restore = pipelines.get("restorePageRevision")!;
    const update = pipelines.get("updatePage")!;
    expect(restore.indexOf("revisions.restore:pages")).toBe(2);
    expect(restore.slice(3, -3)).toEqual(update.slice(2, -2));
    expect(restore.slice(-3)).toEqual(["revisions.reportRestore", "events.emit:page.restored", "events.relay"]);
    expect(pipelines.get("pageRevisions")).toEqual(["authn.requireUser", "authz.require:pages.manage", "revisions.list:pages"]);
    expect(pipelines.get("pageRevision")).toEqual(["authn.requireUser", "authz.require:pages.manage", "revisions.read:pages"]);
    expect(pipelines.get("labelPageRevision")).toEqual(["authn.requireUser", "authz.require:pages.write", "revisions.label:pages"]);
    expect(pipelines.get("pruneRevisions")).toEqual(["revisions.prune"]);
  });

  it("rejects reassignRevisionAuthor with the verify step moved after the reassign step", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    const modules = await loadModules(root, config);
    const pipelines = await loadPipelines(root, "pipelines");
    const swapped = pipelines.map((p) => {
      if (p.name !== "reassignRevisionAuthor") return p;
      const verify = p.steps.indexOf("authn.verifyUser:result.reassignTo");
      const reassign = p.steps.indexOf("revisions.reassignAuthor");
      const steps = [...p.steps];
      [steps[verify], steps[reassign]] = [steps[reassign]!, steps[verify]!];
      return { ...p, steps };
    });
    await expect(boot({ config: { ...config, http: null }, modules, pipelines: swapped, root })).rejects.toThrow(
      /\[pipelines\/reassignRevisionAuthor\] step "revisions\.reassignAuthor" optionally reads "verifiedUser" but step "authn\.verifyUser:result\.reassignTo" writes it later/,
    );
    await expect(boot({ config: { ...config, http: null }, modules, pipelines: swapped, root })).rejects.toThrow(KestrelBootError);
  });

  it("boots when the verified target is written both before and after the reassign step", async () => {
    const { dispose } = await bootIsolated((pipelines) =>
      pipelines.map((p) => (p.name === "retryReassignRevisionAuthor" ? { ...p, steps: [...p.steps, "authn.verifyUser:reassignTo"] } : p)),
    );
    await dispose();
  });
});

describe("examples/minimal llms.txt wiring", () => {
  it("enables llms-full.txt and adds a settings description", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    const delivery = boundaryCast<{ llms?: { full: boolean } }>(config.modules.find((m) => m.use === "@michaelthielemann/kestrel-delivery-static")!.config, "json");
    expect(delivery.llms?.full).toBe(true);
    const content = boundaryCast<{ types: Record<string, { fields: Record<string, unknown> }> }>(config.modules.find((m) => m.use === "@michaelthielemann/kestrel-content-default")!.config, "json");
    expect(content.types.settings!.fields.description).toEqual({ type: "text", localized: true });
    expect(content.types.pages!.fields.seo).toEqual({ type: "json", localized: true });
  });
  it("re-exports llms.txt after every publish, unpublish, settings change and publish-all", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    for (const [name, after] of [["publishPage", "delivery.publish:pages"], ["unpublishPage", "delivery.unpublish:pages"], ["setSettings", "content.set:settings"], ["publishAllPages", "redirects.export"]] as const) {
      const steps = pipelines.get(name)!;
      expect(steps.indexOf("delivery.exportLlms"), name).toBe(steps.indexOf(after) + 1);
    }
  });
});

describe("examples/minimal delivery event pipelines", () => {
  it("moves publish and unpublish out of the write pipelines and into two event pipelines", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("publishPage")).toEqual(["delivery.publish:pages", "delivery.exportLlms"]);
    expect(pipelines.get("unpublishPage")).toEqual(["delivery.unpublish:pages", "delivery.exportLlms"]);
    for (const name of ["createPage", "updatePage", "deletePage", "deletePageTranslation", "restorePageRevision"]) {
      const steps = pipelines.get(name)!;
      expect(steps, name).not.toContain("delivery.publish:pages");
      expect(steps, name).not.toContain("delivery.unpublish:pages");
      expect(steps, name).not.toContain("delivery.exportLlms");
      expect(steps[steps.length - 1], name).toBe("events.relay");
    }
  });

  it("triggers publishPage on every page write event and unpublishPage on delete", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    const events = config.triggers.filter((t) => "event" in t).map((t) => [(t as { event: string }).event, t.pipeline]);
    expect(events).toEqual(
      expect.arrayContaining([
        ["page.created", "publishPage"],
        ["page.updated", "publishPage"],
        ["page.restored", "publishPage"],
        ["page.translationRemoved", "publishPage"],
        ["page.deleted", "unpublishPage"],
      ]),
    );
  });
});

describe("write pipelines validate their payload", () => {
  it("registers a schema for the settings navigation", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    const validate = boundaryCast<{ schemas: Record<string, string> }>(config.modules.find((m) => m.use === "@michaelthielemann/kestrel-validate-jsonschema")!.config, "json");
    expect(validate.schemas["settings.navigation"]).toBe("./schemas/settings.navigation.json");
  });

  it("checks the navigation before writing settings", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("setSettings")).toEqual([
      "authn.requireUser",
      "authz.require:settings.write",
      "validate.check:settings.navigation",
      "content.set:settings",
      "delivery.exportLlms",
    ]);
  });

  it("leaves the media texts to the plain-text check in media.update", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("updateMedia")).toEqual(["authn.requireUser", "authz.require:media.write", "media.update", "events.emit:media.updated", "events.relay"]);
  });
});

describe("references batch wiring", () => {
  it("declares the batch routes before the single-id routes", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    const routes = config.triggers.filter((t) => "http" in t).map((t) => (t as { http: string }).http);
    expect(routes).toEqual(
      expect.arrayContaining(["GET /admin/references/to/pages", "GET /admin/references/to/media", "GET /admin/references/to/pages/:id", "GET /admin/references/to/media/:id"]),
    );
    expect(routes.indexOf("GET /admin/references/to/pages")).toBeLessThan(routes.indexOf("GET /admin/references/to/pages/:id"));
    expect(routes.indexOf("GET /admin/references/to/media")).toBeLessThan(routes.indexOf("GET /admin/references/to/media/:id"));
  });
  it("wires the batch pipelines like the single ones", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("pageReferrersMany")).toEqual(["authn.requireUser", "authz.require:pages.manage", "references.referrersMany:pages"]);
    expect(pipelines.get("mediaReferrersMany")).toEqual(["authn.requireUser", "authz.require:pages.manage", "references.referrersMany:media"]);
  });
});

describe("media folders wiring", () => {
  it("declares the folder routes", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    const routes = config.triggers.filter((t) => "http" in t).map((t) => [(t as { http: string }).http, t.pipeline]);
    expect(routes).toEqual(
      expect.arrayContaining([
        ["POST /media/folders", "createMediaFolder"],
        ["PATCH /media/folders/*path", "renameMediaFolder"],
        ["DELETE /media/folders/*path", "deleteMediaFolder"],
      ]),
    );
  });
  it("wires the folder pipelines", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("createMediaFolder")).toEqual(["authn.requireUser", "authz.require:media.write", "media.createFolder"]);
    expect(pipelines.get("renameMediaFolder")).toEqual(["authn.requireUser", "authz.require:media.write", "media.renameFolder"]);
    expect(pipelines.get("deleteMediaFolder")).toEqual(["authn.requireUser", "authz.require:media.delete", "media.listFolderItems", "references.guardAll:media", "images.removeMany", "media.removeFolder"]);
  });
});

describe("image variants wiring", () => {
  it("declares the module, authz and routes", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    const modules = config.modules.map((m) => m.use);
    expect(modules).toContain("@michaelthielemann/kestrel-images-default");
    const authz = boundaryCast<{ roles: { admin: string[]; editor: string[] } }>(config.modules.find((m) => m.use === "@michaelthielemann/kestrel-authz-roles")!.config, "json");
    expect(authz.roles.admin).toContain("*");
    expect(authz.roles.editor).toContain("images.read");
    const routes = config.triggers.filter((t) => "http" in t).map((t) => [(t as { http: string }).http, t.pipeline]);
    expect(routes).toEqual(
      expect.arrayContaining([
        ["PUT /admin/images/sizes", "registerImageSizes"],
        ["GET /admin/images/sizes", "listImageSizes"],
        ["POST /admin/images/sync", "syncImages"],
        ["POST /admin/images/prune", "pruneImages"],
        ["GET /admin/images/status", "imagesStatus"],
        ["GET /media/:id/variants/:file", "serveImageVariant"],
      ]),
    );
    const events = config.triggers.filter((t) => "event" in t).map((t) => [(t as { event: string }).event, t.pipeline]);
    expect(events).toEqual(expect.arrayContaining([["media.uploaded", "generateImageVariants"]]));
    const crons = config.triggers.filter((t) => "cron" in t).map((t) => [(t as { cron: string }).cron, t.pipeline]);
    expect(crons).toEqual(expect.arrayContaining([["*/5 * * * *", "resumeImages"]]));
  });
  it("wires the image pipelines", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("registerImageSizes")).toEqual(["authn.requireUser", "authz.require:images.write", "images.register"]);
    expect(pipelines.get("registerImageSizesBoot")).toEqual(["images.register"]);
    expect(pipelines.get("listImageSizes")).toEqual(["authn.requireUser", "authz.require:images.read", "images.listSizes"]);
    expect(pipelines.get("syncImages")).toEqual(["authn.requireUser", "authz.require:images.manage", "images.sync"]);
    expect(pipelines.get("pruneImages")).toEqual(["authn.requireUser", "authz.require:images.manage", "images.prune"]);
    expect(pipelines.get("imagesStatus")).toEqual(["authn.requireUser", "authz.require:images.read", "images.readStatus"]);
    expect(pipelines.get("serveImageVariant")).toEqual(["authn.identifyUser", "authz.require:media.read", "images.serve"]);
    expect(pipelines.get("generateImageVariants")).toEqual(["images.generate"]);
    expect(pipelines.get("resumeImages")).toEqual(["images.resume"]);
  });
  it("keeps the embedded registration pipeline off the http surface", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    expect(config.triggers.filter((t) => t.pipeline === "registerImageSizesBoot")).toEqual([]);
  });
  it("attaches variants to media reads and export, removes on delete", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("getMedia")).toEqual(["authn.identifyUser", "authz.require:media.read", "media.get", "images.attach"]);
    expect(pipelines.get("listMedia")).toEqual(["authn.identifyUser", "authz.require:media.read", "media.list", "images.attach"]);
    expect(pipelines.get("deleteMedia")).toEqual(["authn.requireUser", "authz.require:media.delete", "references.guard:media", "images.remove", "media.remove", "events.emit:media.deleted", "events.relay"]);
    expect(pipelines.get("exportMedia")).toEqual(["authn.requireUser", "authz.require:media.manage", "media.export:./data/export", "images.export:./data/export"]);
  });
  it("leaves resolvePage untouched", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("resolvePage")).not.toContain("images.attach");
  });
});

describe("content migrations wiring", () => {
  it("declares the module after validate-jsonschema and the routes", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    const modules = config.modules.map((m) => m.use);
    expect(modules.indexOf("@michaelthielemann/kestrel-validate-jsonschema")).toBeLessThan(modules.indexOf("@michaelthielemann/kestrel-migrations-default"));
    const routes = config.triggers.filter((t) => "http" in t).map((t) => [(t as { http: string }).http, t.pipeline]);
    expect(routes).toEqual(expect.arrayContaining([["GET /admin/migrations", "listMigrations"], ["POST /admin/migrations/apply", "applyMigrations"]]));
  });
  it("wires the migrations pipelines", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("listMigrations")).toEqual(["authn.requireUser", "authz.require:migrations.manage", "migrations.list"]);
    expect(pipelines.get("applyMigrations")).toEqual(["authn.requireUser", "authz.require:migrations.manage", "migrations.apply"]);
  });
});

describe("insights wiring", () => {
  it("declares the module and the two admin routes", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    expect(config.modules.map((m) => m.use)).toContain("@michaelthielemann/kestrel-insights");
    const routes = config.triggers.filter((t) => "http" in t).map((t) => [(t as { http: string }).http, t.pipeline]);
    expect(routes).toEqual(expect.arrayContaining([["GET /admin/insights/manifest", "insightsManifest"], ["GET /admin/insights/stats", "insightsStats"]]));
  });
  it("guards both pipelines with a login and insights.read", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("insightsManifest")).toEqual(["authn.requireUser", "authz.require:insights.read", "insights.readManifest"]);
    expect(pipelines.get("insightsStats")).toEqual(["authn.requireUser", "authz.require:insights.read", "insights.readStats"]);
  });
  it("shows the effective config values in the committed manifest and keeps the secrets out", () => {
    const manifest = boundaryCast<{ modules: { name: string; version: string | null; config: { variables: { path: string; secret: boolean; default?: unknown; value: unknown; redacted: boolean }[] } }[] }>(
      JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")),
      "json",
    );
    expect(manifest.modules.length).toBeGreaterThan(0);
    for (const m of manifest.modules) expect(m.version, m.name).toMatch(/^\d+\.\d+\.\d+/);
    const authn = manifest.modules.find((m) => m.name === "authn/multi")!.config.variables;
    expect(authn.find((v) => v.path === "bootstrap.passwordHash")).toMatchObject({ secret: true, redacted: true, value: null });
    expect(authn.find((v) => v.path === "bootstrap.passwordHash")).not.toHaveProperty("default");
    expect(authn.find((v) => v.path === "bootstrap.username")).toMatchObject({ redacted: false, value: "admin" });
    expect(authn.find((v) => v.path === "bootstrap")).toMatchObject({ value: { username: "admin", passwordHash: "[redacted]" } });
    expect(manifest.modules.find((m) => m.name === "persistence/sqlite")!.config.variables.find((v) => v.path === "file")).toMatchObject({ value: "./data/kestrel.db" });
    expect(readFileSync(join(root, "manifest.json"), "utf8")).not.toContain("scrypt$522f4ac87bfe4bcd100ba47a7d2aaec2");
  });
});

describe("content model wiring", () => {
  it("serves the parsed model to every logged-in user", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    expect(config.triggers.filter((t) => "http" in t).map((t) => [(t as { http: string }).http, t.pipeline])).toContainEqual(["GET /admin/content/model", "contentModel"]);
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("contentModel")).toEqual(["authn.requireUser", "content.describeModel"]);
  });
});

async function bootIsolated(withPipelines?: (pipelines: PipelineDefinition[]) => PipelineDefinition[]): Promise<{ kestrel: Awaited<ReturnType<typeof boot>>; dispose: () => Promise<void> }> {
  const configInput = await loadConfig(join(root, "kestrel.config.ts"));
  const dataDir = mkdtempSync(join(tmpdir(), "kestrel-minimal-"));
  const isolated: KestrelConfigInput = {
    ...configInput,
    http: null,
    modules: configInput.modules.map((m) => {
      if (m.use === "@michaelthielemann/kestrel-persistence-sqlite") {
        return { ...m, config: { ...(m.config as object), file: ":memory:" } };
      }
      if (m.use === "@michaelthielemann/kestrel-replication-sqlite") {
        return { ...m, config: { ...(m.config as object), file: join(dataDir, "replication.db") } };
      }
      if (m.use === "@michaelthielemann/kestrel-blobstore-filesystem") {
        return { ...m, config: { ...(m.config as object), root: join(dataDir, "blobs") } };
      }
      return m;
    }),
  };
  const modules = await loadModules(root, isolated);
  const loaded = await loadPipelines(root, "pipelines");
  const pipelines = withPipelines ? withPipelines(loaded) : loaded;
  const kestrel = await boot({ config: isolated, modules, pipelines, root, validateOutput: true });
  await kestrel.start();
  return {
    kestrel,
    dispose: async () => {
      await kestrel.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

interface PersistenceCall {
  method: string;
  collection: string;
}

const PERSISTENCE_METHODS = ["ensureCollection", "createOne", "createMany", "findOne", "findMany", "count", "updateOne", "updateMany", "deleteOne", "deleteMany"] as const;

function spyOnPersistence(base: unknown, calls: PersistenceCall[], targetCollection: string, armed: { value: boolean }): unknown {
  const record = boundaryCast<Record<string, unknown>>(base, "host");
  const wrapped: Record<string, unknown> = { ...record };
  for (const name of PERSISTENCE_METHODS) {
    const original = boundaryCast<(...args: unknown[]) => Promise<unknown>>(record[name], "host");
    wrapped[name] = (...args: unknown[]): Promise<unknown> => {
      const collection = typeof args[0] === "string" ? args[0] : "";
      if (name === "findOne" && armed.value && collection === targetCollection) {
        armed.value = false;
        calls.push({ method: "findOne (forced failure)", collection });
        const forced: Result<never, PersistenceError> = err(failure("TRANSIENT", "forced failure for the test"));
        return Promise.resolve(forced);
      }
      calls.push({ method: name, collection });
      return original(...args);
    };
  }
  return wrapped;
}

async function bootWithQueue(): Promise<{
  kestrel: Awaited<ReturnType<typeof boot>>;
  dispose: () => Promise<void>;
  calls: PersistenceCall[];
  armStatusFailureOnce: () => void;
}> {
  const configInput = await loadConfig(join(root, "kestrel.config.ts"));
  const dataDir = mkdtempSync(join(tmpdir(), "kestrel-minimal-queue-"));
  const isolated: KestrelConfigInput = {
    ...configInput,
    http: null,
    modules: configInput.modules.map((m) => {
      if (m.use === "@michaelthielemann/kestrel-persistence-sqlite") return { ...m, config: { ...(m.config as object), file: ":memory:" } };
      if (m.use === "@michaelthielemann/kestrel-replication-sqlite") return { ...m, config: { ...(m.config as object), file: join(dataDir, "replication.db") } };
      if (m.use === "@michaelthielemann/kestrel-blobstore-filesystem") return { ...m, config: { ...(m.config as object), root: join(dataDir, "blobs") } };
      if (m.use === "@michaelthielemann/kestrel-events-direct") return { use: "@michaelthielemann/kestrel-events-queue", config: { maxAttempts: 1, relayMs: 5000 } };
      return m;
    }),
  };
  const loadedModules = await loadModules(root, isolated);
  const calls: PersistenceCall[] = [];
  const armed = { value: false };
  const modules = loadedModules.map((mod) => {
    if (mod.name !== "persistence/sqlite") return mod;
    return defineModule({
      ...mod,
      async setup(config, deps) {
        const real = await mod.setup(config, deps);
        return spyOnPersistence(real, calls, DELIVERY_STATUS_COLLECTION, armed);
      },
    });
  });
  const pipelines = [...(await loadPipelines(root, "pipelines")), definePipeline({ name: "listDeadEvents", steps: ["events.listDead"] }), definePipeline({ name: "retryDeadEvent", steps: ["events.retryDead:one"] })];
  const kestrel = await boot({ config: isolated, modules, pipelines, root, validateOutput: true });
  await kestrel.start();
  return {
    kestrel,
    calls,
    armStatusFailureOnce: () => {
      armed.value = true;
    },
    dispose: async () => {
      await kestrel.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe("demo bootstrap credentials", () => {
  it("logs the demo admin in with the documented password", async () => {
    const { kestrel, dispose } = await bootIsolated();
    try {
      const session = await kestrel.run("login", {
        trigger: { kind: "http", name: "test" },
        payload: { username: "admin", password: "kestrel-demo" },
      });
      expect(session.status).toBe(200);
      expect(session.result).toMatchObject({ identity: { claims: { username: "admin", roles: ["admin"] } } });
    } finally {
      await dispose();
    }
  });
});

type Instance = Awaited<ReturnType<typeof boot>>;
interface Session {
  token: string;
  identity: { id: string };
}

const trigger = { kind: "http", name: "test" } as const;
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

async function login(kestrel: Instance, username: string, password: string): Promise<Session> {
  const session = await kestrel.run("login", { trigger, payload: { username, password } });
  expect(session.status).toBe(200);
  return boundaryCast<Session>(session.result, "json");
}

async function createEditor(kestrel: Instance, admin: Session, username: string): Promise<{ id: string }> {
  const created = await kestrel.run("createUser", { trigger, headers: bearer(admin.token), payload: { username, password: "long-enough", roles: ["editor"] } });
  expect(created.status).toBe(200);
  return boundaryCast<{ id: string }>(created.result, "json");
}

async function createPage(kestrel: Instance, session: Session, slug: string): Promise<string> {
  const fields = { slug, title: "A", status: "draft" };
  const created = await kestrel.run("createPage", { trigger, headers: bearer(session.token), payload: fields, body: fields });
  expect(created.status).toBe(200);
  const result = boundaryCast<{ id?: string; document?: { id: string } }>(created.result, "json");
  return result.id ?? result.document?.id ?? "";
}

async function revisionsOf(kestrel: Instance, admin: Session, pageId: string): Promise<RevisionPage> {
  const listed = await kestrel.run("pageRevisions", { trigger, headers: bearer(admin.token), params: { id: pageId } });
  expect(listed.status).toBe(200);
  return boundaryCast<RevisionPage>(listed.result, "json");
}

async function failedPipelines(kestrel: Instance, admin: Session): Promise<string[]> {
  const stats = await kestrel.run("insightsStats", { trigger, headers: bearer(admin.token) });
  expect(stats.status).toBe(200);
  return boundaryCast<{ recentFailures: { pipeline: string }[] }>(stats.result, "json").recentFailures.map((failure) => failure.pipeline);
}

describe("user pipelines validate role names", () => {
  it("declares authz.validateRoles:roles right after authz.require:users.manage on create and update", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("createUser")).toEqual(["authn.requireUser", "authz.require:users.manage", "authz.validateRoles:roles", "authn.createUser", "events.emit:user.created", "events.relay"]);
    expect(pipelines.get("updateUser")).toEqual(["authn.requireUser", "authz.require:users.manage", "authz.validateRoles:roles", "authn.updateUser", "events.emit:user.updated", "events.relay"]);
  });

  it("rejects an unknown role on create, creating no user", async () => {
    const { kestrel, dispose } = await bootIsolated();
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const created = await kestrel.run("createUser", { trigger, headers: bearer(admin.token), payload: { username: "lena", password: "long-enough", roles: ["typo-role"] } });
      expect(created.status).toBe(400);
      const listed = await kestrel.run("listUsers", { trigger, headers: bearer(admin.token) });
      expect(boundaryCast<{ username: string }[]>(listed.result, "json").map((u) => u.username)).not.toContain("lena");
    } finally {
      await dispose();
    }
  });

  it("accepts known roles on create", async () => {
    const { kestrel, dispose } = await bootIsolated();
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const created = await kestrel.run("createUser", { trigger, headers: bearer(admin.token), payload: { username: "mona", password: "long-enough", roles: ["editor"] } });
      expect(created.status).toBe(200);
    } finally {
      await dispose();
    }
  });

  it("rejects an unknown role on update, leaving the user's roles unchanged", async () => {
    const { kestrel, dispose } = await bootIsolated();
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const editor = await createEditor(kestrel, admin, "nora");
      const updated = await kestrel.run("updateUser", { trigger, headers: bearer(admin.token), params: { id: editor.id }, payload: { roles: ["typo-role"] } });
      expect(updated.status).toBe(400);
      const fetched = await kestrel.run("getUser", { trigger, headers: bearer(admin.token), params: { id: editor.id } });
      expect(boundaryCast<{ roles: string[] }>(fetched.result, "json").roles).toEqual(["editor"]);
    } finally {
      await dispose();
    }
  });

  it("accepts an update without roles", async () => {
    const { kestrel, dispose } = await bootIsolated();
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const editor = await createEditor(kestrel, admin, "opal");
      const updated = await kestrel.run("updateUser", { trigger, headers: bearer(admin.token), params: { id: editor.id }, payload: { username: "opal2" } });
      expect(updated.status).toBe(200);
    } finally {
      await dispose();
    }
  });

  it("reports a prototype-key role name as unknown instead of throwing", async () => {
    const { kestrel, dispose } = await bootIsolated();
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const created = await kestrel.run("createUser", { trigger, headers: bearer(admin.token), payload: { username: "petra", password: "long-enough", roles: ["constructor", "__proto__", "toString"] } });
      expect(created.status).toBe(400);
    } finally {
      await dispose();
    }
  });
});

describe("user deletion wiring", () => {
  it("declares the event pipelines, the retry routes, the prune cron and the retention", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    const audit = boundaryCast<{ retentionDays?: number }>(config.modules.find((m) => m.use === "@michaelthielemann/kestrel-audit-persistence")!.config, "json");
    expect(audit.retentionDays).toBe(365);
    const events = config.triggers.filter((t) => "event" in t).map((t) => [(t as { event: string }).event, t.pipeline]);
    expect(events).toEqual(expect.arrayContaining([["user.deleted", "reassignRevisionAuthor"], ["user.deleted", "anonymizeAuditUser"]]));
    const routes = config.triggers.filter((t) => "http" in t).map((t) => [(t as { http: string }).http, t.pipeline]);
    expect(routes).toEqual(
      expect.arrayContaining([
        ["POST /admin/users/:id/revisions/reassign", "retryReassignRevisionAuthor"],
        ["POST /admin/users/:id/audit/anonymize", "retryAnonymizeAuditUser"],
      ]),
    );
    expect(config.triggers.filter((t) => "cron" in t).map((t) => t.pipeline)).toContain("pruneAudit");

    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("deleteUser")).toEqual(["authn.requireUser", "authz.require:users.manage", "authn.deleteUser", "events.emit:user.deleted?with=result", "events.relay"]);
    expect(pipelines.get("reassignRevisionAuthor")).toEqual(["authn.verifyUser:result.reassignTo", "revisions.reassignAuthor"]);
    expect(pipelines.get("anonymizeAuditUser")).toEqual(["audit.anonymize"]);
    expect(pipelines.get("retryReassignRevisionAuthor")).toEqual(["authn.requireUser", "authz.require:users.manage", "authn.verifyUser:reassignTo", "revisions.reassignAuthor"]);
    expect(pipelines.get("retryAnonymizeAuditUser")).toEqual(["authn.requireUser", "authz.require:users.manage", "audit.anonymize"]);
    expect(pipelines.get("pruneAudit")).toEqual(["audit.prune"]);
  });

  it("moves a deleted user's revisions to the named target and keeps the page", async () => {
    const { kestrel, dispose } = await bootIsolated();
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const editor = await createEditor(kestrel, admin, "carol");
      const editorSession = await login(kestrel, "carol", "long-enough");
      const pageId = await createPage(kestrel, editorSession, "carol-page");

      const deleted = await kestrel.run("deleteUser", { trigger: { kind: "http", name: "test" }, headers: bearer(admin.token), params: { id: editor.id }, payload: { reassignTo: admin.identity.id }, body: { reassignTo: admin.identity.id } });
      expect(deleted.status).toBe(200);
      expect(deleted.result).toMatchObject({ ok: true, reassignTo: { id: admin.identity.id, name: "admin" } });

      const revisions = await revisionsOf(kestrel, admin, pageId);
      expect(revisions.total).toBe(1);
      expect(revisions.items[0]?.author).toEqual({ id: admin.identity.id, name: "admin" });
      expect(await failedPipelines(kestrel, admin)).toEqual([]);
    } finally {
      await dispose();
    }
  });

  it("anonymises the history without a target and leaves the user in place on an invalid one", async () => {
    const { kestrel, dispose } = await bootIsolated();
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const editor = await createEditor(kestrel, admin, "dora");
      const editorSession = await login(kestrel, "dora", "long-enough");
      const pageId = await createPage(kestrel, editorSession, "dora-page");

      const unknownTarget = await kestrel.run("deleteUser", { trigger: { kind: "http", name: "test" }, headers: bearer(admin.token), params: { id: editor.id }, payload: { reassignTo: "nobody" }, body: { reassignTo: "nobody" } });
      expect(unknownTarget.status).toBe(404);
      expect((await kestrel.run("getUser", { trigger: { kind: "http", name: "test" }, headers: bearer(admin.token), params: { id: editor.id } })).status).toBe(200);

      const deleted = await kestrel.run("deleteUser", { trigger: { kind: "http", name: "test" }, headers: bearer(admin.token), params: { id: editor.id } });
      expect(deleted.status).toBe(200);
      expect(deleted.result).toMatchObject({ ok: true, reassignTo: null });

      const revisions = await revisionsOf(kestrel, admin, pageId);
      expect(revisions.total).toBe(1);
      expect(revisions.items[0]?.author).toEqual({ id: null, name: null });

      const retry = await kestrel.run("retryAnonymizeAuditUser", { trigger: { kind: "http", name: "test" }, headers: bearer(admin.token), params: { id: editor.id } });
      expect(retry.status).toBe(200);
      expect(retry.result).toEqual({ entries: 0 });
      expect(await failedPipelines(kestrel, admin)).toEqual(["deleteUser"]);
    } finally {
      await dispose();
    }
  });

  it("retryReassignRevisionAuthor rejects an unknown or inactive target and leaves revisions unchanged", async () => {
    const { kestrel, dispose } = await bootIsolated();
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const editor = await createEditor(kestrel, admin, "erin");
      const editorSession = await login(kestrel, "erin", "long-enough");
      const pageId = await createPage(kestrel, editorSession, "erin-page");
      const inactive = await createEditor(kestrel, admin, "fay");
      await kestrel.run("deactivateUser", { trigger, headers: bearer(admin.token), params: { id: inactive.id } });

      const unknown = await kestrel.run("retryReassignRevisionAuthor", {
        trigger,
        headers: bearer(admin.token),
        params: { id: editor.id },
        payload: { reassignTo: { id: "nobody", name: "ghost" } },
        body: { reassignTo: { id: "nobody", name: "ghost" } },
      });
      expect(unknown.status).toBe(404);

      const deactivated = await kestrel.run("retryReassignRevisionAuthor", {
        trigger,
        headers: bearer(admin.token),
        params: { id: editor.id },
        payload: { reassignTo: { id: inactive.id, name: "fay" } },
        body: { reassignTo: { id: inactive.id, name: "fay" } },
      });
      expect(deactivated.status).toBe(400);

      const revisions = await revisionsOf(kestrel, admin, pageId);
      expect(revisions.items[0]?.author).toEqual({ id: editor.id, name: "erin" });
    } finally {
      await dispose();
    }
  });

  it("retryReassignRevisionAuthor writes the canonical name even when the payload names a different one", async () => {
    const { kestrel, dispose } = await bootIsolated();
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const editor = await createEditor(kestrel, admin, "gus");
      const editorSession = await login(kestrel, "gus", "long-enough");
      const pageId = await createPage(kestrel, editorSession, "gus-page");
      const target = await createEditor(kestrel, admin, "hana");

      const reassigned = await kestrel.run("retryReassignRevisionAuthor", {
        trigger,
        headers: bearer(admin.token),
        params: { id: editor.id },
        payload: { reassignTo: { id: target.id, name: "someone-else" } },
        body: { reassignTo: { id: target.id, name: "someone-else" } },
      });
      expect(reassigned.status).toBe(200);

      const revisions = await revisionsOf(kestrel, admin, pageId);
      expect(revisions.items[0]?.author).toEqual({ id: target.id, name: "hana" });
    } finally {
      await dispose();
    }
  });

  it("retryReassignRevisionAuthor accepts a bare id or { id } alone, name is never required", async () => {
    const { kestrel, dispose } = await bootIsolated();
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const editor = await createEditor(kestrel, admin, "ivy");
      const target = await createEditor(kestrel, admin, "jill");

      const bareId = await kestrel.run("retryReassignRevisionAuthor", { trigger, headers: bearer(admin.token), params: { id: editor.id }, payload: { reassignTo: target.id }, body: { reassignTo: target.id } });
      expect(bareId.status).toBe(200);
      expect(bareId.result).toMatchObject({ to: { id: target.id, name: "jill" } });

      const idOnly = await kestrel.run("retryReassignRevisionAuthor", {
        trigger,
        headers: bearer(admin.token),
        params: { id: editor.id },
        payload: { reassignTo: { id: target.id } },
        body: { reassignTo: { id: target.id } },
      });
      expect(idOnly.status).toBe(200);
      expect(idOnly.result).toMatchObject({ to: { id: target.id, name: "jill" } });
    } finally {
      await dispose();
    }
  });

  it("retryReassignRevisionAuthor rejects a reassignTo that is neither a user id, an object with id, nor null", async () => {
    const { kestrel, dispose } = await bootIsolated();
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const editor = await createEditor(kestrel, admin, "kim");

      const wrongType = await kestrel.run("retryReassignRevisionAuthor", { trigger, headers: bearer(admin.token), params: { id: editor.id }, payload: { reassignTo: 7 }, body: { reassignTo: 7 } });
      expect(wrongType.status).toBe(400);

      const noId = await kestrel.run("retryReassignRevisionAuthor", { trigger, headers: bearer(admin.token), params: { id: editor.id }, payload: { reassignTo: { name: "no-id" } }, body: { reassignTo: { name: "no-id" } } });
      expect(noId.status).toBe(400);
    } finally {
      await dispose();
    }
  });
});

describe("events/queue relay: a forced delivery.publish failure through POST /pages", () => {
  it("answers 200 with _events.status \"error\"; the run is visible in the dead letter and retriable; the retry does not re-run revisions or references; the write is not rolled back", async () => {
    const { kestrel, dispose, calls, armStatusFailureOnce } = await bootWithQueue();
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");

      armStatusFailureOnce();
      const created = await kestrel.run("createPage", {
        trigger,
        headers: bearer(admin.token),
        payload: { slug: "queue-relay", title: "A", status: "draft" },
        body: { slug: "queue-relay", title: "A", status: "draft" },
      });
      expect(created.status).toBe(200);
      const body = boundaryCast<{ id: string; _events?: { status: string; pipelines: { pipeline: string; status: string; dead: boolean }[] } }>(created.result, "json");
      const pageId = body.id;
      expect(body._events?.status).toBe("error");
      expect(body._events?.pipelines).toContainEqual(expect.objectContaining({ pipeline: "publishPage", status: "error", dead: true }));

      const read = await kestrel.run("readAnyPage", { trigger, headers: bearer(admin.token), params: { id: pageId } });
      expect(read.status).toBe(200);
      const revisions = await revisionsOf(kestrel, admin, pageId);
      expect(revisions.total).toBe(1);

      const derivedTouches = (log: PersistenceCall[]): number => log.filter((c) => c.collection === "revisions_entries" || c.collection === "revisions_heads" || c.collection === "references_index").length;
      const touchesBeforeRetry = derivedTouches(calls);

      const dead = await kestrel.run("listDeadEvents", { trigger, headers: bearer(admin.token) });
      expect(dead.status).toBe(200);
      const deadItems = boundaryCast<{ items: { id: string; pipeline: string }[] }>(dead.result, "json").items;
      const deadRow = deadItems.find((d) => d.pipeline === "publishPage");
      expect(deadRow).toBeDefined();

      const retried = await kestrel.run("retryDeadEvent", { trigger, headers: bearer(admin.token), params: { id: deadRow!.id } });
      expect(retried.status).toBe(200);
      expect(retried.result).toEqual({ retried: 1 });

      expect(derivedTouches(calls)).toBe(touchesBeforeRetry);
    } finally {
      await dispose();
    }
  });
});
