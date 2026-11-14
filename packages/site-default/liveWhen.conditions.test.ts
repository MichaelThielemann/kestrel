import { describe, expect, it } from "vitest";
import type { ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { routedSite } from "./__fixtures__/routed.ts";
import { routeWith } from "./routes.ts";

const MODEL: ContentModel = {
  locales: ["de"],
  defaultLocale: "de",
  types: {
    pages: { kind: "multi", fields: { slug: { type: "slug", required: true }, title: { type: "text", required: true }, retired: { type: "text" } } },
  },
};

describe("site/default: a liveWhen condition that no argument can state is decided by the route", () => {
  for (const liveWhen of [{ retired: null }, { retired: { ne: null } }]) {
    const open = "retired" in liveWhen && liveWhen.retired === null;
    it(`resolves the pages the route publishes when the step names the field of ${JSON.stringify(liveWhen)} without a value`, async () => {
      const { site, content } = await routedSite({ model: MODEL, routes: { pages: routeWith({ home: "home", liveWhen }) } });
      const published = expectOk(await content.create("pages", open ? { slug: "live", title: "Live" } : { slug: "live", title: "Live", retired: "x" }));
      const hidden = expectOk(await content.create("pages", open ? { slug: "hidden", title: "Hidden", retired: "x" } : { slug: "hidden", title: "Hidden" }));
      for (const named of ["", "null"]) {
        const rules = { home: "home", filter: { retired: named } };
        expect(expectOk(await site.resolve("pages", "live", { rules }))).toMatchObject({ id: published.id });
        expect(expectOk(await site.resolve("pages", "hidden", { rules }))).toBeNull();
        const source = { id: "n", createdAt: 0, updatedAt: 0, a: `kestrel:pages:${published.id}`, b: `kestrel:pages:${hidden.id}` };
        const linked = expectOk(await site.resolveLinks("pages", source, { locale: "de", rules: { filter: { retired: named } } }));
        expect(linked._links).toEqual({ [published.id]: { path: "/live", locale: "de" }, [hidden.id]: { broken: true } });
      }
    });
  }
});
