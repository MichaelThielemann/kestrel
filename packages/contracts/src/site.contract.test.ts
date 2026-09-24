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

      describe("field fallback only from a published default locale", () => {
        it("fills an empty field from the default locale when the default locale is published", async () => {
          const doc = expectOk(await content.create("pages", { slug: "erste", title: "Erste", status: "published", body: "Text DE" }));
          expectOk(await content.update("pages", doc.id, { slug: "first", title: "First", status: "published" }, { locale: "en" }));
          expect(await resolve("en/first")).toMatchObject({ body: "Text DE" });
        });

        it("leaves the field empty when the default locale is only a draft", async () => {
          const doc = expectOk(await content.create("pages", { slug: "zweite", title: "Zweite", status: "draft", body: "Text DE" }));
          expectOk(await content.update("pages", doc.id, { slug: "second", title: "Second", status: "published" }, { locale: "en" }));
          expect(await resolve("en/second")).toMatchObject({ body: null });
        });

        it("never uses a field the translation already has, whatever the default locale's status", async () => {
          const doc = expectOk(await content.create("pages", { slug: "dritte", title: "Dritte", status: "draft", body: "Text DE" }));
          expectOk(await content.update("pages", doc.id, { slug: "third", title: "Third", status: "published", body: "Text EN" }, { locale: "en" }));
          expect(await resolve("en/third")).toMatchObject({ body: "Text EN" });
        });
      });

      it("keeps a locale out of _translations once it fails the filter itself, even with complete fields", async () => {
        const doc = expectOk(await content.create("pages", { slug: "vierte", title: "Vierte", status: "published" }));
        expectOk(await content.update("pages", doc.id, { slug: "fourth", title: "Fourth", status: "draft" }, { locale: "en" }));
        expect(await resolve("vierte")).toMatchObject({ _translations: { de: true, en: false } });
        expect(await resolve("en/fourth")).toBeNull();
      });

      it("never routes through a default locale's slug when the default locale is only a draft", async () => {
        const doc = expectOk(await content.create("pages", { slug: "geheimer-launch", title: "Launch DE", status: "draft" }));
        expectOk(await content.update("pages", doc.id, { slug: "launch", title: "Launch EN", status: "published" }, { locale: "en" }));
        expect(await resolve("en/geheimer-launch")).toBeNull();
        expect(await resolve("en/does-not-exist")).toBeNull();
        expect(await resolve("en/launch")).toMatchObject({ title: "Launch EN" });
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

      it("fills a linked page's missing slug from the default locale only when the default locale passes the filter too", async () => {
        const target = expectOk(await content.create("pages", { slug: "ziel-de", title: "Ziel DE", status: "published" }));
        expectOk(await content.update("pages", target.id, { title: "Ziel EN", status: "published" }, { locale: "en" }));
        const linker = expectOk(await content.create("pages", { slug: "linker-a", title: "Linker", status: "published", body: `<a href="kestrel:pages:${target.id}">Ziel</a>` }));
        const en = expectOk(await site.resolveLinks("pages", linker, { locale: "en", rules }));
        expect(en._links).toEqual({ [target.id]: { path: "/en/ziel-de", locale: "en" } });
      });

      it("never fills a linked page's missing slug from a default locale that is only a draft", async () => {
        const target = expectOk(await content.create("pages", { slug: "ziel-draft", title: "Ziel Draft", status: "draft" }));
        expectOk(await content.update("pages", target.id, { title: "Ziel EN 2", status: "published" }, { locale: "en" }));
        const linker = expectOk(await content.create("pages", { slug: "linker-b", title: "Linker", status: "published", body: `<a href="kestrel:pages:${target.id}">Ziel</a>` }));
        const en = expectOk(await site.resolveLinks("pages", linker, { locale: "en", rules }));
        expect(en._links).toEqual({ [target.id]: { broken: true } });
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

      it("marks a link to a type without the filter's fields as broken instead of failing", async () => {
        const post = expectOk(await content.create("posts", { permalink: "ein-beitrag", title: "Ein Beitrag" }));
        const linker = expectOk(
          await content.create("pages", { slug: "mit-fremdlink", title: "Mit Fremdlink", status: "published", body: `<a href="kestrel:posts:${post.id}">Beitrag</a>` }),
        );
        const de = expectOk(await site.resolveLinks("pages", linker, { locale: "de", rules }));
        expect(de.body).toBe(`<a href="#" data-kestrel-broken="posts:${post.id}">Beitrag</a>`);
        expect(de._links).toEqual({ [post.id]: { broken: true } });
      });
    });
  });
}
