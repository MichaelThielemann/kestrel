import { describe, it, expect } from "vitest";
import { createContentDefault } from "@michaelthielemann/kestrel-content-default/impl";
import type { ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { SITE_TEST_MODEL, siteContractTests } from "@michaelthielemann/kestrel-contracts/site.contract.test";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { createSiteDefault, publicPath, splitPath } from "./impl.ts";

async function make(model: ContentModel = SITE_TEST_MODEL) {
  const content = await createContentDefault(model, createFakePersistence());
  return { site: createSiteDefault(content), content };
}

siteContractTests(() => make());

describe("site/default", () => {
  it("computes public paths", () => {
    expect(publicPath("home", "de", "de", "home", false)).toBe("/");
    expect(publicPath("kontakt", "de", "de", "home", false)).toBe("/kontakt");
    expect(publicPath("home", "en", "de", "home", false)).toBe("/en");
    expect(publicPath("kontakt", "en", "de", "home", false)).toBe("/en/kontakt");
    expect(publicPath("kontakt", "de", "de", "home", true)).toBe("/de/kontakt");
    expect(publicPath("kontakt", undefined, undefined, "home", false)).toBe("/kontakt");
  });

  it("splits a request path into locale and slug", () => {
    expect(splitPath("", ["de", "en"], false)).toEqual({ slug: "" });
    expect(splitPath("/kontakt/", ["de", "en"], false)).toEqual({ slug: "kontakt" });
    expect(splitPath("en", ["de", "en"], false)).toEqual({ locale: "en", slug: "" });
    expect(splitPath("en/kontakt", ["de", "en"], false)).toEqual({ locale: "en", slug: "kontakt" });
    expect(splitPath("fr/kontakt", ["de", "en"], false)).toBeNull();
    expect(splitPath("a/b/c", ["de", "en"], false)).toBeNull();
    expect(splitPath("kontakt", ["de", "en"], true)).toBeNull();
    expect(splitPath("kontakt", [], true)).toEqual({ slug: "kontakt" });
  });

  it("rejects types the content model does not know", async () => {
    const { site } = await make();
    await expect(site.resolve("events", "")).rejects.toThrow(/unknown type/);
    expect(() => site.pathOf("events", { id: "1", createdAt: 1, updatedAt: 1 })).toThrow(/unknown type/);
  });

  it("works without locales at all", async () => {
    const { site, content } = await make({ types: { pages: { kind: "multi", fields: { slug: { type: "slug", required: true }, title: "text" } } } });
    expectOk(await content.create("pages", { slug: "home", title: "Start" }));
    const home = expectOk(await site.resolve("pages", ""));
    expect(home).toMatchObject({ slug: "home" });
    expect(home?._locale).toBeUndefined();
    expect(site.pathOf("pages", home!)).toBe("/");
    expect(expectOk(await site.resolve("pages", "en"))).toBeNull();
  });

  it("rewrites internal references inside json fields and object targets", async () => {
    const { site, content } = await make({
      locales: ["de", "en"],
      defaultLocale: "de",
      types: {
        pages: {
          kind: "multi",
          fields: {
            slug: { type: "slug", required: true, unique: true, localized: true },
            title: { type: "text", required: true, localized: true },
            body: { type: "json", localized: true },
            status: { type: "enum", options: ["draft", "published"], localized: true },
          },
        },
      },
    });
    const impressum = expectOk(await content.create("pages", { slug: "impressum", title: "Impressum", status: "published" }));
    const home = expectOk(await content.create("pages", { slug: "home", title: "Start", status: "published" }));
    const page = expectOk(
      await content.create("pages", {
        slug: "kontakt",
        title: "Kontakt",
        status: "published",
        body: [{ type: "link", target: { type: "internal", collection: "pages", id: impressum.id }, plain: `kestrel:pages:${home.id}` }],
      }),
    );
    const rules = { home: "home", fallback: true, filter: { status: "published" } };
    const de = expectOk(await site.resolveLinks("pages", page, { locale: "de", rules }));
    expect(de.body).toEqual([{ type: "link", target: { type: "internal", collection: "pages", id: impressum.id, path: "/impressum" }, plain: "/" }]);
    expect(de._links).toEqual({ [home.id]: { path: "/", locale: "de" }, [impressum.id]: { path: "/impressum", locale: "de" } });

    expectOk(await content.update("pages", home.id, { slug: "home", title: "Home", status: "published" }, { locale: "en" }));
    const en = expectOk(await site.resolveLinks("pages", page, { locale: "en", rules }));
    expect(en._links).toEqual({ [home.id]: { path: "/en", locale: "en" }, [impressum.id]: { broken: true } });
    expect((en.body as Array<{ target: { broken?: boolean } }>)[0]?.target.broken).toBe(true);
  });

  it("surfaces a persistence failure as TRANSIENT", async () => {
    const persistence = createFakePersistence();
    const content = await createContentDefault(SITE_TEST_MODEL, persistence);
    const site = createSiteDefault(content);
    persistence.failNext("TRANSIENT");
    const failed = await site.resolve("pages", "");
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe("TRANSIENT");
  });
});
