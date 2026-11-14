import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { boot, defineModule, definePipeline, err, failure, KestrelBootError } from "@michaelthielemann/kestrel";
import { loadConfig, loadModules, loadPipelines } from "@michaelthielemann/kestrel/load";
import type { RevisionPage } from "@michaelthielemann/kestrel-contracts/revisions";
import type { Persistence, PersistenceError } from "@michaelthielemann/kestrel-contracts/persistence";
import { STATUS as DELIVERY_STATUS_COLLECTION } from "@michaelthielemann/kestrel-delivery-static/impl";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { KestrelConfigInput } from "@michaelthielemann/kestrel/defineConfig";
import { pipelineSteps, type PipelineDefinition } from "@michaelthielemann/kestrel/definePipeline";
import type { Result } from "@michaelthielemann/kestrel/result";
import { validateSchema } from "@michaelthielemann/kestrel/schema";

const root = dirname(fileURLToPath(import.meta.url));

const TEST_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=",
  "base64",
);

describe("static delivery reserves the media path instead of rewriting it", () => {
  it("configures reservedPaths on delivery-static, publicCopy on the media modules", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    const delivery = boundaryCast<{ reservedPaths?: string[] }>(config.modules.find((m) => m.use === "@michaelthielemann/kestrel-delivery-static")!.config, "json");
    expect(delivery.reservedPaths).toEqual(["/media"]);
    const media = boundaryCast<{ publicCopy?: { prefix: string } }>(config.modules.find((m) => m.use === "@michaelthielemann/kestrel-media-default")!.config, "json");
    expect(media.publicCopy).toEqual({ prefix: "site/" });
    const images = boundaryCast<{ publicCopy?: { prefix: string } }>(config.modules.find((m) => m.use === "@michaelthielemann/kestrel-images-default")!.config, "json");
    expect(images.publicCopy).toEqual({ prefix: "site/" });
  });
});

describe("site wiring", { timeout: 30_000 }, () => {
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
      "authz.fields:pages?shape=item",
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
    expect(pipelines.get("setRedirects")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:redirects.write", "validate.check:redirects.rules", "redirects.validate", "content.set:redirects", "redirects.export"]);
    expect(pipelines.get("publishAllPages")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:pages.manage", "delivery.publishAll:pages", "redirects.export", "delivery.requestIndexes"]);
    expect(pipelines.get("renderRedirects")).toEqual(["redirects.render", "authz.fields:redirectRules?shape=array"]);
  });
});

describe("examples/minimal single translation removal", () => {
  it("routes DELETE /pages/:id/translations/:locale through the update-style pipeline", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    expect(config.triggers.filter((t) => "http" in t).map((t) => [(t as { http: string }).http, t.pipeline])).toContainEqual(["DELETE /pages/:id/translations/:locale", "deletePageTranslation"]);
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("deletePageTranslation")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:pages.write", "content.removeTranslation:pages", "revisions.removeTranslation:pages", "references.index:pages", "links.extract:pages", "site.indexPath:pages", "site.announcePaths", "events.emit:page.translationRemoved", "events.relay"]);
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
    expect(restore.indexOf("revisions.restore:pages")).toBe(3);
    expect(restore.slice(4, -3)).toEqual(update.slice(3, -2));
    expect(restore.slice(-3)).toEqual(["revisions.reportRestore", "events.emit:page.restored", "events.relay"]);
    expect(pipelines.get("pageRevisions")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:pages.manage", "revisions.list:pages"]);
    expect(pipelines.get("pageRevision")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:pages.manage", "revisions.read:pages"]);
    expect(pipelines.get("labelPageRevision")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:pages.write", "revisions.label:pages"]);
    expect(pipelines.get("pruneRevisions")).toEqual(["revisions.prune"]);
  });

  it("rejects reassignRevisionAuthor with the verify step moved after the reassign step", async () => {
    const swapVerifyAfterReassign = (pipelines: PipelineDefinition[]) =>
      pipelines.map((p) => {
        if (p.name !== "reassignRevisionAuthor") return p;
        const verify = p.steps.indexOf("authn.verifyUser:result.reassignTo");
        const reassign = p.steps.indexOf("revisions.reassignAuthor");
        const steps = [...p.steps];
        [steps[verify], steps[reassign]] = [steps[reassign]!, steps[verify]!];
        return { ...p, steps };
      });
    const booting = bootIsolated(swapVerifyAfterReassign);
    await expect(booting).rejects.toThrow(KestrelBootError);
    await expect(booting).rejects.toThrow(
      /\[pipelines\/reassignRevisionAuthor\] step "revisions\.reassignAuthor" reads "verifiedUser" but no earlier step writes it \(earlier writes: none\)/,
    );
  }, 30_000);

  it("boots when the verified target is written both before and after the reassign step", async () => {
    const { dispose } = await bootIsolated((pipelines) =>
      pipelines.map((p) => (p.name === "retryReassignRevisionAuthor" ? { ...p, steps: [...p.steps, "authn.verifyUser:reassignTo"] } : p)),
    );
    await dispose();
  });
});

describe("examples/minimal index file wiring", () => {
  it("enables llms-full.txt and adds a settings description", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    const delivery = boundaryCast<{ llms?: { full: boolean } }>(config.modules.find((m) => m.use === "@michaelthielemann/kestrel-delivery-static")!.config, "json");
    expect(delivery.llms?.full).toBe(true);
    const content = boundaryCast<{ types: Record<string, { fields: Record<string, unknown> }> }>(config.modules.find((m) => m.use === "@michaelthielemann/kestrel-content-default")!.config, "json");
    expect(content.types.settings!.fields.description).toEqual({ type: "text", localized: true });
    expect(content.types.pages!.fields.seo).toEqual({ type: "json", localized: true });
  });
  it("asks for an index export after every publish, unpublish, settings change and publish-all, and never exports inline", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    for (const [name, after] of [["publishPage", "delivery.publish:pages"], ["unpublishPage", "delivery.unpublish:pages"], ["settingsDependents", "delivery.markDependents:settings"]] as const) {
      const steps = pipelines.get(name)!;
      expect(steps.indexOf("delivery.requestIndexes"), name).toBe(steps.indexOf(after) + 1);
      expect(steps, name).not.toContain("delivery.exportIndexes");
    }
    expect(pipelines.get("setSettings")).not.toContain("delivery.exportIndexes");
    const publishAll = pipelines.get("publishAllPages")!;
    expect(publishAll.indexOf("delivery.requestIndexes")).toBe(publishAll.indexOf("redirects.export") + 1);
    for (const [name, steps] of pipelines) {
      expect(steps, name).not.toContain("delivery.exportIndexes");
      expect(steps, name).not.toContain("delivery.exportLlmsFull");
    }
  });
});

describe("examples/minimal delivery event pipelines", () => {
  it("moves publish and unpublish out of the write pipelines and into two event pipelines", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("publishPage")).toEqual(["delivery.publish:pages", "delivery.requestIndexes"]);
    expect(pipelines.get("unpublishPage")).toEqual(["delivery.unpublish:pages", "delivery.requestIndexes"]);
    for (const name of ["createPage", "updatePage", "deletePage", "deletePageTranslation", "restorePageRevision"]) {
      const steps = pipelines.get(name)!;
      expect(steps, name).not.toContain("delivery.publish:pages");
      expect(steps, name).not.toContain("delivery.unpublish:pages");
      expect(steps, name).not.toContain("delivery.exportIndexes");
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
      "authz.requireRole",
      "authz.require:settings.write",
      "validate.check:settings.navigation",
      "content.set:settings",
      "events.emit:settings.updated",
      "events.relay",
    ]);
  });

  it("leaves the media texts to the plain-text check in media.update", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("updateMedia")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:media.write", "media.update", "events.emit:media.updated", "events.relay"]);
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
    expect(pipelines.get("pageReferrersMany")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:pages.manage", "references.referrersMany:pages"]);
    expect(pipelines.get("mediaReferrersMany")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:pages.manage", "references.referrersMany:media"]);
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
    expect(pipelines.get("createMediaFolder")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:media.write", "media.createFolder"]);
    expect(pipelines.get("renameMediaFolder")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:media.write", "media.renameFolder"]);
    expect(pipelines.get("deleteMediaFolder")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:media.delete", "media.listFolderItems", "references.guardAll:media", "media.removeFolder", "images.removeMany", "events.emit:media.deleted", "events.relay"]);
  });
});

describe("media trash wiring", () => {
  it("declares the trash routes before the single-item routes and empties expired items nightly", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    const routes = config.triggers.filter((t) => "http" in t).map((t) => [(t as { http: string }).http, t.pipeline]);
    expect(routes).toEqual(
      expect.arrayContaining([
        ["GET /media/trash", "listMediaTrash"],
        ["POST /media/trash", "trashMedia"],
        ["POST /media/trash/folders/*path", "trashMediaFolder"],
        ["POST /media/trash/restore", "restoreMedia"],
        ["POST /media/trash/purge", "purgeMedia"],
        ["POST /media/trash/empty", "emptyMediaTrash"],
        ["DELETE /media/:id", "deleteMedia"],
      ]),
    );
    const http = routes.map(([route]) => route);
    expect(http.indexOf("GET /media/trash")).toBeLessThan(http.indexOf("GET /media/:id"));
    const crons = config.triggers.filter((t) => "cron" in t).map((t) => [(t as { cron: string }).cron, t.pipeline]);
    expect(crons).toEqual(expect.arrayContaining([["0 4 * * *", "purgeExpiredMedia"]]));
  });

  it("guards moving and purging with media.delete, viewing and restoring with media.write, and purges only unreferenced items before their variants", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    const signedIn = ["authn.requireUser", "authz.requireRole"];
    const purge = ["references.dropReferenced:media", "media.purge", "images.removeMany", "events.emit:media.deleted"];
    expect(pipelines.get("trashMedia")).toEqual([...signedIn, "authz.require:media.delete", "media.trash", "images.hideMany", "events.emit:media.trashed", "events.relay"]);
    expect(pipelines.get("trashMediaFolder")).toEqual([...signedIn, "authz.require:media.delete", "media.trashFolder", "images.hideMany", "events.emit:media.trashed", "events.relay"]);
    expect(pipelines.get("restoreMedia")).toEqual([...signedIn, "authz.require:media.write", "media.restore", "images.showMany", "events.emit:media.restored", "events.relay"]);
    expect(pipelines.get("listMediaTrash")).toEqual([...signedIn, "authz.require:media.write", "media.listTrash"]);
    expect(pipelines.get("purgeMedia")).toEqual([...signedIn, "authz.require:media.delete", "media.selectTrash", ...purge, "events.relay"]);
    expect(pipelines.get("emptyMediaTrash")).toEqual([...signedIn, "authz.require:media.delete", "media.selectAllTrash", ...purge, "events.relay"]);
    expect(pipelines.get("purgeExpiredMedia")).toEqual(["media.selectExpiredTrash", ...purge]);
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
  it("marks the pages that show a medium on media.updated, media.deleted, media.trashed, media.restored and images.variantsChanged alike", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    const events = config.triggers.filter((t) => "event" in t).map((t) => [(t as { event: string }).event, t.pipeline]);
    expect(events.filter(([, pipeline]) => pipeline === "mediaDependents").map(([event]) => event).sort()).toEqual(["images.variantsChanged", "media.deleted", "media.restored", "media.trashed", "media.updated"]);
  });

  it("wires the image pipelines", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("registerImageSizes")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:images.write", "images.register"]);
    expect(pipelines.get("registerImageSizesBoot")).toEqual(["images.register"]);
    expect(pipelines.get("listImageSizes")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:images.read", "images.listSizes"]);
    expect(pipelines.get("syncImages")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:images.manage", "images.sync"]);
    expect(pipelines.get("pruneImages")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:images.manage", "images.prune"]);
    expect(pipelines.get("imagesStatus")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:images.read", "images.readStatus"]);
    expect(pipelines.get("serveImageVariant")).toEqual(["authn.identifyUser", "authz.require:media.read", "images.serve", "authz.fields:mediaFile?shape=file"]);
    expect(pipelines.get("serveMediaFile")).toEqual(["authn.identifyUser", "authz.require:media.read", "media.serve", "authz.fields:mediaFile?shape=file"]);
    expect(pipelines.get("generateImageVariants")).toEqual(["images.generate"]);
    expect(pipelines.get("resumeImages")).toEqual(["images.resume"]);
  });
  it("sets a media item's framing over PUT /media/:id/framing and answers the item with its variants", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    const routes = config.triggers.filter((t) => "http" in t).map((t) => [(t as { http: string }).http, t.pipeline]);
    expect(routes).toEqual(expect.arrayContaining([["PUT /media/:id/framing", "setMediaFraming"]]));
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("setMediaFraming")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:media.write", "images.setFraming", "images.generate", "media.get", "images.attach", "authz.fields:media?shape=item"]);
  });
  it("keeps the embedded registration pipeline off the http surface", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    expect(config.triggers.filter((t) => t.pipeline === "registerImageSizesBoot")).toEqual([]);
  });
  it("attaches variants to media reads and export, removes on delete", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("getMedia")).toEqual(["authn.identifyUser", "authz.require:media.read", "media.get", "images.attach", "authz.fields:media?shape=item"]);
    expect(pipelines.get("listMedia")).toEqual(["authn.identifyUser", "authz.require:media.read", "media.list", "images.attach", "authz.fields:media?shape=list"]);
    expect(pipelines.get("deleteMedia")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:media.delete", "references.guard:media", "media.remove", "images.remove", "events.emit:media.deleted", "events.relay"]);
    expect(pipelines.get("exportMedia")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:media.manage", "media.export:./data/export", "images.export:./data/export"]);
  });
  it("leaves resolvePage untouched", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("resolvePage")).not.toContain("images.attach");
  });
});

describe("media list reports variant progress", () => {
  it("GET /media?ids= carries variantCounts once an uploaded image's variants have rendered", async () => {
    const { kestrel, dispose } = await bootIsolated();
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const uploaded = await kestrel.run("uploadMedia", {
        trigger,
        headers: bearer(admin.token),
        files: [{ field: "file", filename: "a.jpg", contentType: "image/jpeg", data: TEST_JPEG }],
      });
      expect(uploaded.status).toBe(200);
      const item = boundaryCast<{ id: string }>(uploaded.result, "json");

      const listed = await kestrel.run("listMedia", { trigger, headers: bearer(admin.token), payload: { ids: item.id } });
      expect(listed.status).toBe(200);
      const body = boundaryCast<{ items: { id: string; variantCounts: { done: number; pending: number; error: number; failed: number } }[] }>(listed.result, "json");
      expect(body.items[0]?.variantCounts).toEqual({ done: 5, pending: 0, error: 0, failed: 0 });
    } finally {
      await dispose();
    }
  });
});

describe("media framing", () => {
  it("stores a focus that every reader of the item sees, refuses an invalid one and keeps it through the trash", async () => {
    const { kestrel, dispose } = await bootIsolated();
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const registered = await kestrel.run("registerImageSizes", { trigger, headers: bearer(admin.token), payload: { sizes: [{ name: "hero", width: 1600, height: 900, fit: "cover" }] } });
      expect(registered.status).toBe(200);
      const uploaded = await kestrel.run("uploadMedia", { trigger, headers: bearer(admin.token), files: [{ field: "file", filename: "a.jpg", contentType: "image/jpeg", data: TEST_JPEG }] });
      expect(uploaded.status).toBe(200);
      const { id } = boundaryCast<{ id: string }>(uploaded.result, "json");
      const focus = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };

      expect((await kestrel.run("setMediaFraming", { trigger, params: { id }, payload: { focus } })).status).toBe(401);
      expect((await kestrel.run("setMediaFraming", { trigger, headers: bearer(admin.token), params: { id }, payload: { focus: { x: 2, y: 0, w: 0, h: 0 } } })).status).toBe(400);
      expect((await kestrel.run("setMediaFraming", { trigger, headers: bearer(admin.token), params: { id: "missing" }, payload: { focus } })).status).toBe(404);

      const framed = await kestrel.run("setMediaFraming", { trigger, headers: bearer(admin.token), params: { id }, payload: { focus } });
      expect(framed.status).toBe(200);
      const item = boundaryCast<{ id: string; available: boolean; focus: unknown; framing: { focus: unknown; crops: unknown; ratios: unknown[] } }>(framed.result, "json");
      expect(item).toMatchObject({ id, available: true, focus });
      expect(item.framing).toEqual({ focus, crops: {}, width: 1, height: 1, ratios: [{ key: "16:9", sizes: ["hero"], manual: false, fits: true, crop: null }] });

      const anonymous = await kestrel.run("listMedia", { trigger, payload: { ids: id } });
      expect(anonymous.status).toBe(200);
      const [publicItem] = boundaryCast<{ items: Array<Record<string, unknown>> }>(anonymous.result, "json").items;
      expect(publicItem?.focus).toEqual(focus);
      expect(publicItem).not.toHaveProperty("framing");
      const publicVariants = boundaryCast<Array<Record<string, unknown>>>(publicItem?.variants, "json");
      expect(publicVariants.length).toBeGreaterThan(0);
      for (const variant of publicVariants) expect(Object.keys(variant).sort()).toEqual(["crop", "format", "height", "path", "size", "width"]);
      expect(publicVariants.find((variant) => variant.size === "hero")).toMatchObject({ crop: null });

      expect((await kestrel.run("trashMedia", { trigger, headers: bearer(admin.token), payload: { ids: [id] } })).status).toBe(200);
      expect((await kestrel.run("setMediaFraming", { trigger, headers: bearer(admin.token), params: { id }, payload: { focus: null } })).status).toBe(404);
      expect((await kestrel.run("restoreMedia", { trigger, headers: bearer(admin.token), payload: { ids: [id] } })).status).toBe(200);
      const restored = await kestrel.run("getMedia", { trigger, headers: bearer(admin.token), params: { id } });
      expect(boundaryCast<{ focus: unknown }>(restored.result, "json").focus).toEqual(focus);
    } finally {
      await dispose();
    }
  });
});

describe("one public URL per media file", () => {
  it("serves the original and every variant at the path the item returned, anonymously and without a rewrite", async () => {
    const { kestrel, blobRoot, dispose } = await bootIsolated();
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const uploaded = await kestrel.run("uploadMedia", {
        trigger,
        headers: bearer(admin.token),
        files: [{ field: "file", filename: "a.jpg", contentType: "image/jpeg", data: TEST_JPEG }],
      });
      expect(uploaded.status).toBe(200);
      const uploadedItem = boundaryCast<{ id: string; path: string }>(uploaded.result, "json");
      expect(uploadedItem.path).toBe(`/media/${uploadedItem.id}/a.jpg`);

      const got = await kestrel.run("getMedia", { trigger, headers: bearer(admin.token), params: { id: uploadedItem.id } });
      expect(got.status).toBe(200);
      const item = boundaryCast<{ id: string; path: string; available: boolean; variants: Array<{ path: string }> }>(got.result, "json");
      expect(item.available).toBe(true);
      expect(item.variants.length).toBeGreaterThan(0);

      const name = item.path.split("/").pop()!;
      const served = await kestrel.run("serveMediaFile", { trigger, params: { id: item.id, name } });
      expect(served.status).toBe(200);
      expect(boundaryCast<{ headers?: Record<string, string> }>(served.result, "json").headers?.["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(existsSync(join(blobRoot, "site", "media", item.id, name))).toBe(true);

      for (const variant of item.variants) {
        const file = variant.path.split("/").pop()!;
        const servedVariant = await kestrel.run("serveImageVariant", { trigger, params: { id: item.id, file } });
        expect(servedVariant.status).toBe(200);
        expect(boundaryCast<{ headers?: Record<string, string> }>(servedVariant.result, "json").headers?.["cache-control"]).toBeUndefined();
        expect(existsSync(join(blobRoot, "site", "media", item.id, "variants", file))).toBe(true);
      }

      const anonymousList = await kestrel.run("listMedia", { trigger });
      expect(anonymousList.status).toBe(401);
      const anonymousById = await kestrel.run("listMedia", { trigger, payload: { ids: item.id } });
      expect(anonymousById.status).toBe(200);
      const anonymousFolders = await kestrel.run("listMediaFolders", { trigger });
      expect(anonymousFolders.status).toBe(401);

      const deleted = await kestrel.run("deleteMedia", { trigger, headers: bearer(admin.token), params: { id: item.id } });
      expect(deleted.status).toBe(200);
      const goneOriginal = await kestrel.run("serveMediaFile", { trigger, params: { id: item.id, name } });
      expect(goneOriginal.status).toBe(404);
      expect(existsSync(join(blobRoot, "site", "media", item.id))).toBe(false);
    } finally {
      await dispose();
    }
  });

  it("repairPublicMedia and the nightly syncPublicMedia reconcile the public copies", async () => {
    const { kestrel, dispose } = await bootIsolated();
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      await kestrel.run("uploadMedia", { trigger, headers: bearer(admin.token), files: [{ field: "file", filename: "a.jpg", contentType: "image/jpeg", data: TEST_JPEG }] });
      const repaired = await kestrel.run("repairPublicMedia", { trigger, headers: bearer(admin.token) });
      expect(repaired.status).toBe(200);
      expect(boundaryCast<{ _publicMedia: { written: number }; _publicVariants: { written: number } }>(repaired.result, "json")).toMatchObject({ _publicMedia: expect.any(Object) as object, _publicVariants: expect.any(Object) as object });
      const synced = await kestrel.run("syncPublicMedia", { trigger });
      expect(synced.status).toBe(200);
    } finally {
      await dispose();
    }
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
    expect(pipelines.get("listMigrations")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:migrations.manage", "migrations.list"]);
    expect(pipelines.get("applyMigrations")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:migrations.manage", "migrations.apply"]);
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
    expect(pipelines.get("insightsManifest")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:insights.read", "insights.readManifest"]);
    expect(pipelines.get("insightsStats")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:insights.read", "insights.readStats"]);
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
    expect(pipelines.get("contentModel")).toEqual(["authn.requireUser", "authz.requireRole", "content.describeModel"]);
  });
});

async function bootIsolated(
  withPipelines?: (pipelines: PipelineDefinition[]) => PipelineDefinition[],
  capture?: { persistence?: Persistence },
): Promise<{ kestrel: Awaited<ReturnType<typeof boot>>; blobRoot: string; dispose: () => Promise<void> }> {
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
  const loadedModules = await loadModules(root, isolated);
  const modules = loadedModules.map((mod) => {
    if (capture === undefined || mod.name !== "persistence/sqlite") return mod;
    return defineModule({
      ...mod,
      async setup(config, deps) {
        const real = await mod.setup(config, deps);
        capture.persistence = boundaryCast<Persistence>(real, "host");
        return real;
      },
    });
  });
  const loaded = await loadPipelines(root, "pipelines");
  const pipelines = withPipelines ? withPipelines(loaded) : loaded;
  const kestrel = await boot({ config: isolated, modules, pipelines, root, validateOutput: true });
  await kestrel.start();
  return {
    kestrel,
    blobRoot: join(dataDir, "blobs"),
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

async function pollUntil(check: () => Promise<boolean>, timeoutMs = 2000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("pollUntil: timed out waiting for the condition");
}

async function bootWithQueue(mode: "queue" | "direct" = "queue"): Promise<{
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
      if (mode === "queue" && m.use === "@michaelthielemann/kestrel-events-direct") return { use: "@michaelthielemann/kestrel-events-queue", config: { maxAttempts: 1, relayMs: 5000, relayPipelines: ["publishPage", "unpublishPage"] } };
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
  const pipelines = [
    ...(await loadPipelines(root, "pipelines")),
    ...(mode === "queue"
      ? [
          definePipeline({ name: "listDeadEvents", steps: ["events.listDead"] }),
          definePipeline({ name: "retryDeadEvent", steps: ["events.retryDead:one"] }),
          definePipeline({ name: "queueStatus", steps: ["events.readQueueStatus"] }),
        ]
      : []),
  ];
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

const withSilentDelete = (pipelines: PipelineDefinition[]): PipelineDefinition[] => [...pipelines, definePipeline({ name: "deleteUserSilently", steps: ["authn.requireUser", "authz.requireRole", "authn.deleteUser"] })];

async function deleteSilently(kestrel: Instance, admin: Session, id: string): Promise<void> {
  expect((await kestrel.run("deleteUserSilently", { trigger, headers: bearer(admin.token), params: { id } })).status).toBe(200);
}

async function failedPipelines(kestrel: Instance, admin: Session): Promise<string[]> {
  const stats = await kestrel.run("insightsStats", { trigger, headers: bearer(admin.token) });
  expect(stats.status).toBe(200);
  return boundaryCast<{ recentFailures: { pipeline: string }[] }>(stats.result, "json").recentFailures.map((failure) => failure.pipeline);
}

describe("user pipelines validate role names", () => {
  it("declares authz.validateRoles:roles right after authz.require:users.manage on create and update", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("createUser")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:users.manage", "authz.validateRoles:roles", "authn.createUser", "events.emit:user.created", "events.relay"]);
    expect(pipelines.get("updateUser")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:users.manage", "authz.validateRoles:roles", "authn.updateUser", "events.emit:user.updated", "events.relay"]);
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
    expect(events).toEqual(expect.arrayContaining([["user.deleted", "reassignRevisionAuthor"], ["user.deleted", "anonymizeAuditUser"], ["user.auditAnonymizeRetried", "auditUsers"], ["user.revisionsReassignRetried", "auditUsers"]]));
    const routes = config.triggers.filter((t) => "http" in t).map((t) => [(t as { http: string }).http, t.pipeline]);
    expect(routes).toEqual(
      expect.arrayContaining([
        ["POST /admin/users/:id/revisions/reassign", "retryReassignRevisionAuthor"],
        ["POST /admin/users/:id/audit/anonymize", "retryAnonymizeAuditUser"],
      ]),
    );
    expect(config.triggers.filter((t) => "cron" in t).map((t) => t.pipeline)).toContain("pruneAudit");

    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("deleteUser")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:users.manage", "authn.deleteUser", "events.emit:user.deleted?with=result", "events.relay"]);
    expect(pipelines.get("reassignRevisionAuthor")).toEqual(["authn.verifyUser:result.reassignTo", "revisions.reassignAuthor"]);
    expect(pipelines.get("anonymizeAuditUser")).toEqual(["audit.anonymize"]);
    expect(pipelines.get("retryReassignRevisionAuthor")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:users.manage", "authn.requireAbsentUser", "authn.verifyUser:reassignTo", "revisions.reassignAuthor", "events.emit:user.revisionsReassignRetried", "events.relay"]);
    expect(pipelines.get("auditUsers")).toEqual(["audit.record"]);
    expect(pipelines.get("retryAnonymizeAuditUser")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:users.manage", "authn.requireAbsentUser", "audit.anonymize", "events.emit:user.auditAnonymizeRetried", "events.relay"]);
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
      expect(retry.result).toMatchObject({ entries: 0 });
      expect(await failedPipelines(kestrel, admin)).toEqual(["deleteUser"]);
    } finally {
      await dispose();
    }
  });

  it("retryReassignRevisionAuthor rejects an unknown or inactive target and leaves revisions unchanged", async () => {
    const { kestrel, dispose } = await bootIsolated(withSilentDelete);
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const editor = await createEditor(kestrel, admin, "erin");
      const editorSession = await login(kestrel, "erin", "long-enough");
      const pageId = await createPage(kestrel, editorSession, "erin-page");
      const inactive = await createEditor(kestrel, admin, "fay");
      await kestrel.run("deactivateUser", { trigger, headers: bearer(admin.token), params: { id: inactive.id } });
      await deleteSilently(kestrel, admin, editor.id);

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
    const { kestrel, dispose } = await bootIsolated(withSilentDelete);
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const editor = await createEditor(kestrel, admin, "gus");
      const editorSession = await login(kestrel, "gus", "long-enough");
      const pageId = await createPage(kestrel, editorSession, "gus-page");
      const target = await createEditor(kestrel, admin, "hana");
      await deleteSilently(kestrel, admin, editor.id);

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
    const { kestrel, dispose } = await bootIsolated(withSilentDelete);
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const editor = await createEditor(kestrel, admin, "ivy");
      const target = await createEditor(kestrel, admin, "jill");
      await deleteSilently(kestrel, admin, editor.id);

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
    const { kestrel, dispose } = await bootIsolated(withSilentDelete);
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const editor = await createEditor(kestrel, admin, "kim");
      await deleteSilently(kestrel, admin, editor.id);

      const wrongType = await kestrel.run("retryReassignRevisionAuthor", { trigger, headers: bearer(admin.token), params: { id: editor.id }, payload: { reassignTo: 7 }, body: { reassignTo: 7 } });
      expect(wrongType.status).toBe(400);

      const noId = await kestrel.run("retryReassignRevisionAuthor", { trigger, headers: bearer(admin.token), params: { id: editor.id }, payload: { reassignTo: { name: "no-id" } }, body: { reassignTo: { name: "no-id" } } });
      expect(noId.status).toBe(400);
    } finally {
      await dispose();
    }
  });

  it("a reassignment whose target no longer exists fails visibly and leaves the instance healthy", async () => {
    const { kestrel, dispose } = await bootWithQueue();
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const editor = await createEditor(kestrel, admin, "liam");
      const target = await createEditor(kestrel, admin, "maya");

      const deleted = await kestrel.run("deleteUser", { trigger, headers: bearer(admin.token), params: { id: editor.id }, payload: { reassignTo: target.id }, body: { reassignTo: target.id } });
      expect(deleted.status).toBe(200);

      const targetDeleted = await kestrel.run("deleteUser", { trigger, headers: bearer(admin.token), params: { id: target.id } });
      expect(targetDeleted.status).toBe(200);

      await pollUntil(async () => {
        const status = await kestrel.run("queueStatus", { trigger, headers: bearer(admin.token) });
        const counts = boundaryCast<{ pending: number; running: number }>(status.result, "json");
        return counts.pending === 0 && counts.running === 0;
      });

      expect(await failedPipelines(kestrel, admin)).toContain("reassignRevisionAuthor");
      const status = await kestrel.run("eventsDeliveryStatus", { trigger, headers: bearer(admin.token) });
      expect(status.status).toBe(200);
      expect(boundaryCast<{ dead: number }>(status.result, "json").dead).toBe(1);
      expect(kestrel.health().ok).toBe(true);
    } finally {
      await dispose();
    }
  });
});

describe("events delivery status wiring", () => {
  it("guards the route with a login and system.manage", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    const routes = config.triggers.filter((t) => "http" in t).map((t) => [(t as { http: string }).http, t.pipeline]);
    expect(routes).toContainEqual(["GET /admin/events/delivery", "eventsDeliveryStatus"]);
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, pipelineSteps(p.steps)]));
    expect(pipelines.get("eventsDeliveryStatus")).toEqual(["authn.requireUser", "authz.requireRole", "authz.require:system.manage", "events.readDeliveryStatus"]);
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

      await pollUntil(async () => {
        const dead2 = await kestrel.run("listDeadEvents", { trigger, headers: bearer(admin.token) });
        const stillDead = boundaryCast<{ items: { id: string }[] }>(dead2.result, "json").items.some((d) => d.id === deadRow!.id);
        const status = await kestrel.run("queueStatus", { trigger, headers: bearer(admin.token) });
        const counts = boundaryCast<{ pending: number; running: number }>(status.result, "json");
        return !stillDead && counts.pending === 0 && counts.running === 0;
      });

      expect(derivedTouches(calls)).toBe(touchesBeforeRetry);
    } finally {
      await dispose();
    }
  });
});

describe("events/queue relayPipelines: keeps a heavy subscriber off the request", () => {
  it("login reports auditAuth queued instead of delivering it inline, and the worker delivers it right after", async () => {
    const { kestrel, dispose } = await bootWithQueue();
    try {
      const logged = await kestrel.run("login", { trigger, payload: { username: "admin", password: "kestrel-demo" } });
      expect(logged.status).toBe(200);
      const body = boundaryCast<{ _events?: { status: string; pipelines: { pipeline: string; status: string }[] } }>(logged.result, "json");
      expect(body._events?.status).toBe("pending");
      expect(body._events?.pipelines).toContainEqual(expect.objectContaining({ pipeline: "auditAuth", status: "queued" }));

      await pollUntil(async () => {
        const status = await kestrel.run("queueStatus", { trigger });
        const counts = boundaryCast<{ pending: number; running: number }>(status.result, "json");
        return counts.pending === 0 && counts.running === 0;
      });
    } finally {
      await dispose();
    }
  });
});

describe("events/direct relay: a forced delivery.publish failure through POST /pages", () => {
  it("answers 200 (not 500) with _events.status \"error\"; the write is not rolled back", async () => {
    const { kestrel, dispose, armStatusFailureOnce } = await bootWithQueue("direct");
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");

      armStatusFailureOnce();
      const created = await kestrel.run("createPage", {
        trigger,
        headers: bearer(admin.token),
        payload: { slug: "direct-relay", title: "A", status: "draft" },
        body: { slug: "direct-relay", title: "A", status: "draft" },
      });
      expect(created.status).toBe(200);
      const body = boundaryCast<{ id: string; _events?: { status: string; pipelines: { pipeline: string; status: string; dead: boolean }[] } }>(created.result, "json");
      expect(body._events?.status).toBe("error");
      expect(body._events?.pipelines).toContainEqual(expect.objectContaining({ pipeline: "publishPage", status: "error", dead: true }));

      const read = await kestrel.run("readAnyPage", { trigger, headers: bearer(admin.token), params: { id: body.id } });
      expect(read.status).toBe(200);
      const revisions = await revisionsOf(kestrel, admin, body.id);
      expect(revisions.total).toBe(1);
    } finally {
      await dispose();
    }
  });
});

interface OpenApiSchemaDoc {
  paths: Record<string, Record<string, { responses: Record<string, { content: { "application/json": { schema: Record<string, unknown> } } }> }>>;
  components: { schemas: Record<string, Record<string, unknown>> };
}

describe("terminal output shapes at the HTTP boundary", () => {
  it("a redirect hit matches the documented 200 of GET /site/{path}", async () => {
    const { kestrel, dispose } = await bootIsolated();
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const rules = [{ from: "/alt", to: "/neu" }];
      const set = await kestrel.run("setRedirects", { trigger, headers: bearer(admin.token), payload: { rules }, body: { rules } });
      expect(set.status).toBe(200);

      const hit = await kestrel.run("resolvePage", { trigger, params: { path: "alt" } });
      expect(hit.status).toBe(200);
      expect(hit.result).toEqual({ redirect: { to: "/neu", status: 301 } });

      const openapi = boundaryCast<OpenApiSchemaDoc>(JSON.parse(readFileSync(join(root, "openapi.json"), "utf8")), "json");
      expect(openapi.paths["/site/{path}"]?.get?.responses["200"]?.content["application/json"].schema).toEqual({ anyOf: [{ $ref: "#/components/schemas/resolvePage" }, { $ref: "#/components/schemas/resolvePage.anonymous" }] });
      for (const name of ["resolvePage", "resolvePage.anonymous"]) {
        const schema = openapi.components.schemas[name];
        if (schema === undefined) throw new Error(`missing component ${name}`);
        expect(validateSchema(schema, hit.result), name).toEqual([]);
        const pageBranchOnly = boundaryCast<{ anyOf: Record<string, unknown>[] }>(schema, "json").anyOf[0];
        if (pageBranchOnly === undefined) throw new Error(`missing the page branch of ${name}`);
        expect(validateSchema(pageBranchOnly, hit.result), name).not.toEqual([]);
      }
    } finally {
      await dispose();
    }
  });

  it("the published continuing branch of uploadMedia's 200 requires the item or list fields, not _events alone", async () => {
    const { kestrel, dispose } = await bootIsolated();
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const uploaded = await kestrel.run("uploadMedia", {
        trigger,
        headers: bearer(admin.token),
        files: [{ field: "file", filename: "acceptance.png", contentType: "image/png", data: new Uint8Array([1, 2, 3, 4]) }],
      });
      expect(uploaded.status).toBe(200);
      const body = boundaryCast<{ filename?: string; _events?: { status: string } }>(uploaded.result, "json");
      expect(body.filename).toBe("acceptance.png");
      expect(body._events).toBeDefined();

      const openapi = boundaryCast<OpenApiSchemaDoc>(JSON.parse(readFileSync(join(root, "openapi.json"), "utf8")), "json");
      const schema = openapi.paths["/media"]?.post?.responses["200"]?.content["application/json"].schema;
      if (schema === undefined) throw new Error("missing schema for POST /media 200");
      expect(validateSchema(schema, uploaded.result)).toEqual([]);

      const continuingBranch = boundaryCast<{ anyOf: Record<string, unknown>[] }>(schema, "json").anyOf[0];
      if (continuingBranch === undefined) throw new Error("missing the continuing branch of the anyOf");
      expect(validateSchema(continuingBranch, { _events: body._events })).not.toEqual([]);
    } finally {
      await dispose();
    }
  });
});

describe("GET /site/*path never leaks a draft to an anonymous visitor", () => {
  it("never fills a field from a default locale that is itself a draft, and drops a draft locale from _translations", async () => {
    const { kestrel, dispose } = await bootIsolated();
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const deFields = { slug: "versteckt", title: "Versteckt", status: "draft", seo: { title: "DE SEO" } };
      const created = await kestrel.run("createPage", { trigger, headers: bearer(admin.token), payload: deFields, body: deFields });
      expect(created.status).toBe(200);
      const { id } = boundaryCast<{ id: string }>(created.result, "json");

      const enFields = { slug: "hidden", title: "Hidden", status: "published" };
      const updated = await kestrel.run("updatePage", { trigger, headers: bearer(admin.token), params: { id, locale: "en" }, payload: enFields, body: enFields });
      expect(updated.status).toBe(200);

      const hit = await kestrel.run("resolvePage", { trigger, params: { path: "en/hidden" } });
      expect(hit.status).toBe(200);
      const doc = boundaryCast<{ seo?: unknown; _translations?: Record<string, boolean> }>(hit.result, "json");
      expect(doc.seo ?? null).toBeNull();
      expect(doc._translations).toEqual({ de: false, en: true });
    } finally {
      await dispose();
    }
  });

  it("never serves an unpublished requested locale through another locale's content", async () => {
    const { kestrel, dispose } = await bootIsolated();
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const deFields = { slug: "sichtbar", title: "Sichtbar", status: "published", seo: { title: "DE SEO" } };
      const created = await kestrel.run("createPage", { trigger, headers: bearer(admin.token), payload: deFields, body: deFields });
      expect(created.status).toBe(200);
      const { id } = boundaryCast<{ id: string }>(created.result, "json");

      const enFields = { slug: "visible", title: "Visible", status: "draft" };
      const updated = await kestrel.run("updatePage", { trigger, headers: bearer(admin.token), params: { id, locale: "en" }, payload: enFields, body: enFields });
      expect(updated.status).toBe(200);

      const hit = await kestrel.run("resolvePage", { trigger, params: { path: "en/visible" } });
      expect(hit.status).toBe(404);
    } finally {
      await dispose();
    }
  });
});

describe("GET /pages and GET /pages/:id never list a draft locale in _translations", () => {
  it("narrows _translations to status=published, the same rule GET /site/*path follows", async () => {
    const { kestrel, dispose } = await bootIsolated();
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const deFields = { slug: "oeffentlich", title: "Oeffentlich", status: "published" };
      const created = await kestrel.run("createPage", { trigger, headers: bearer(admin.token), payload: deFields, body: deFields });
      expect(created.status).toBe(200);
      const { id } = boundaryCast<{ id: string }>(created.result, "json");

      const enFields = { slug: "secret-en", title: "Secret EN", status: "draft" };
      const updated = await kestrel.run("updatePage", { trigger, headers: bearer(admin.token), params: { id, locale: "en" }, payload: enFields, body: enFields });
      expect(updated.status).toBe(200);

      const listed = await kestrel.run("listPages", { trigger });
      expect(listed.status).toBe(200);
      const list = boundaryCast<{ items: { id: string; _translations?: Record<string, boolean> }[] }>(listed.result, "json");
      expect(list.items.find((p) => p.id === id)?._translations).toEqual({ de: true, en: false });

      const read = await kestrel.run("readPage", { trigger, params: { id } });
      expect(read.status).toBe(200);
      const doc = boundaryCast<{ _translations?: Record<string, boolean> }>(read.result, "json");
      expect(doc._translations).toEqual({ de: true, en: false });
    } finally {
      await dispose();
    }
  });
});

describe("the last-admin guard holds under concurrent requests", () => {
  async function secondAdmin(kestrel: Instance, admin: Session): Promise<{ id: string; session: Session }> {
    const created = await kestrel.run("createUser", { trigger, headers: bearer(admin.token), payload: { username: "ada", password: "long-enough", roles: ["admin"] } });
    expect(created.status).toBe(200);
    const { id } = boundaryCast<{ id: string }>(created.result, "json");
    return { id, session: await login(kestrel, "ada", "long-enough") };
  }

  it("wraps the user-changing steps of updateUser, deactivateUser and deleteUser in an atomic group", async () => {
    const loaded = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, p.steps]));
    expect(loaded.get("updateUser")).toContainEqual({ atomic: ["authn.updateUser"] });
    expect(loaded.get("deactivateUser")).toContainEqual({ atomic: ["authn.deactivateUser"] });
    expect(loaded.get("deleteUser")).toContainEqual({ atomic: ["authn.deleteUser"] });
  });

  it("lets exactly one of two admins deactivate the other", async () => {
    const { kestrel, dispose } = await bootIsolated();
    try {
      const first = await login(kestrel, "admin", "kestrel-demo");
      const second = await secondAdmin(kestrel, first);
      const [a, b] = await Promise.all([
        kestrel.run("deactivateUser", { trigger, headers: bearer(first.token), params: { id: second.id } }),
        kestrel.run("deactivateUser", { trigger, headers: bearer(second.session.token), params: { id: first.identity.id } }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect([a.code, b.code].filter((code) => code !== undefined)).toEqual(["LAST_ADMIN"]);
      const users = boundaryCast<{ active: boolean }[]>((await kestrel.run("listUsers", { trigger, headers: bearer(a.status === 200 ? first.token : second.session.token) })).result, "json");
      expect(users.filter((user) => user.active)).toHaveLength(1);
    } finally {
      await dispose();
    }
  });

  it("lets exactly one of two admins strip the other of the admin role", async () => {
    const { kestrel, dispose } = await bootIsolated();
    try {
      const first = await login(kestrel, "admin", "kestrel-demo");
      const second = await secondAdmin(kestrel, first);
      const strip = { roles: ["editor"] };
      const [a, b] = await Promise.all([
        kestrel.run("updateUser", { trigger, headers: bearer(first.token), params: { id: second.id }, payload: strip, body: strip }),
        kestrel.run("updateUser", { trigger, headers: bearer(second.session.token), params: { id: first.identity.id }, payload: strip, body: strip }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect([a.code, b.code].filter((code) => code !== undefined)).toEqual(["LAST_ADMIN"]);
    } finally {
      await dispose();
    }
  });

  it("lets exactly one of two admins delete the other", async () => {
    const { kestrel, dispose } = await bootIsolated();
    try {
      const first = await login(kestrel, "admin", "kestrel-demo");
      const second = await secondAdmin(kestrel, first);
      const [a, b] = await Promise.all([
        kestrel.run("deleteUser", { trigger, headers: bearer(first.token), params: { id: second.id } }),
        kestrel.run("deleteUser", { trigger, headers: bearer(second.session.token), params: { id: first.identity.id } }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
    } finally {
      await dispose();
    }
  });
});

describe("the retry routes act only on the id of a deleted user", () => {
  interface AuditRow {
    event: string;
    identityId: string | null;
    params: Record<string, string>;
  }

  async function auditRows(capture: { persistence?: Persistence }): Promise<AuditRow[]> {
    const found = await capture.persistence!.findMany<AuditRow & { id: string }>("audit_entries", {}, { sort: { at: "asc" } });
    expect(found.ok).toBe(true);
    return found.ok ? found.value.items.map(({ event, identityId, params }) => ({ event, identityId, params })) : [];
  }

  it("refuses an active or deactivated user with 409 and leaves audit entries and revisions untouched", async () => {
    const capture: { persistence?: Persistence } = {};
    const { kestrel, dispose } = await bootIsolated(undefined, capture);
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const editor = await createEditor(kestrel, admin, "gina");
      const editorSession = await login(kestrel, "gina", "long-enough");
      const pageId = await createPage(kestrel, editorSession, "gina-page");
      const sleeper = await createEditor(kestrel, admin, "hal");
      await kestrel.run("deactivateUser", { trigger, headers: bearer(admin.token), params: { id: sleeper.id } });
      const before = await auditRows(capture);

      for (const target of [editor.id, sleeper.id, admin.identity.id]) {
        const anonymize = await kestrel.run("retryAnonymizeAuditUser", { trigger, headers: bearer(admin.token), params: { id: target } });
        expect(anonymize).toMatchObject({ status: 409, code: "CONFLICT" });
        const reassignBody = { reassignTo: admin.identity.id };
        const reassign = await kestrel.run("retryReassignRevisionAuthor", { trigger, headers: bearer(admin.token), params: { id: target }, payload: reassignBody, body: reassignBody });
        expect(reassign).toMatchObject({ status: 409, code: "CONFLICT" });
      }

      expect(await auditRows(capture)).toEqual(before);
      const revisions = await revisionsOf(kestrel, admin, pageId);
      expect(revisions.items[0]?.author).toEqual({ id: editor.id, name: "gina" });
    } finally {
      await dispose();
    }
  });

  it("runs for a deleted user and records who called it", async () => {
    const capture: { persistence?: Persistence } = {};
    const { kestrel, dispose } = await bootIsolated(undefined, capture);
    try {
      const admin = await login(kestrel, "admin", "kestrel-demo");
      const editor = await createEditor(kestrel, admin, "ines");
      const deleted = await kestrel.run("deleteUser", { trigger, headers: bearer(admin.token), params: { id: editor.id } });
      expect(deleted.status).toBe(200);

      const anonymize = await kestrel.run("retryAnonymizeAuditUser", { trigger, headers: bearer(admin.token), params: { id: editor.id } });
      expect(anonymize.status).toBe(200);
      const reassignBody = { reassignTo: admin.identity.id };
      const reassign = await kestrel.run("retryReassignRevisionAuthor", { trigger, headers: bearer(admin.token), params: { id: editor.id }, payload: reassignBody, body: reassignBody });
      expect(reassign.status).toBe(200);

      const rows = await auditRows(capture);
      expect(rows.filter((row) => row.event === "user.auditAnonymizeRetried")).toEqual([{ event: "user.auditAnonymizeRetried", identityId: admin.identity.id, params: { id: editor.id } }]);
      expect(rows.filter((row) => row.event === "user.revisionsReassignRetried")).toEqual([{ event: "user.revisionsReassignRetried", identityId: admin.identity.id, params: { id: editor.id } }]);
    } finally {
      await dispose();
    }
  });
});
