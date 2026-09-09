import { describe, it, expect } from "vitest";
import { createContentDefault } from "@michaelthielemann/kestrel-content-default/impl";
import { CONTENT } from "@michaelthielemann/kestrel-contracts/content";
import { SITE_TEST_MODEL } from "@michaelthielemann/kestrel-contracts/site.contract.test";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { createContext } from "@michaelthielemann/kestrel/context";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import type { RunResult } from "@michaelthielemann/kestrel/runner";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import { createSiteDefault } from "./impl.ts";
import module from "./module.ts";

const ctx = (path: string) => createContext({ trigger: { kind: "http", name: "t" }, params: { path } });

async function steps() {
  const content = await createContentDefault(SITE_TEST_MODEL, createFakePersistence());
  const home = expectOk(await content.create("pages", { slug: "home", title: "Start", status: "published" }));
  expectOk(await content.update("pages", home.id, { slug: "home", title: "Home", status: "published" }, { locale: "en" }));
  const kontakt = expectOk(await content.create("pages", { slug: "kontakt", title: "Kontakt", status: "published" }));
  expectOk(await content.update("pages", kontakt.id, { status: "published" }, { locale: "en" }));
  expectOk(
    await content.create("pages", {
      slug: "links",
      title: "Links",
      status: "published",
      body: `<a href="kestrel:pages:${home.id}">Start</a>`,
    }),
  );
  const map = module.steps!(createSiteDefault(content));
  return { resolve: map.resolve, resolveLinks: map.resolveLinks, homeId: home.id };
}

describe("site/default steps", () => {
  const arg = "pages?home=home&status=published&fallback=true";

  it("resolve reports the effective locale and NOT_FOUND when nothing is served", async () => {
    const { resolve } = await steps();
    const step = resolve(arg);
    expect(expectOk(await step(ctx(""))).result).toMatchObject({ slug: "home", title: "Start", _locale: "de" });
    expect(expectOk(await step(ctx("en/kontakt"))).result).toMatchObject({ title: "Kontakt", _locale: "en" });
    const notFound = expectErr(await step(ctx("nope")), "NOT_FOUND");
    expect(notFound.message).toBe("no page at /nope");
    expect(notFound.status).toBe(404);
    expectErr(await step(ctx("en/kontakt/deeper")), "NOT_FOUND");
  });

  it("resolveLinks rewrites the resolved document in its locale", async () => {
    const { resolve, resolveLinks, homeId } = await steps();
    const resolved = expectOk(await resolve(arg)(ctx("links")));
    const linked = expectOk(await resolveLinks(arg)(resolved));
    const de = linked.result as Record<string, unknown>;
    expect(de.body).toBe(`<a href="/">Start</a>`);
    expect(de._links).toEqual({ [homeId]: { path: "/", locale: "de" } });
  });

  it("resolveLinks is a bug path when result has no document", async () => {
    const { resolveLinks } = await steps();
    await expect(resolveLinks(arg)(ctx(""))).rejects.toThrow(/without a document in result/);
  });

  it("resolve passes a persistence TRANSIENT failure through as a retryable 503", async () => {
    const persistence = createFakePersistence();
    const content = await createContentDefault(SITE_TEST_MODEL, persistence);
    const map = module.steps!(createSiteDefault(content));
    persistence.failNext("TRANSIENT");
    const error = expectErr(await map.resolve(arg)(ctx("")), "TRANSIENT");
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
  });
});

describe("site/default module steps (schema-checked)", () => {
  async function boot() {
    const db = createFakePersistence();
    const content = await createContentDefault(SITE_TEST_MODEL, db);
    const providers = new Map<string, unknown>([[CONTENT.name, content]]);
    const deps: Deps = {
      get<T>(contract: Contract<T>): T {
        if (!providers.has(contract.name)) throw new Error(`no provider for "${contract.name}"`);
        return providers.get(contract.name) as T;
      },
      find: <T>(contract: Contract<T>): T | undefined => providers.get(contract.name) as T | undefined,
      logger: silentLogger,
      root: process.cwd(),
    };
    const instance = await module.setup(module.configSchema.parse({}), deps);
    return { instance, content };
  }

  function run(steps: string[], input: Record<string, unknown>, instance: unknown): Promise<RunResult> {
    return runPipeline(definePipeline({ name: "test", steps }), input, { modules: [{ module, instance }] });
  }

  const arg = "pages?home=home&status=published&fallback=true";

  it("resolve then resolveLinks run through the real, schema-checked pipeline", async () => {
    const { instance, content } = await boot();
    const home = expectOk(await content.create("pages", { slug: "home", title: "Start", status: "published" }));
    expectOk(await content.update("pages", home.id, { slug: "home", title: "Home", status: "published" }, { locale: "en" }));
    expectOk(await content.create("pages", { slug: "links", title: "Links", status: "published", body: `<a href="kestrel:pages:${home.id}">Start</a>` }));

    const res = await run([`site.resolve:${arg}`, `site.resolveLinks:${arg}`], { params: { path: "links" }, query: { locale: "de" } }, instance);
    expect(res.status).toBe(200);
    const doc = res.result as Record<string, unknown>;
    expect(doc.body).toBe(`<a href="/">Start</a>`);
  });

  it("rejects a non-string locale query with 400 VALIDATION from the query schema", async () => {
    const { instance, content } = await boot();
    const home = expectOk(await content.create("pages", { slug: "home", title: "Start", status: "published" }));
    expectOk(await content.create("pages", { slug: "links", title: "Links", status: "published", body: `<a href="kestrel:pages:${home.id}">Start</a>` }));

    const res = await run([`site.resolve:${arg}`, `site.resolveLinks:${arg}`], { params: { path: "links" }, query: { locale: 5 } }, instance);
    expect(res.status).toBe(400);
    expect(res.code).toBe("VALIDATION");
  });
});
