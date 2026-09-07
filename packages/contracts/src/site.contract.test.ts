import { describe, it, expect, beforeEach } from "vitest";
import type { Content, ContentDocument, ContentModel } from "./content.ts";
import type { Site, SiteRules } from "./site.ts";
import { expectOk } from "./testing/result.ts";

/** The model an implementation must build its `content` on for these tests. */
export const SITE_TEST_MODEL: ContentModel = {
  locales: ["de", "en"],
  defaultLocale: "de",
  types: {
    pages: {
      kind: "multi",
      fields: {
        slug: { type: "slug", required: true, unique: true, localized: true },
        title: { type: "text", required: true, localized: true },
        body: { type: "richtext", localized: true },
        blocks: { type: "json", localized: true },
        status: { type: "enum", options: ["draft", "published"], localized: true },
      },
    },
    posts: {
      kind: "multi",
      fields: {
        permalink: { type: "slug", required: true, unique: true, localized: true },
        title: { type: "text", required: true, localized: true },
      },
    },
  },
};

export function siteContractTests(make: () => Promise<{ site: Site; content: Content }>) {
  describe("site@1", () => {
    let site: Site;
    let content: Content;
    const rules: SiteRules = { home: "home", fallback: true, filter: { status: "published" } };
    let ids: { home: string; kontakt: string; team: string; entwurf: string };

    beforeEach(async () => {
      ({ site, content } = await make());
      const home = expectOk(await content.create("pages", { slug: "home", title: "Start", status: "published" }));
      expectOk(await content.update("pages", home.id, { slug: "home", title: "Home", status: "published" }, { locale: "en" }));
      const kontakt = expectOk(await content.create("pages", { slug: "kontakt", title: "Kontakt", status: "published" }));
      expectOk(await content.update("pages", kontakt.id, { status: "published" }, { locale: "en" }));
      const team = expectOk(await content.create("pages", { slug: "team", title: "Team", status: "published" }));
      expectOk(await content.update("pages", team.id, { slug: "team", title: "Team EN", status: "draft" }, { locale: "en" }));
      const entwurf = expectOk(await content.create("pages", { slug: "entwurf", title: "Entwurf", status: "draft" }));
      ids = { home: home.id, kontakt: kontakt.id, team: team.id, entwurf: entwurf.id };
    });

    const resolve = async (path: string, extra: SiteRules = {}) => expectOk(await site.resolve("pages", path, { rules: { ...rules, ...extra } }));

    describe("resolve", () => {
      it("maps /, /<slug>, /<locale> and /<locale>/<slug> onto a document and reports the locale", async () => {
        expect(await resolve("")).toMatchObject({ slug: "home", title: "Start", _locale: "de" });
        expect(await resolve("kontakt")).toMatchObject({ slug: "kontakt", title: "Kontakt", _locale: "de" });
        expect(await resolve("en")).toMatchObject({ slug: "home", title: "Home", _locale: "en" });
        expect(await resolve("en/kontakt")).toMatchObject({ slug: "kontakt", title: "Kontakt", _locale: "en" });
      });

      it("returns null for unknown paths, unknown locale prefixes and deeper paths", async () => {
        expect(await resolve("nope")).toBeNull();
        expect(await resolve("fr/kontakt")).toBeNull();
        expect(await resolve("en/kontakt/deeper")).toBeNull();
      });

      it("applies the filter", async () => {
        expect(await resolve("entwurf")).toBeNull();
        expect(expectOk(await site.resolve("pages", "entwurf", { rules: { home: "home" } }))).toMatchObject({ slug: "entwurf" });
      });

      it("fallback never serves a locale that is not published itself", async () => {
        expect(await resolve("team")).toMatchObject({ title: "Team" });
        expect(await resolve("en/team")).toBeNull();
      });

      it("without fallback a missing translation is not found", async () => {
        expect(await resolve("en/kontakt", { fallback: false })).toBeNull();
        expect(await resolve("en", { fallback: false })).toMatchObject({ title: "Home" });
      });

      it("prefixPrimary requires the locale prefix for every locale", async () => {
        expect(await resolve("", { prefixPrimary: true })).toBeNull();
        expect(await resolve("kontakt", { prefixPrimary: true })).toBeNull();
        expect(await resolve("de", { prefixPrimary: true })).toMatchObject({ slug: "home", title: "Start" });
        expect(await resolve("de/kontakt", { prefixPrimary: true })).toMatchObject({ title: "Kontakt" });
        expect(await resolve("en", { prefixPrimary: true })).toMatchObject({ title: "Home" });
      });
    });

    describe("pathOf", () => {
      it("is the inverse of resolve", async () => {
        for (const path of ["", "kontakt", "en", "en/kontakt"]) {
          const doc = await resolve(path);
          expect(doc).not.toBeNull();
          expect(site.pathOf("pages", doc!, { rules })).toBe(`/${path}`);
        }
      });

      it("honours an explicit locale and prefixPrimary", async () => {
        const doc = (await resolve("kontakt"))!;
        expect(site.pathOf("pages", doc, { locale: "en", rules })).toBe("/en/kontakt");
        expect(site.pathOf("pages", doc, { rules: { ...rules, prefixPrimary: true } })).toBe("/de/kontakt");
      });

      it("is null without a slug", async () => {
        const strict = expectOk(await content.get("pages", ids.kontakt, { locale: "en" }));
        expect(strict?.slug).toBeNull();
        expect(site.pathOf("pages", strict!, { locale: "en", rules })).toBeNull();
      });
    });

    describe("a slug field under another name", () => {
      const postRules: SiteRules = { home: "index", slugField: "permalink" };

      it("resolves and reverses through the configured field", async () => {
        expectOk(await content.create("posts", { permalink: "index", title: "Index" }));
        const post = expectOk(await content.create("posts", { permalink: "hallo-welt", title: "Hallo" }));
        const doc = expectOk(await site.resolve("posts", "hallo-welt", { rules: postRules }));
        expect(doc).toMatchObject({ id: post.id, permalink: "hallo-welt" });
        expect(site.pathOf("posts", doc!, { rules: postRules })).toBe("/hallo-welt");
        const home = expectOk(await site.resolve("posts", "", { rules: postRules }));
        expect(home).toMatchObject({ permalink: "index" });
        expect(site.pathOf("posts", home!, { rules: postRules })).toBe("/");
      });
    });

    describe("resolveLinks", () => {
      let page: ContentDocument;
      beforeEach(async () => {
        page = expectOk(
          await content.create("pages", {
            slug: "links",
            title: "Links",
            status: "published",
            body: `<a href="kestrel:pages:${ids.home}">Start</a> <a href="kestrel:pages:${ids.entwurf}">E</a>`,
          }),
        );
      });

      it("rewrites internal references to public paths and marks targets that are not served", async () => {
        const de = expectOk(await site.resolveLinks("pages", page, { locale: "de", rules }));
        expect(de.body).toBe(`<a href="/">Start</a> <a href="#" data-kestrel-broken="pages:${ids.entwurf}">E</a>`);
        expect(de._links).toEqual({ [ids.home]: { path: "/", locale: "de" }, [ids.entwurf]: { broken: true } });
        expect(page.body).toContain("kestrel:pages:");
      });

      it("resolves in the requested locale", async () => {
        expectOk(await content.update("pages", page.id, { slug: "links", title: "Links", status: "published" }, { locale: "en" }));
        const en = expectOk(await site.resolveLinks("pages", page, { locale: "en", rules }));
        expect(en._links).toEqual({ [ids.home]: { path: "/en", locale: "en" }, [ids.entwurf]: { broken: true } });
      });

      it("rewrites internal link objects and marks unserved ones", async () => {
        const withBlocks = expectOk(
          await content.create("pages", {
            slug: "blocks",
            title: "Blocks",
            status: "published",
            blocks: [
              { type: "link", target: { type: "internal", collection: "pages", id: ids.home } },
              { type: "link", target: { type: "internal", collection: "pages", id: ids.entwurf } },
            ],
          }),
        );
        const de = expectOk(await site.resolveLinks("pages", withBlocks, { locale: "de", rules }));
        expect(de.blocks).toEqual([
          { type: "link", target: { type: "internal", collection: "pages", id: ids.home, path: "/" } },
          { type: "link", target: { type: "internal", collection: "pages", id: ids.entwurf, broken: true } },
        ]);
      });

      it("leaves a document without internal references untouched", async () => {
        const home = (await resolve(""))!;
        expect(expectOk(await site.resolveLinks("pages", home, { locale: "de", rules }))._links).toBeUndefined();
      });
    });
  });
}
