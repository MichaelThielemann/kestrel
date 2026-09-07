import { describe, it, expect } from "vitest";
import { boot, matchRoute } from "@michaelthielemann/kestrel";
import config from "./kestrel.config.ts";
import modules from "./modules.ts";
import countPages from "./pipelines/countPages.ts";
import createPage from "./pipelines/createPage.ts";
import listMigrations from "./pipelines/listMigrations.ts";
import login from "./pipelines/login.ts";
import resolvePage from "./pipelines/resolvePage.ts";

// The hand-wired examples pair config.modules with the modules array positionally, so a module added
// to the config without its import fails only at boot - which nothing but this test would notice.
describe("examples/embedded boots", () => {
  it("boots the config with its hand-wired modules, resolves a page and stops", async () => {
    const kestrel = await boot({ config, modules, pipelines: [login, createPage, resolvePage, countPages, listMigrations] });
    await kestrel.start();
    try {
      const migrations = await kestrel.run("listMigrations", { trigger: { kind: "event", name: "test" } });
      expect(migrations.status).toBe(200);
      expect(migrations.result).toMatchObject({ pending: [] });
      expect((migrations.result as { applied: { id: string }[] }).applied.map((entry) => entry.id)).toContain("2026-09-03-trim-title");

      const anonymous = await kestrel.run("createPage", {
        trigger: { kind: "http", name: "test" },
        payload: { slug: "home", title: "Startseite", status: "published" },
      });
      expect(anonymous.status).toBe(401);

      const session = await kestrel.run("login", {
        trigger: { kind: "http", name: "test" },
        payload: { username: "editor", password: "kestrel-demo" },
      });
      expect(session.status).toBe(200);
      const headers = { authorization: `Bearer ${(session.result as { token: string }).token}` };

      const created = await kestrel.run("createPage", {
        trigger: { kind: "http", name: "test" },
        headers,
        payload: { slug: "home", title: "Startseite", status: "published" },
      });
      expect(created.status).toBe(200);

      const match = matchRoute(kestrel.triggers.http, "GET", "/site/");
      expect(match).not.toBeNull();
      const page = await kestrel.run(match!.route.pipeline, {
        trigger: { kind: "http", name: "GET /site/" },
        params: match!.params,
        headers: {},
      });
      expect(page.status).toBe(200);
      expect(page.result).toMatchObject({ slug: "home", title: "Startseite" });
    } finally {
      await kestrel.stop();
    }
  });
});
