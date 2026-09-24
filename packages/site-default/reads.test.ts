import { describe, expect, it } from "vitest";
import { createContentDefault } from "@michaelthielemann/kestrel-content-default/impl";
import { SITE_TEST_MODEL } from "@michaelthielemann/kestrel-contracts/site.contract.test";
import type { SiteRules } from "@michaelthielemann/kestrel-contracts/site";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { observeReads } from "@michaelthielemann/kestrel/reads";
import { createSiteDefault } from "./impl.ts";

const rules: SiteRules = { home: "home", fallback: true, filter: { status: "published" } };
const normalized = { home: "home", slugField: "slug", prefixPrimary: false, fallback: true, filter: { status: "published" } };

async function seeded() {
  const content = await createContentDefault(SITE_TEST_MODEL, createFakePersistence());
  const site = createSiteDefault(content);
  const home = expectOk(await content.create("pages", { slug: "home", title: "Start", status: "published" }));
  const kontakt = expectOk(await content.create("pages", { slug: "kontakt", title: "Kontakt", status: "published" }));
  expectOk(await content.update("pages", kontakt.id, { status: "published" }, { locale: "en" }));
  const entwurf = expectOk(await content.create("pages", { slug: "entwurf", title: "Entwurf", status: "draft" }));
  return { content, site, ids: { home: home.id, kontakt: kontakt.id, entwurf: entwurf.id } };
}

describe("site/default notes what it answers inside a read scope", () => {
  it("resolve notes only the document it answers with, at the answered locale", async () => {
    const { site, ids } = await seeded();
    const { reads } = await observeReads(async () => {
      expect(expectOk(await site.resolve("pages", "kontakt", { rules }))).toMatchObject({ id: ids.kontakt });
    });
    expect(reads).toEqual([{ kind: "document", type: "pages", id: ids.kontakt, locale: "de" }]);
  });

  it("resolve with nothing at the path notes the slug lookup, so a page that later appears there marks the reader", async () => {
    const { site } = await seeded();
    const { reads } = await observeReads(async () => {
      expect(expectOk(await site.resolve("pages", "neu", { rules }))).toBeNull();
    });
    expect(reads).toEqual([{ kind: "query", type: "pages", filter: { status: "published", slug: "neu" }, locale: "de" }]);
  });

  it("resolve through the default locale's slug notes the locale's own lookup too", async () => {
    const { site, ids } = await seeded();
    const { reads } = await observeReads(async () => {
      expect(expectOk(await site.resolve("pages", "en/kontakt", { rules }))).toMatchObject({ id: ids.kontakt });
      expect(expectOk(await site.resolve("pages", "en/entwurf", { rules }))).toBeNull();
    });
    expect(reads).toEqual([
      { kind: "query", type: "pages", filter: { status: "published", slug: "kontakt" }, locale: "en" },
      { kind: "document", type: "pages", id: ids.kontakt, locale: "en" },
      { kind: "query", type: "pages", filter: { status: "published", slug: "entwurf" }, locale: "en" },
      { kind: "query", type: "pages", filter: { status: "published", slug: "entwurf" }, locale: "de" },
    ]);
  });

  it("resolveLinks notes one path per link with the effective locale and the normalized rules, and no document reads", async () => {
    const { content, site, ids } = await seeded();
    const page = expectOk(await content.create("pages", { slug: "links", title: "Links", status: "published", body: `<a href="kestrel:pages:${ids.kontakt}">K</a> <a href="kestrel:pages:${ids.entwurf}">E</a>` }));
    const { reads } = await observeReads(async () => {
      expectOk(await site.resolveLinks("pages", page, { locale: "en", rules }));
      expectOk(await site.resolveLinks("pages", { ...page, _locale: "de" }, { rules: { filter: { status: "published" } } }));
    });
    expect(reads).toEqual([
      { kind: "path", type: "pages", id: ids.kontakt, locale: "en", rules: normalized, path: "/en/kontakt" },
      { kind: "path", type: "pages", id: ids.entwurf, locale: "en", rules: normalized, path: null },
      { kind: "path", type: "pages", id: ids.kontakt, locale: "de", rules: { ...normalized, fallback: false }, path: "/kontakt" },
      { kind: "path", type: "pages", id: ids.entwurf, locale: "de", rules: { ...normalized, fallback: false }, path: null },
    ]);
  });

  it("a link to a type the model does not know notes nothing: no write can ever change it", async () => {
    const { site } = await seeded();
    const { reads } = await observeReads(async () => {
      expectOk(await site.resolveLinks("pages", { id: "x", createdAt: 0, updatedAt: 0, ref: "kestrel:events:e1" }, { locale: "de", rules }));
    });
    expect(reads).toEqual([]);
  });
});
