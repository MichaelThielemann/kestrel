import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boot, type Kestrel } from "@michaelthielemann/kestrel";
import contentModule from "@michaelthielemann/kestrel-content-default";
import type { ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import eventsDirect from "@michaelthielemann/kestrel-events-direct";
import eventsInmemory from "@michaelthielemann/kestrel-events-inmemory";
import persistenceSqlite from "@michaelthielemann/kestrel-persistence-sqlite";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline, type PipelineDefinition } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { ok } from "@michaelthielemann/kestrel/result";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import { routedSite } from "./__fixtures__/routed.ts";
import { createContentDefault } from "@michaelthielemann/kestrel-content-default/impl";
import { CONTENT } from "@michaelthielemann/kestrel-contracts/content";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import siteModule, { configSchema } from "./module.ts";
import type { Move } from "./routes.ts";

const MODEL: ContentModel = {
  locales: ["de", "en"],
  defaultLocale: "de",
  types: {
    pages: {
      kind: "multi",
      fields: {
        slug: { type: "slug", required: true, localized: true },
        title: { type: "text", required: true, localized: true },
        status: { type: "enum", options: ["draft", "published"], localized: true },
      },
    },
  },
};

const ROUTES = { pages: { home: "home", liveWhen: { status: "published" } } };

function recorder(moves: Move[][]) {
  return defineModule({
    name: "test/recorder",
    provides: [],
    requires: [],
    configSchema: z.object({}).strict(),
    async setup() {
      return moves;
    },
    steps: (seen) => ({
      record: async (ctx: Context) => {
        seen.push(boundaryCast<Move[]>(ctx.payload.moves, "json"));
        return ok(ctx);
      },
      finish: async (ctx: Context) => ctx.done({ finished: true }),
    }),
    describe: () => ({
      record: { summary: "record", reads: ["payload"], writes: [] },
      finish: { summary: "finish", reads: [], writes: ["result"], terminalOutput: { type: "object" }, atomicSafe: true },
    }),
  });
}

const WRITES = [
  definePipeline({ name: "createPage", steps: [{ atomic: ["content.create:pages", "site.indexPath:pages"] }, "site.announcePaths"] }),
  definePipeline({ name: "updatePage", steps: [{ atomic: ["content.update:pages", "site.indexPath:pages"] }, "site.announcePaths"] }),
  definePipeline({ name: "resolvePage", steps: ["site.resolve:pages?home=home&status=published&fallback=true"] }),
  definePipeline({ name: "listAllPages", steps: ["content.list:pages", "site.attachPaths:pages"] }),
  definePipeline({ name: "listPages", steps: ["content.list:pages?status=published", "site.attachPaths:pages?reachable"] }),
  definePipeline({ name: "previewPagePath", steps: ["site.previewPath:pages"] }),
  definePipeline({ name: "resumePaths", steps: ["site.resumePaths"] }),
  definePipeline({ name: "rebuildPaths", steps: ["site.planRebuild", { atomic: ["site.applyRebuild"] }, "site.announcePaths"] }),
  definePipeline({ name: "pathsMoved", steps: ["test.record"] }),
];

interface BootOptions {
  pipelines?: PipelineDefinition[];
  events?: boolean;
  persistence?: boolean;
  site?: Record<string, unknown>;
}

async function bootRouted(options: BootOptions = {}): Promise<{ kestrel: Kestrel; moves: Move[][] }> {
  const moves: Move[][] = [];
  const events = options.events ?? true;
  const persistence = options.persistence ?? true;
  const modules = [
    ...(persistence ? [{ use: "persistence", config: { file: ":memory:" } }] : []),
    { use: "content", config: MODEL },
    { use: "site", config: options.site ?? { routes: ROUTES } },
    ...(events ? [{ use: "events", config: {} }, { use: "direct", config: {} }] : []),
    { use: "test", config: {} },
  ];
  const kestrel = await boot({
    config: { modules, triggers: events ? [{ event: "site.pathsMoved", pipeline: "pathsMoved" }] : [] },
    modules: [...(persistence ? [persistenceSqlite] : []), contentModule, siteModule, ...(events ? [eventsInmemory, eventsDirect] : []), recorder(moves)],
    pipelines: [...(options.pipelines ?? WRITES.filter((p) => p.name !== "pathsMoved")), ...(events ? [WRITES.find((p) => p.name === "pathsMoved")!] : [])],
    logger: silentLogger,
    validateOutput: true,
  });
  await kestrel.start();
  return { kestrel, moves };
}

const http = { kind: "http", name: "test" } as const;

describe("site/default routed: boot", () => {
  it("routes need persistence@1 and events@1", async () => {
    const content = await createContentDefault(MODEL, createFakePersistence());
    const deps = (providers: Record<string, unknown>): Deps => ({
      get<T>(contract: Contract<T>): T {
        if (!(contract.name in providers)) throw new Error(`no provider for "${contract.name}"`);
        return boundaryCast<T>(providers[contract.name], "host");
      },
      find: <T>(contract: Contract<T>): T | undefined => boundaryCast<T | undefined>(providers[contract.name], "host"),
      logger: silentLogger,
      root: process.cwd(),
      eventTriggers: [],
    });
    const config = configSchema.parse({ routes: ROUTES });
    await expect(siteModule.setup(config, deps({ [CONTENT.name]: content }))).rejects.toThrow(/routes need a persistence@1 provider/);
    await expect(siteModule.setup(config, deps({ [CONTENT.name]: content, [PERSISTENCE.name]: createFakePersistence() }))).rejects.toThrow(/routes need an events@1 provider/);
  });

  it("without routes it needs neither", async () => {
    const { kestrel } = await bootRouted({ events: false, site: {}, pipelines: [definePipeline({ name: "resolvePage", steps: ["site.resolve:pages?home=home"] })] });
    await kestrel.stop();
  });

  it("fails when a write to a routed type does not end its group with site.indexPath", async () => {
    await expect(bootRouted({ pipelines: [definePipeline({ name: "updatePage", steps: [{ atomic: ["content.update:pages"] }] })] })).rejects.toThrow(/the atomic group with content.update:pages must end with site.indexPath:pages \(it ends with content.update:pages\)/);
    await expect(bootRouted({ pipelines: [definePipeline({ name: "updatePage", steps: ["content.update:pages"] })] })).rejects.toThrow(/content.update:pages must run in an atomic group/);
    await expect(bootRouted({ pipelines: [definePipeline({ name: "updatePage", steps: [{ atomic: ["content.update:pages", "site.indexPath:pages", "content.validate:pages"] }, "site.announcePaths"] })] })).rejects.toThrow(/must end with site.indexPath:pages/);
    await expect(bootRouted({ pipelines: [definePipeline({ name: "updatePage", steps: [{ atomic: ["content.update:pages", "site.indexPath:pages"] }] })] })).rejects.toThrow(/site.announcePaths must follow/);
  });

  it("fails when a read names a home or slug field the route does not have", async () => {
    await expect(bootRouted({ pipelines: [definePipeline({ name: "resolvePage", steps: ["site.resolve:pages?home=start"] })] })).rejects.toThrow(/names home "start", but routes.pages.home is "home"/);
  });

  it("fails for a routed type the model does not have or whose slug field is no slug", async () => {
    await expect(bootRouted({ site: { routes: { events: {} } }, pipelines: [] })).rejects.toThrow(/the content model has no type "events"/);
    await expect(bootRouted({ site: { routes: { pages: { slugField: "title" } } }, pipelines: [] })).rejects.toThrow(/"pages.title" must be a slug field/);
  });
});

describe("site/default routed: pipelines", () => {
  it("two concurrent saves onto one path: exactly one succeeds, the other answers 409", async () => {
    const { kestrel } = await bootRouted();
    const results = await Promise.all([
      kestrel.run("createPage", { trigger: http, payload: { slug: "x", title: "A", status: "published" } }),
      kestrel.run("createPage", { trigger: http, payload: { slug: "x", title: "B", status: "published" } }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const listed = await kestrel.run("listAllPages", { trigger: http });
    expect(boundaryCast<{ total: number }>(listed.result, "json").total).toBe(1);
    await kestrel.stop();
  });

  it("interleaved saves of different pages each announce, and the table ends with both", async () => {
    const { kestrel, moves } = await bootRouted();
    const ids: string[] = [];
    for (const slug of ["a", "b"]) ids.push(boundaryCast<{ id: string }>((await kestrel.run("createPage", { trigger: http, payload: { slug, title: slug, status: "published" } })).result, "json").id);
    moves.length = 0;
    const results = await Promise.all([
      kestrel.run("updatePage", { trigger: http, params: { id: ids[0]! }, payload: { slug: "a2" } }),
      kestrel.run("updatePage", { trigger: http, params: { id: ids[1]! }, payload: { slug: "b2" } }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(moves.flat().map(({ from, to }) => `${from}->${to}`).sort()).toEqual(["/a->/a2", "/b->/b2"]);
    for (const [path, id] of [["a2", ids[0]], ["b2", ids[1]]] as const) expect((await kestrel.run("resolvePage", { trigger: http, params: { path } })).result).toMatchObject({ id });
    await kestrel.stop();
  });

  it("a save raises site.pathsMoved to the subscribed pipeline and attaches paths to lists", async () => {
    const { kestrel, moves } = await bootRouted();
    const created = await kestrel.run("createPage", { trigger: http, payload: { slug: "a", title: "A", status: "published" } });
    const id = boundaryCast<{ id: string }>(created.result, "json").id;
    const draft = await kestrel.run("createPage", { trigger: http, payload: { slug: "d", title: "D", status: "draft" } });
    const draftId = boundaryCast<{ id: string }>(draft.result, "json").id;
    moves.length = 0;
    expect((await kestrel.run("updatePage", { trigger: http, params: { id }, payload: { slug: "b" } })).status).toBe(200);
    expect(moves.flat().map(({ locale, from, to }) => ({ locale, from, to }))).toEqual([
      { locale: "de", from: "/a", to: "/b" },
    ]);
    const resolved = await kestrel.run("resolvePage", { trigger: http, params: { path: "b" } });
    expect(resolved.result).toMatchObject({ id, _paths: { de: "/b", en: null } });
    const admin = boundaryCast<{ items: Array<{ id: string; _paths: unknown }> }>((await kestrel.run("listAllPages", { trigger: http })).result, "json");
    expect(admin.items.find((d) => d.id === draftId)?._paths).toEqual({ de: "/d", en: "/en/d" });
    const anonymous = boundaryCast<{ items: Array<{ id: string; _paths: unknown }> }>((await kestrel.run("listPages", { trigger: http })).result, "json");
    expect(anonymous.items).toEqual([expect.objectContaining({ id, _paths: { de: "/b", en: null } })]);
    await kestrel.stop();
  });

  it("a group that ends early commits its rows but leaves memory unchanged until a resume", async () => {
    let clock = 1_000_000;
    const { raw, site, db, emitted } = await routedSite({ now: () => clock });
    const page = expectOk(await raw.create("pages", { slug: "a", title: "A", status: "published" }));
    expectOk(await site.paths!.index("pages", page.id, "seed"));
    await site.paths!.announce("seed");
    emitted.length = 0;
    const pipeline = definePipeline({ name: "finishEarly", steps: [{ atomic: ["content.update:pages", "site.indexPath:pages", "test.finish"] }, "site.announcePaths"] });
    const res = await runPipeline(pipeline, { params: { id: page.id }, payload: { slug: "b" } }, {
      modules: [
        { module: contentModule, instance: raw },
        { module: siteModule, instance: site },
        { module: recorder([]), instance: [] },
      ],
      atomicScope: (info, body) => db.scope(info, body),
    });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(200);
    expect(expectOk(await site.resolve("pages", "a", { rules: { home: "home" } }))).toMatchObject({ id: page.id });
    expect(emitted).toEqual([]);
    clock += 6_000;
    expect(expectOk(await site.paths!.resume()).announced).toBe(1);
    expect(expectOk(await site.resolve("pages", "b", { rules: { home: "home" } }))).toMatchObject({ id: page.id });
    expect(emitted.flat().map(({ from, to }) => ({ from, to }))).toEqual([{ from: "/a", to: "/b" }]);
  });

  it("a rebuild pipeline reports the index and is idempotent", async () => {
    const { kestrel } = await bootRouted();
    await kestrel.run("createPage", { trigger: http, payload: { slug: "a", title: "A", status: "published" } });
    const rebuilt = await kestrel.run("rebuildPaths", { trigger: http });
    expect(rebuilt.status).toBe(200);
    expect(rebuilt.result).toEqual({ indexed: 1, conflicts: [] });
    expect((await kestrel.run("resumePaths", { trigger: http })).result).toEqual({ announced: 0, pruned: 0 });
    await kestrel.stop();
  });

  it("the preview names the occupant of a taken path", async () => {
    const { kestrel } = await bootRouted();
    await kestrel.run("createPage", { trigger: http, payload: { slug: "a", title: "A", status: "published" } });
    const preview = await kestrel.run("previewPagePath", { trigger: http, payload: { slug: "a" } });
    expect(preview.result).toMatchObject({ path: "/a", reachable: false, conflict: { path: "/a", locale: "de", label: "A" } });
    await kestrel.stop();
  });
});
