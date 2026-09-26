import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { createContentDefault } from "@michaelthielemann/kestrel-content-default/impl";
import { ok } from "@michaelthielemann/kestrel-contracts/errors";
import type { Events } from "@michaelthielemann/kestrel-contracts/events";
import type { Renderer } from "@michaelthielemann/kestrel-contracts/renderer";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createSiteDefault, createSitePaths, type Move } from "@michaelthielemann/kestrel-site-default/impl";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { createDeliveryStatic, keyFor, STATUS, type Delivery, type StatusRow } from "./impl.ts";
import { configSchema } from "./module.ts";

const model: ContentModel = {
  locales: ["de", "en"],
  defaultLocale: "de",
  types: {
    pages: {
      kind: "multi",
      fields: {
        slug: { type: "slug", required: true, localized: true },
        title: { type: "text", required: true, localized: true },
        status: { type: "enum", options: ["draft", "published"], localized: true },
        body: { type: "richtext", localized: true },
      },
    },
  },
};

const instances: Delivery[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.close();
});

function memoryBlobs(): Blobstore & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async put(key, data) {
      files.set(key, typeof data === "string" ? data : new TextDecoder().decode(data));
      return ok();
    },
    async get(key) {
      const file = files.get(key);
      return ok(file === undefined ? null : new TextEncoder().encode(file));
    },
    async remove(key) {
      files.delete(key);
      return ok();
    },
    async move(from, to) {
      const file = files.get(from);
      if (file !== undefined) files.set(to, file);
      files.delete(from);
      return ok();
    },
    async list(prefix) {
      return ok([...files].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, size: v.length })));
    },
  };
}

const renderer: Renderer = {
  formats: () => ["html"],
  async render(input) {
    return ok({ data: `<h1>${String(input.document.title)}</h1>${typeof input.document.body === "string" ? input.document.body : ""}`, contentType: "text/html", extension: "html" });
  },
};

async function routedDelivery() {
  const db = createFakePersistence();
  const content = await createContentDefault(model, db);
  const moves: Move[] = [];
  const events: Events = {
    async emit(_name, data) {
      moves.push(...boundaryCast<Move[]>(data.moves, "json"));
    },
    on: () => () => {},
  };
  const paths = await createSitePaths({ routes: { pages: { slugField: "slug", home: "home", liveWhen: { status: "published" }, labelField: "title" } }, prefixPrimary: false, reservedPaths: [] }, { content, db, events, logger: silentLogger });
  const site = createSiteDefault(content, paths);
  const blobs = memoryBlobs();
  const config = configSchema.parse({ types: { pages: {} }, prefix: "site/", dependencies: { render: "background" } });
  const delivery = await createDeliveryStatic(config, { content, site, renderer, blobs, db, logger: silentLogger, events: { emit: async () => {}, on: () => () => {} } });
  instances.push(delivery);

  const save = async (write: () => Promise<string>): Promise<string> => {
    const runId = randomUUID();
    let id = "";
    const outcome = await db.scope({ pipeline: "test", group: 1 }, async () => {
      id = await write();
      expectOk(await paths.index("pages", id, runId));
      return "commit";
    });
    expect(outcome).toEqual({ kind: "settled", verdict: "commit" });
    await paths.announce(runId);
    return id;
  };
  const create = (fields: Record<string, unknown>) => save(async () => expectOk(await content.create("pages", fields)).id);
  const update = (id: string, patch: Record<string, unknown>, locale?: string) => save(async () => expectOk(await content.update("pages", id, patch, locale === undefined ? {} : { locale })).id);
  const html = (path: string): string | null => blobs.files.get(keyFor("site/", path, "html")) ?? null;
  const marked = async (): Promise<string[]> => expectOk(await db.findMany<StatusRow>(STATUS, { staleToken: { ne: null } }, { sort: { docId: "asc", locale: "asc" } })).items.map((r) => `${r.docId}/${r.locale}`);
  const settle = async (): Promise<void> => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const status = expectOk(await delivery.readStaleStatus());
      if (status.stale === 0 && status.rendering === 0) return;
      if (Date.now() > deadline) throw new Error(`still stale: ${JSON.stringify(status)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return { delivery, moves, create, update, html, marked, settle };
}

describe("delivery/static: re-rendering moved outputs", () => {
  it("a rename marks the renamed page's outputs and every page linking to it, and the renders move the files and the links", async () => {
    const h = await routedDelivery();
    const a = await h.create({ slug: "a", title: "A", status: "published" });
    const linker = await h.create({ slug: "linker", title: "Linker", status: "published", body: `<a href="kestrel:pages:${a}">A</a>` });
    const other = await h.create({ slug: "other", title: "Other", status: "published" });
    for (const id of [a, linker, other]) expectOk(await h.delivery.publish("pages", id));
    expect(h.html("/linker")).toContain('href="/a"');
    h.moves.length = 0;

    await h.update(a, { slug: "a-neu" });
    expect(h.moves.map(({ id, from, to }) => ({ id, from, to }))).toEqual([{ id: a, from: "/a", to: "/a-neu" }]);
    const outcome = expectOk(await h.delivery.markMoved(h.moves));
    expect(outcome.marked).toBeGreaterThanOrEqual(2);
    expect(await h.marked()).toEqual(expect.arrayContaining([`${a}/de`, `${linker}/de`]));
    expect(await h.marked()).not.toContain(`${other}/de`);

    await h.settle();
    expect(h.html("/a")).toBeNull();
    expect(h.html("/a-neu")).toContain("<h1>A</h1>");
    expect(h.html("/linker")).toContain('href="/a-neu"');
    expect(h.html("/other")).toContain("<h1>Other</h1>");
  });

  it("swapped slugs leave each page's files at its new path", async () => {
    const h = await routedDelivery();
    const x = await h.create({ slug: "x", title: "X", status: "published" });
    const y = await h.create({ slug: "y", title: "Y", status: "published" });
    for (const id of [x, y]) expectOk(await h.delivery.publish("pages", id));
    h.moves.length = 0;

    await h.update(x, { slug: "zwischen" });
    await h.update(y, { slug: "x" });
    await h.update(x, { slug: "y" });
    expectOk(await h.delivery.markMoved(h.moves));
    await h.settle();
    expect(h.html("/x")).toContain("<h1>Y</h1>");
    expect(h.html("/y")).toContain("<h1>X</h1>");
    expect(h.html("/zwischen")).toBeNull();
  });

  it("an output whose path another page holds is an error without a public path", async () => {
    const h = await routedDelivery();
    const shadowed = await h.create({ slug: "p", title: "P", status: "published" });
    await h.update(shadowed, { title: "P EN", status: "published" }, "en");
    const owner = await h.create({ slug: "q", title: "Q", status: "published" });
    await h.update(owner, { slug: "p", title: "Q EN", status: "published" }, "en");
    const statuses = expectOk(await h.delivery.publish("pages", shadowed));
    expect(statuses.find((s) => s.locale === "en")).toMatchObject({ state: "error", path: null, error: "no public path" });
    expect(statuses.find((s) => s.locale === "de")).toMatchObject({ state: "live", path: "/p" });
  });
});
