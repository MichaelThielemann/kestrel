import { describe, expect, it } from "vitest";
import { boot, type Kestrel } from "@michaelthielemann/kestrel";
import contentModule from "@michaelthielemann/kestrel-content-default";
import type { ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import eventsDirect from "@michaelthielemann/kestrel-events-direct";
import eventsInmemory from "@michaelthielemann/kestrel-events-inmemory";
import persistenceSqlite from "@michaelthielemann/kestrel-persistence-sqlite";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { definePipeline, type PipelineDefinition } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger, type Logger, type StepLog } from "@michaelthielemann/kestrel/logger";
import siteModule from "./module.ts";

function model(locales: string[]): ContentModel {
  const localized = { slug: { type: "slug" as const, required: true, localized: true }, title: { type: "text" as const, required: true, localized: true }, status: { type: "enum" as const, options: ["draft", "published"], localized: true } };
  return {
    locales,
    defaultLocale: locales[0]!,
    types: {
      pages: { kind: "multi", fields: { ...localized, parent: { type: "ref", to: "pages" } } },
      posts: { kind: "multi", fields: localized },
      settings: { kind: "single", fields: { mounts: { type: "json" } } },
    },
  };
}

const SITE = { routes: { pages: { home: "home", liveWhen: { status: "published" }, parentField: "parent" }, posts: { liveWhen: { status: "published" }, mount: true } }, mounts: { type: "settings", field: "mounts" } };

const PIPELINES = [
  definePipeline({ name: "createPage", steps: [{ atomic: ["content.create:pages", "site.indexPath:pages"] }, "site.announcePaths"] }),
  definePipeline({ name: "updatePage", steps: [{ atomic: ["content.update:pages", "site.indexPath:pages"] }, "site.announcePaths"] }),
  definePipeline({ name: "createPost", steps: [{ atomic: ["content.create:posts", "site.indexPath:posts"] }, "site.announcePaths"] }),
  definePipeline({ name: "setSettings", steps: [{ atomic: ["content.set:settings", "site.indexMounts"] }, "site.announcePaths"] }),
  definePipeline({ name: "resolvePage", steps: ["site.route:pages", "site.resolve:pages?home=home&status=published&fallback=true"] }),
  definePipeline({ name: "resolvePost", steps: ["site.resolve:posts?status=published&fallback=true"] }),
];

async function bootMounted(options: { locales?: string[]; pipelines?: PipelineDefinition[]; logger?: Logger } = {}): Promise<Kestrel> {
  return boot({
    config: {
      modules: [
        { use: "persistence", config: { file: ":memory:" } },
        { use: "content", config: model(options.locales ?? ["de", "en"]) },
        { use: "site", config: SITE },
        { use: "events", config: {} },
        { use: "direct", config: {} },
      ],
      triggers: [],
      http: { port: 0 },
    },
    modules: [persistenceSqlite, contentModule, siteModule, eventsInmemory, eventsDirect],
    pipelines: options.pipelines ?? PIPELINES,
    logger: options.logger ?? silentLogger,
  });
}

const trigger = { kind: "http", name: "test" } as const;
const idOf = (result: unknown): string => boundaryCast<{ id: string }>(result, "json").id;

describe("site/default mounted collections in pipelines", () => {
  it("a settings write without site.indexMounts ending its group fails boot", async () => {
    await expect(bootMounted({ pipelines: [definePipeline({ name: "setSettings", steps: [{ atomic: ["content.set:settings"] }] })] })).rejects.toThrow(/content.set:settings must run in an atomic group that ends with site.indexMounts/);
  });

  it("site.route:pages hands a reachable document of another collection over with its type, and nothing else", async () => {
    const kestrel = await bootMounted();
    const blog = idOf((await kestrel.run("createPage", { trigger, payload: { slug: "blog", title: "Blog", status: "published" } })).result);
    await kestrel.run("createPost", { trigger, payload: { slug: "hallo", title: "Hallo", status: "published" } });
    await kestrel.run("createPost", { trigger, payload: { slug: "entwurf", title: "Entwurf", status: "draft" } });
    expect((await kestrel.run("setSettings", { trigger, payload: { mounts: { posts: blog } } })).status).toBe(200);
    expect((await kestrel.run("resolvePage", { trigger, params: { path: "blog/hallo" } })).result).toEqual({ route: { type: "posts" } });
    expect((await kestrel.run("resolvePage", { trigger, params: { path: "blog/entwurf" } })).status).toBe(404);
    expect((await kestrel.run("resolvePage", { trigger, params: { path: "blog" } })).result).toMatchObject({ id: blog });
    expect((await kestrel.run("resolvePost", { trigger, params: { path: "blog/hallo" } })).result).toMatchObject({ slug: "hallo" });
    await kestrel.stop();
  });

  it("renaming a mount page that moves exactly maxCascade rows (200 documents in 5 locales) finishes its group well under a second; one more document is refused", async () => {
    const steps: StepLog[] = [];
    const kestrel = await bootMounted({ locales: ["de", "en", "fr", "it", "es"], logger: { ...silentLogger, step: (entry) => steps.push(entry) } });
    const blog = idOf((await kestrel.run("createPage", { trigger, payload: { slug: "blog", title: "Blog", status: "published" } })).result);
    expect((await kestrel.run("setSettings", { trigger, payload: { mounts: { posts: blog } } })).status).toBe(200);
    for (let i = 0; i < 199; i++) expect((await kestrel.run("createPost", { trigger, payload: { slug: `beitrag-${i}`, title: `Beitrag ${i}`, status: "published" } })).status).toBe(200);

    steps.length = 0;
    const renamed = await kestrel.run("updatePage", { trigger, params: { id: blog }, payload: { slug: "journal" } });
    expect(renamed.status).toBe(200);
    const group = steps.filter((s) => s.runId === renamed.runId && (s.step.startsWith("content.update") || s.step.startsWith("site.indexPath"))).reduce((sum, s) => sum + s.ms, 0);
    expect(group).toBeLessThan(1000);
    expect((await kestrel.run("resolvePost", { trigger, params: { path: "journal/beitrag-7" } })).status).toBe(200);

    await kestrel.run("createPost", { trigger, payload: { slug: "beitrag-199", title: "Beitrag 199", status: "published" } });
    const refused = await kestrel.run("updatePage", { trigger, params: { id: blog }, payload: { slug: "magazin" } });
    expect(refused.status).toBe(400);
    expect(refused.error).toContain("more than the limit of 1000 (config key maxCascade");
    await kestrel.stop();
  }, 120_000);
});
