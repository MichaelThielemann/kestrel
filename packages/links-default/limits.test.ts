import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Content, ContentDocument, ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import type { Document, Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createPersistenceSqlite } from "@michaelthielemann/kestrel-persistence-sqlite/impl";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { ok } from "@michaelthielemann/kestrel/result";
import { createLinksDefault, findUrls, INDEX, LINK_LIMIT_ERROR, MAX_URL_LENGTH, type Fetcher, type LinkEntry } from "./impl.ts";

const model: ContentModel = { locales: ["de", "en"], defaultLocale: "de", types: { pages: { kind: "multi", fields: { title: { type: "text", localized: true }, body: "json" } } } };

function contentOf(docs: Record<string, { title?: string; body?: unknown }>): Content {
  const notImplemented = () => Promise.reject(new Error("not needed"));
  const toDoc = (id: string): ContentDocument | null => {
    const doc = docs[id];
    return doc ? boundaryCast<ContentDocument>({ id, createdAt: 1, updatedAt: 1, title: doc.title ?? null, body: doc.body ?? null }, "host") : null;
  };
  return {
    model: () => model,
    validate: () => ({ ok: true, data: {} }),
    get: async (_type, id) => ok(id === undefined ? null : toDoc(id)),
    list: async () => ok({ items: Object.keys(docs).flatMap((id) => toDoc(id) ?? []), total: Object.keys(docs).length }),
    create: notImplemented,
    set: notImplemented,
    update: notImplemented,
    remove: notImplemented,
    removeTranslation: notImplemented,
  };
}

const publicResolver = async (): Promise<string[]> => ["93.184.215.14"];
const answering: Fetcher = async () => ({ status: 200 });
const base = { timeoutMs: 1000, concurrency: 4, recheckAfterSeconds: 3600, userAgent: "test", allowPrivate: false, maxLinksPerDocument: 1000, checkBudgetSeconds: 3600 };

function manyUrls(count: number, host = "a.example"): string {
  return Array.from({ length: count }, (_, i) => `https://${host}/${i.toString(36)}`).join(" ");
}

describe("link index limits", () => {
  it("stops collecting urls at the given limit", () => {
    expect([...findUrls(manyUrls(10), new Set(), 3)]).toEqual(["https://a.example/0", "https://a.example/1", "https://a.example/2"]);
  });

  it("leaves out a url longer than the url length limit", () => {
    const longest = `https://a.example/${"x".repeat(MAX_URL_LENGTH - 18)}`;
    expect(longest).toHaveLength(MAX_URL_LENGTH);
    expect([...findUrls(`${longest} ${longest}y https://b.example/ok http://a/${"z".repeat(5_000_000)}`)]).toEqual([longest, "https://b.example/ok"]);
  });

  it("stores at most the per-document limit and marks the document as truncated", async () => {
    const id = randomUUID();
    const content = contentOf({ [id]: { title: manyUrls(50_000), body: [manyUrls(50_000, "b.example")] } });
    const db = createFakePersistence();
    const links = await createLinksDefault(base, content, db, answering, Date.now, publicResolver);
    const start = performance.now();
    expect(expectOk(await links.extract("pages", id))).toBe(base.maxLinksPerDocument);
    expect(performance.now() - start).toBeLessThan(500);
    expect(expectOk(await db.count(INDEX, { fromId: id }))).toBe(base.maxLinksPerDocument + 1);
    const marked = expectOk(await links.report()).filter((row) => row.error === LINK_LIMIT_ERROR);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ fromType: "pages", fromId: id, ok: false, status: null });
  });

  it("does not check the truncation marker", async () => {
    const id = randomUUID();
    const content = contentOf({ [id]: { body: [manyUrls(5)] } });
    const db = createFakePersistence();
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      return { status: 200 };
    };
    const links = await createLinksDefault({ ...base, maxLinksPerDocument: 3 }, content, db, fetcher, Date.now, publicResolver);
    expect(expectOk(await links.extract("pages", id))).toBe(3);
    expect(expectOk(await links.check())).toEqual({ urls: 3, checked: 3, broken: 0, skipped: 0 });
    expect(calls.sort()).toEqual(["https://a.example/0", "https://a.example/1", "https://a.example/2"]);
    expect(expectOk(await links.report()).map((row) => [row.url, row.error])).toEqual([["https://a.example/3", LINK_LIMIT_ERROR]]);
  });

  it("keeps the event loop responsive while checking many unreachable urls", async () => {
    const sqlite = createPersistenceSqlite({ file: ":memory:" });
    let updated = 0;
    const db: Persistence = {
      ...sqlite,
      updateOne: <T extends Document>(collection: string, id: string, patch: Partial<Omit<T, "id">>) => {
        updated += 1;
        return sqlite.updateOne<T>(collection, id, patch);
      },
    };
    const links = await createLinksDefault(base, contentOf({}), db, answering, Date.now, publicResolver);
    for (let doc = 0; doc < 40; doc++) {
      const rows = Array.from({ length: 1000 }, (_, i) => ({ url: `http://10.${doc}.${i >> 8}.${i & 255}/p`, fromType: "pages", fromId: `d${doc}`, field: "body", locale: "", ok: null, status: null, error: null, checkedAt: null }));
      expectOk(await db.createMany<LinkEntry>(INDEX, rows));
    }
    const updatedAtTurn = [0];
    let checking = true;
    const turn = () => {
      updatedAtTurn.push(updated);
      if (checking) setImmediate(turn);
    };
    setImmediate(turn);
    try {
      expect(expectOk(await links.check())).toEqual({ urls: 40_000, checked: 0, broken: 40_000, skipped: 40_000 });
    } finally {
      checking = false;
    }
    updatedAtTurn.push(updated);
    const mostBetweenTurns = Math.max(...updatedAtTurn.slice(1).map((count, i) => count - (updatedAtTurn[i] ?? 0)));
    expect(updated).toBe(40_000);
    expect(mostBetweenTurns).toBeLessThanOrEqual(100);
    expect(expectOk(await db.count(INDEX, { error: "private address" }))).toBe(40_000);
  }, 60_000);

  it("ends a run when its time budget is spent and continues with the rest in the next run", async () => {
    const id = randomUUID();
    const content = contentOf({ [id]: { body: [manyUrls(20)] } });
    let t = 1_000_000;
    const slow: Fetcher = async () => {
      t += 1000;
      return { status: 200 };
    };
    const links = await createLinksDefault({ ...base, concurrency: 1, checkBudgetSeconds: 5 }, content, createFakePersistence(), slow, () => t, publicResolver);
    expectOk(await links.extract("pages", id));
    const first = expectOk(await links.check());
    expect(first.checked).toBeGreaterThanOrEqual(5);
    expect(first.checked).toBeLessThan(20);
    const second = expectOk(await links.check());
    expect(first.checked + second.checked).toBeLessThanOrEqual(20);
    let total = first.checked + second.checked;
    for (let run = 0; run < 5 && total < 20; run++) total += expectOk(await links.check()).checked;
    expect(total).toBe(20);
  });
});
