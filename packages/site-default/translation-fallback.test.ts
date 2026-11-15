import { describe, expect, it } from "vitest";
import type { ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { routedSite } from "./__fixtures__/routed.ts";
import { routeWith } from "./routes.ts";

const MODEL: ContentModel = {
  locales: ["de", "en"],
  defaultLocale: "de",
  types: {
    pages: {
      kind: "multi",
      fields: {
        slug: { type: "slug", required: true, unique: true, localized: true },
        title: { type: "text", required: true, localized: true },
        status: { type: "enum", options: ["draft", "published"], localized: true },
      },
    },
  },
};

describe("site/default: a published translation with its own slug and no title of its own", () => {
  it("is served with the default locale's title, while _translations reports it as incomplete", async () => {
    const { site, content } = await routedSite({ model: MODEL, routes: { pages: routeWith({ home: "home", liveWhen: { status: "published" } }) } });
    const page = expectOk(await content.create("pages", { slug: "seite", title: "Seite", status: "published" }, { locale: "de" }));
    expectOk(await content.update("pages", page.id, { slug: "page", status: "published" }, { locale: "en" }));

    const served = expectOk(await site.resolve("pages", "en/page", { rules: { home: "home", fallback: true, filter: { status: "published" } } }));
    expect(served).toMatchObject({ id: page.id, _locale: "en", slug: "page", title: "Seite", _locales: { slug: "en", title: "de" }, _translations: { de: true, en: false } });
  });
});
