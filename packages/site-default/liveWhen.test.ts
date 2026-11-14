import { describe, expect, it } from "vitest";
import type { ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { routedSite } from "./__fixtures__/routed.ts";
import { routeWith } from "./routes.ts";

const MODEL: ContentModel = {
  locales: ["de"],
  defaultLocale: "de",
  types: {
    pages: {
      kind: "multi",
      fields: {
        slug: { type: "slug", required: true },
        title: { type: "text", required: true },
        status: { type: "enum", options: ["draft", "published", "archived"] },
      },
    },
    events: { kind: "multi", fields: { slug: { type: "slug", required: true }, title: { type: "text", required: true } } },
    notes: { kind: "multi", fields: { slug: { type: "slug", required: true }, title: { type: "text", required: true } } },
  },
};

const published = { home: "home", filter: { status: "published" } };

async function seeded(liveWhen: Record<string, unknown> = { status: "published" }) {
  const site = await routedSite({ model: MODEL, routes: { pages: routeWith({ home: "home", liveWhen }), events: routeWith({}) } });
  const live = expectOk(await site.content.create("pages", { slug: "live", title: "Live", status: "published" }));
  const draft = expectOk(await site.content.create("pages", { slug: "secret", title: "Secret", status: "draft" }));
  const event = expectOk(await site.content.create("events", { slug: "fest", title: "Fest" }));
  return { ...site, live, draft, event };
}

describe("site/default: a step filter serves only what the route publishes", () => {
  it("resolve refuses a draft when the step names the value a liveWhen condition excludes", async () => {
    const { site } = await seeded({ status: { ne: "draft" } });
    expect(expectOk(await site.resolve("pages", "secret", { rules: { home: "home", filter: { status: "draft" } } }))).toBeNull();
    expect(expectOk(await site.resolve("pages", "secret", { rules: { home: "home", filter: {} } }))).toMatchObject({ slug: "secret" });
  });

  it("resolve refuses a draft when the step names a value of an eq condition other than the route's", async () => {
    const { site } = await seeded({ status: { eq: "published" } });
    expect(expectOk(await site.resolve("pages", "secret", { rules: { home: "home", filter: { status: "draft" } } }))).toBeNull();
  });
});

describe("site/default: resolveLinks in published mode links by each target's own route", () => {
  it("links a routed type whose route carries no liveWhen field, and omits an unpublished page", async () => {
    const { site, live, draft, event } = await seeded();
    const source = { id: "n", createdAt: 0, updatedAt: 0, body: `<a href="kestrel:events:${event.id}">e</a> <a href="kestrel:pages:${live.id}">l</a> <a href="kestrel:pages:${draft.id}">d</a>` };
    const linked = expectOk(await site.resolveLinks("pages", source, { locale: "de", rules: published }));
    expect(linked._links).toEqual({ [event.id]: { path: "/fest", locale: "de" }, [live.id]: { path: "/live", locale: "de" }, [draft.id]: { broken: true } });
  });

  it("gives an unpublished page its path only when the step carries no filter", async () => {
    const { site, draft } = await seeded();
    const source = { id: "n", createdAt: 0, updatedAt: 0, ref: `kestrel:pages:${draft.id}` };
    expect(expectOk(await site.resolveLinks("notes", source, { locale: "de", rules: { filter: {} } }))._links).toEqual({ [draft.id]: { path: "/secret", locale: "de" } });
    expect(expectOk(await site.resolveLinks("notes", source, { locale: "de", rules: { filter: { status: "published" } } }))._links).toEqual({ [draft.id]: { broken: true } });
  });

  it("does not link an unpublished page whose route condition the step's value would also match", async () => {
    const { site, draft } = await seeded({ status: { in: ["published", "archived"] } });
    const source = { id: "n", createdAt: 0, updatedAt: 0, ref: `kestrel:pages:${draft.id}` };
    expect(expectOk(await site.resolveLinks("notes", source, { locale: "de", rules: { filter: { status: "draft" } } }))._links).toEqual({ [draft.id]: { broken: true } });
  });
});
