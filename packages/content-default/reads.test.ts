import { describe, expect, it } from "vitest";
import type { ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { observeReads } from "@michaelthielemann/kestrel/reads";
import { createContentDefault } from "./impl.ts";

const model: ContentModel = {
  locales: ["de", "en"],
  defaultLocale: "de",
  types: {
    speakers: { kind: "multi", fields: { name: { type: "text", localized: true }, status: { type: "enum", options: ["draft", "published"] } } },
    settings: { kind: "single", fields: { title: { type: "text", localized: true } } },
  },
};

async function seeded() {
  const content = await createContentDefault(model, createFakePersistence());
  const ada = expectOk(await content.create("speakers", { name: "Ada", status: "published" }, { locale: "de" }));
  const grace = expectOk(await content.create("speakers", { name: "Grace", status: "draft" }, { locale: "de" }));
  expectOk(await content.set("settings", { title: "Festival" }, { locale: "de" }));
  return { content, ada, grace };
}

describe("content/default notes what it answers inside a read scope", () => {
  it("get of a multi type notes the document with its locale, for a found and for a missing one", async () => {
    const { content, ada } = await seeded();
    const { reads } = await observeReads(async () => {
      expectOk(await content.get("speakers", ada.id, { locale: "en" }));
      expect(expectOk(await content.get("speakers", "missing", { locale: "de" }))).toBeNull();
    });
    expect(reads).toEqual([
      { kind: "document", type: "speakers", id: ada.id, locale: "en" },
      { kind: "document", type: "speakers", id: "missing", locale: "de" },
    ]);
  });

  it("get of a single type notes the whole type", async () => {
    const { content } = await seeded();
    const { reads } = await observeReads(async () => {
      expectOk(await content.get("settings", undefined, { locale: "de" }));
    });
    expect(reads).toEqual([{ kind: "type", type: "settings" }]);
  });

  it("list notes the query with its filter and locale, then one document per returned item", async () => {
    const { content, ada } = await seeded();
    const { reads } = await observeReads(async () => {
      expectOk(await content.list("speakers", { status: "published" }, { locale: "en", limit: 10 }));
    });
    expect(reads).toEqual([
      { kind: "query", type: "speakers", filter: { status: "published" }, locale: "en" },
      { kind: "document", type: "speakers", id: ada.id, locale: "en" },
    ]);
  });

  it("list without a locale notes the query at the default locale", async () => {
    const { content, ada, grace } = await seeded();
    const { reads } = await observeReads(async () => {
      expectOk(await content.list("speakers"));
    });
    expect(reads[0]).toEqual({ kind: "query", type: "speakers", filter: {}, locale: "de" });
    expect(reads.slice(1).map((r) => (r.kind === "document" ? r.id : "")).sort()).toEqual([ada.id, grace.id].sort());
  });

  it("the noted filter is a copy: changing the caller's object afterwards changes nothing", async () => {
    const { content } = await seeded();
    const filter: Record<string, unknown> = { status: "published" };
    const { reads } = await observeReads(async () => {
      expectOk(await content.list("speakers", filter, { locale: "de" }));
    });
    filter.status = "draft";
    expect(reads[0]).toEqual({ kind: "query", type: "speakers", filter: { status: "published" }, locale: "de" });
  });

  it("lists with a filter a structured clone cannot copy, such as a proxy, inside and outside a scope", async () => {
    const { content, ada } = await seeded();
    const filter = new Proxy({ status: "published" }, {});
    expect(expectOk(await content.list("speakers", filter, { locale: "de" })).items.map((d) => d.id)).toEqual([ada.id]);
    const { reads } = await observeReads(async () => {
      expectOk(await content.list("speakers", filter, { locale: "de" }));
    });
    expect(reads[0]).toEqual({ kind: "query", type: "speakers", filter: { status: "published" }, locale: "de" });
  });

  it("notes nothing outside a scope", async () => {
    const { content, ada } = await seeded();
    expectOk(await content.get("speakers", ada.id));
    const { reads } = await observeReads(async () => {});
    expect(reads).toEqual([]);
  });

  it("writes note nothing", async () => {
    const { content, ada } = await seeded();
    const { reads } = await observeReads(async () => {
      expectOk(await content.update("speakers", ada.id, { name: "Ada L." }, { locale: "de" }));
      expectOk(await content.set("settings", { title: "Festival 2027" }, { locale: "de" }));
    });
    expect(reads).toEqual([]);
  });
});
