import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { loadConfig, loadPipelines } from "@michaelthielemann/kestrel/load";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";

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
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, p.steps]));
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
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, p.steps]));
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
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, p.steps]));
    expect(pipelines.get("deletePageTranslation")).toEqual(["authn.requireUser", "authz.require:pages.write", "content.removeTranslation:pages", "references.index:pages", "links.extract:pages", "delivery.publish:pages", "delivery.exportLlms", "events.emit:page.translationRemoved"]);
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
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, p.steps]));
    for (const [name, after] of [["createPage", "delivery.publish:pages"], ["updatePage", "delivery.publish:pages"], ["deletePage", "delivery.unpublish:pages"], ["setSettings", "content.set:settings"], ["publishAllPages", "redirects.export"]] as const) {
      const steps = pipelines.get(name)!;
      expect(steps.indexOf("delivery.exportLlms"), name).toBe(steps.indexOf(after) + 1);
    }
  });
});

describe("write pipelines validate their payload", () => {
  it("registers a schema for the settings navigation", async () => {
    const config = await loadConfig(join(root, "kestrel.config.ts"));
    const validate = boundaryCast<{ schemas: Record<string, string> }>(config.modules.find((m) => m.use === "@michaelthielemann/kestrel-validate-jsonschema")!.config, "json");
    expect(validate.schemas["settings.navigation"]).toBe("./schemas/settings.navigation.json");
  });

  it("checks the navigation before writing settings", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, p.steps]));
    expect(pipelines.get("setSettings")).toEqual([
      "authn.requireUser",
      "authz.require:settings.write",
      "validate.check:settings.navigation",
      "content.set:settings",
      "delivery.exportLlms",
    ]);
  });

  // The media texts are plain text: media.update checks length and control characters itself,
  // sanitizing them through the HTML allowlist would rewrite legitimate text like "5 < 6".
  it("leaves the media texts to the plain-text check in media.update", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, p.steps]));
    expect(pipelines.get("updateMedia")).toEqual(["authn.requireUser", "authz.require:media.write", "media.update", "events.emit:media.updated"]);
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
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, p.steps]));
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
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, p.steps]));
    expect(pipelines.get("createMediaFolder")).toEqual(["authn.requireUser", "authz.require:media.write", "media.createFolder"]);
    expect(pipelines.get("renameMediaFolder")).toEqual(["authn.requireUser", "authz.require:media.write", "media.renameFolder"]);
    expect(pipelines.get("deleteMediaFolder")).toEqual(["authn.requireUser", "authz.require:media.delete", "media.folderItems", "references.guardAll:media", "images.removeMany", "media.removeFolder"]);
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
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, p.steps]));
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
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, p.steps]));
    expect(pipelines.get("getMedia")).toEqual(["authn.identifyUser", "authz.require:media.read", "media.get", "images.attach"]);
    expect(pipelines.get("listMedia")).toEqual(["authn.identifyUser", "authz.require:media.read", "media.list", "images.attach"]);
    expect(pipelines.get("deleteMedia")).toEqual(["authn.requireUser", "authz.require:media.delete", "references.guard:media", "images.remove", "media.remove", "events.emit:media.deleted"]);
    expect(pipelines.get("exportMedia")).toEqual(["authn.requireUser", "authz.require:media.manage", "media.export:./data/export", "images.export:./data/export"]);
  });
  it("leaves resolvePage untouched", async () => {
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, p.steps]));
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
    const pipelines = new Map((await loadPipelines(root, "pipelines")).map((p) => [p.name, p.steps]));
    expect(pipelines.get("listMigrations")).toEqual(["authn.requireUser", "authz.require:migrations.manage", "migrations.list"]);
    expect(pipelines.get("applyMigrations")).toEqual(["authn.requireUser", "authz.require:migrations.manage", "migrations.apply"]);
  });
});
