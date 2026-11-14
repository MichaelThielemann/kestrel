import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boot } from "@michaelthielemann/kestrel";
import contentModule from "@michaelthielemann/kestrel-content-default";
import type { ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import eventsDirect from "@michaelthielemann/kestrel-events-direct";
import eventsInmemory from "@michaelthielemann/kestrel-events-inmemory";
import persistenceSqlite from "@michaelthielemann/kestrel-persistence-sqlite";
import type { Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline, type PipelineDefinition } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { ok } from "@michaelthielemann/kestrel/result";
import siteModule from "./module.ts";

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
    notes: { kind: "multi", fields: { slug: { type: "slug", required: true }, title: { type: "text" } } },
  },
};

const authn = defineModule({
  name: "authn/stub",
  provides: [],
  requires: [],
  configSchema: z.object({}).strict(),
  async setup() {
    return {};
  },
  steps: () => ({
    requireUser: async (ctx: Context) => ok(ctx),
    identifyUser: async (ctx: Context) => ok(ctx),
  }),
  describe: () => ({
    requireUser: { summary: "require a user", reads: [], writes: [] },
    identifyUser: { summary: "identify a user", reads: [], writes: [] },
  }),
});

const WRITES = [
  definePipeline({ name: "createPage", steps: [{ atomic: ["content.create:pages", "site.indexPath:pages"] }, "site.announcePaths"] }),
  definePipeline({ name: "updatePage", steps: [{ atomic: ["content.update:pages", "site.indexPath:pages"] }, "site.announcePaths"] }),
];

async function bootWith(pipelines: PipelineDefinition[], routes: Record<string, unknown> = { pages: { home: "home", liveWhen: { status: "published" } } }) {
  const kestrel = await boot({
    config: {
      modules: [
        { use: "persistence", config: { file: ":memory:" } },
        { use: "content", config: MODEL },
        { use: "site", config: { routes } },
        { use: "events", config: {} },
        { use: "direct", config: {} },
        { use: "authn", config: {} },
      ],
      triggers: [],
      http: { port: 0 },
    },
    modules: [persistenceSqlite, contentModule, siteModule, eventsInmemory, eventsDirect, authn],
    pipelines: [...WRITES, ...pipelines],
    logger: silentLogger,
  });
  await kestrel.start();
  return kestrel;
}

describe("site/default routed: resolve status filter", () => {
  it("fails when site.resolve on a routed type carries none of the route's liveWhen filter", async () => {
    const pipelines = [definePipeline({ name: "resolvePage", steps: ["site.resolve:pages?home=home&fallback=true"] })];
    await expect(bootWith(pipelines)).rejects.toThrow(/pipeline "resolvePage": site\.resolve:pages\?home=home&fallback=true must carry status=published, the route's liveWhen/);
  });

  it("fails when site.resolveLinks on a routed type carries no filter", async () => {
    const pipelines = [definePipeline({ name: "resolvePage", steps: ["site.resolve:pages?home=home&status=published", "site.resolveLinks:pages?home=home"] })];
    await expect(bootWith(pipelines)).rejects.toThrow(/site\.resolveLinks:pages\?home=home must carry status=published/);
  });

  it("fails when the step filters on another value than the route's liveWhen", async () => {
    const pipelines = [definePipeline({ name: "resolvePage", steps: ["site.resolve:pages?home=home&status=draft"] })];
    await expect(bootWith(pipelines)).rejects.toThrow(/must carry status=published/);
  });

  it("reports every offending pipeline in one error", async () => {
    const pipelines = [
      definePipeline({ name: "resolvePage", steps: ["site.resolve:pages?home=home"] }),
      definePipeline({ name: "resolveOther", steps: ["site.resolve:pages?home=home"] }),
    ];
    await expect(bootWith(pipelines)).rejects.toThrow(/pipeline "resolvePage".*pipeline "resolveOther"/);
  });

  it("accepts the filter in any argument position and extra arguments", async () => {
    const pipelines = [definePipeline({ name: "resolvePage", steps: ["site.resolve:pages?status=published&home=home&fallback=true", "site.resolveLinks:pages?fallback=true&status=published&home=home"] })];
    const kestrel = await bootWith(pipelines);
    await kestrel.stop();
  });

  it("accepts an unfiltered resolve after authn.requireUser (signed-in preview)", async () => {
    const pipelines = [definePipeline({ name: "previewPage", steps: ["authn.requireUser", "site.resolve:pages?home=home"] })];
    const kestrel = await bootWith(pipelines);
    await kestrel.stop();
  });

  it("does not exempt a resolve behind authn.identifyUser or ahead of authn.requireUser", async () => {
    const identified = [definePipeline({ name: "resolvePage", steps: ["authn.identifyUser", "site.resolve:pages?home=home"] })];
    await expect(bootWith(identified)).rejects.toThrow(/must carry status=published/);
    const later = [definePipeline({ name: "resolvePage", steps: ["site.resolve:pages?home=home", "authn.requireUser"] })];
    await expect(bootWith(later)).rejects.toThrow(/must carry status=published/);
  });

  it("requires nothing for a routed type without liveWhen or for an unrouted type", async () => {
    const pipelines = [
      definePipeline({ name: "resolveNote", steps: ["site.resolve:notes"] }),
      definePipeline({ name: "resolvePage", steps: ["site.resolve:pages?home=home"] }),
    ];
    const kestrel = await bootWith(pipelines, { pages: { home: "home" } });
    await kestrel.stop();
  });

  it("requires only the fields named by a non-scalar liveWhen to be present", async () => {
    const routes = { pages: { home: "home", liveWhen: { status: { in: ["published"] } } } };
    await expect(bootWith([definePipeline({ name: "resolvePage", steps: ["site.resolve:pages?home=home"] })], routes)).rejects.toThrow(/must carry status/);
    const kestrel = await bootWith([definePipeline({ name: "resolvePage", steps: ["site.resolve:pages?home=home&status=published"] })], routes);
    await kestrel.stop();
  });
});
