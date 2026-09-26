import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boot } from "@michaelthielemann/kestrel";
import contentModule from "@michaelthielemann/kestrel-content-default";
import eventsDirect from "@michaelthielemann/kestrel-events-direct";
import eventsInmemory from "@michaelthielemann/kestrel-events-inmemory";
import persistenceSqlite from "@michaelthielemann/kestrel-persistence-sqlite";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import siteModule from "./module.ts";

const LOCALES = ["de", "en", "fr", "it", "es"];
const PAGES = 200;

const noop = defineModule({ name: "test/noop", provides: [], requires: [], configSchema: z.object({}).strict(), async setup() {} });

describe("site/default routed paths on SQLite at 200 pages in 5 locales", () => {
  it("a save's atomic group and a full rebuild stay well inside the default scope timeout", async () => {
    const kestrel = await boot({
      config: {
        modules: [
          { use: "persistence", config: { file: ":memory:" } },
          {
            use: "content",
            config: {
              locales: LOCALES,
              defaultLocale: "de",
              types: { pages: { kind: "multi", fields: { slug: { type: "slug", required: true, localized: true }, title: { type: "text", required: true, localized: true }, status: { type: "enum", options: ["draft", "published"], localized: true } } } },
            },
          },
          { use: "site", config: { routes: { pages: { home: "home", liveWhen: { status: "published" } } } } },
          { use: "events", config: {} },
          { use: "direct", config: {} },
          { use: "noop", config: {} },
        ],
        triggers: [],
        http: { port: 0 },
      },
      modules: [persistenceSqlite, contentModule, siteModule, eventsInmemory, eventsDirect, noop],
      pipelines: [
        definePipeline({ name: "createPage", steps: [{ atomic: ["content.create:pages", "site.indexPath:pages"] }, "site.announcePaths"] }),
        definePipeline({ name: "updatePage", steps: [{ atomic: ["content.update:pages", "site.indexPath:pages"] }, "site.announcePaths"] }),
        definePipeline({ name: "rebuildPaths", steps: ["site.planRebuild", { atomic: ["site.applyRebuild"] }, "site.announcePaths"] }),
      ],
      logger: silentLogger,
    });
    const trigger = { kind: "http", name: "timing" } as const;
    const ids: string[] = [];
    for (let i = 0; i < PAGES; i++) {
      const created = await kestrel.run("createPage", { trigger, payload: { slug: `seite-${i}`, title: `Seite ${i}`, status: "published" } });
      const id = boundaryCast<{ id: string }>(created.result, "json").id;
      ids.push(id);
      for (const locale of LOCALES.slice(1)) {
        await kestrel.run("updatePage", { trigger, params: { id }, payload: { locale, slug: `page-${i}`, title: `Page ${i}`, status: "published" } });
      }
    }
    const saves: number[] = [];
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      const res = await kestrel.run("updatePage", { trigger, params: { id: ids[i]! }, payload: { slug: `umbenannt-${i}` } });
      saves.push(performance.now() - started);
      expect(res.status).toBe(200);
    }
    saves.sort((a, b) => a - b);
    const started = performance.now();
    const rebuilt = await kestrel.run("rebuildPaths", { trigger });
    const rebuild = performance.now() - started;
    expect(rebuilt.result).toEqual({ indexed: PAGES, conflicts: [] });
    expect(saves[Math.floor(saves.length / 2)]!).toBeLessThan(250);
    expect(rebuild).toBeLessThan(5_000);
    await kestrel.stop();
  }, 120_000);
});
