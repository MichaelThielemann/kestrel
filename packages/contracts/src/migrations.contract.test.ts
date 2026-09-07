import { describe, it, expect, vi } from "vitest";
import type { Content, ContentModel } from "./content.ts";
import type { ApplyResult, LedgerEntry, Migration, MigrationContext, Migrations } from "./migrations.ts";
import { expectErr, expectOk } from "./testing/result.ts";

function applied(result: ApplyResult): LedgerEntry[] {
  if (result.dry) throw new Error("expected a non-dry apply result");
  return result.applied;
}

export const MIGRATIONS_TEST_MODEL: ContentModel = {
  locales: ["de", "en"],
  defaultLocale: "de",
  types: {
    pages: {
      kind: "multi",
      fields: {
        slug: { type: "slug", required: true, unique: true, localized: true },
        title: { type: "text", required: true, localized: true },
        body: { type: "json", localized: true },
        status: { type: "enum", options: ["draft", "published"], required: true, localized: true },
      },
    },
    settings: {
      kind: "single",
      fields: {
        title: { type: "text", localized: true },
      },
    },
  },
};

export function migrationsContractTests(make: (input: { migrations: Migration[]; model?: ContentModel }) => Promise<{ migrations: Migrations; content: Content }>) {
  describe("migrations@1", () => {
    it("lists every configured migration as pending, in config order", async () => {
      const first: Migration = { id: "m1", collection: "pages", up: () => null };
      const second: Migration = { id: "m2", collection: "pages", up: () => null };
      const { migrations } = await make({ migrations: [second, first] });

      const listed = expectOk(await migrations.list());
      expect(listed.applied).toEqual([]);
      expect(listed.pending).toEqual([
        { id: "m2", collection: "pages" },
        { id: "m1", collection: "pages" },
      ]);
      expect(expectOk(await migrations.check())).toEqual(listed.pending);
    });

    it("applies a migration once, records it in the ledger, and is a no-op on a second apply", async () => {
      const up = vi.fn((ctx: MigrationContext) => ({ ...ctx.document, title: `${ctx.document.title as string} v2` }));
      const migration: Migration = { id: "rewrite-title", collection: "pages", up };
      const { migrations, content } = await make({ migrations: [migration] });
      expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft" }));
      expectOk(await content.create("pages", { slug: "b", title: "B", status: "draft" }));

      const result = expectOk(await migrations.apply());
      expect(applied(result)).toHaveLength(1);
      const [entry] = applied(result);
      expect(entry).toMatchObject({ id: "rewrite-title", documents: 2 });
      expect(typeof entry?.appliedAt).toBe("number");
      expect(typeof entry?.durationMs).toBe("number");

      const afterFirst = expectOk(await migrations.list());
      expect(afterFirst.pending).toEqual([]);
      expect(afterFirst.applied.map((e) => e.id)).toEqual(["rewrite-title"]);

      const callsAfterFirst = up.mock.calls.length;
      expect(expectOk(await migrations.apply())).toEqual({ applied: [] });
      expect(up.mock.calls.length).toBe(callsAfterFirst);
    });

    it("records a migration whose up never changes anything, with zero documents", async () => {
      const migration: Migration = { id: "noop", collection: "pages", up: () => null };
      const { migrations, content } = await make({ migrations: [migration] });
      expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft" }));

      const result = expectOk(await migrations.apply());
      expect(applied(result)).toEqual([expect.objectContaining({ id: "noop", documents: 0 })]);
      expect(expectOk(await migrations.list()).pending).toEqual([]);
    });

    it("a dry run reports the changes without writing or touching the ledger", async () => {
      const migration: Migration = { id: "dry-rewrite", collection: "pages", up: (ctx) => ({ ...ctx.document, title: "Changed" }) };
      const { migrations, content } = await make({ migrations: [migration] });
      const created = expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft" }));

      expect(expectOk(await migrations.apply({ dry: true }))).toEqual({ dry: true, changes: [{ id: "dry-rewrite", documents: 1 }] });

      const unchanged = expectOk(await content.get("pages", created.id));
      expect(unchanged?.title).toBe("A");
      expect(expectOk(await migrations.list()).pending).toEqual([{ id: "dry-rewrite", collection: "pages" }]);
    });

    it("runs per stored locale and skips a locale that has no translation", async () => {
      const calls: Array<{ id: string; locale: string | undefined }> = [];
      const up = (ctx: MigrationContext) => {
        calls.push({ id: ctx.document.id, locale: ctx.locale });
        return { ...ctx.document, title: `${ctx.document.title as string}-${ctx.locale}` };
      };
      const migration: Migration = { id: "per-locale", collection: "pages", up };
      const { migrations, content } = await make({ migrations: [migration] });

      const both = expectOk(await content.create("pages", { slug: "both", title: "Both", status: "draft" }));
      expectOk(await content.update("pages", both.id, { title: "Both", status: "draft" }, { locale: "en" }));
      const deOnly = expectOk(await content.create("pages", { slug: "de-only", title: "DeOnly", status: "draft" }));

      expectOk(await migrations.apply());

      const bothDe = expectOk(await content.get("pages", both.id, { locale: "de" }));
      const bothEn = expectOk(await content.get("pages", both.id, { locale: "en" }));
      expect(bothDe?.title).toBe("Both-de");
      expect(bothEn?.title).toBe("Both-en");

      expect(calls.filter((c) => c.id === deOnly.id)).toEqual([{ id: deOnly.id, locale: "de" }]);
    });

    it("a failing migration is MIGRATION_FAILED, naming the migration, the document and the locale, and stays pending", async () => {
      const migration: Migration = { id: "bad", collection: "pages", up: (ctx) => ({ ...ctx.document, status: "nonsense" }) };
      const { migrations, content } = await make({ migrations: [migration] });
      const doc = expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft" }));

      const error = expectErr(await migrations.apply(), "MIGRATION_FAILED");
      expect(error.message).toMatch(/^migrations: "bad" failed on pages\/\S+ locale de: /);
      expect(error.message).toContain(doc.id);
      expect(error.details?.migration).toBe("bad");

      expect(expectOk(await migrations.list()).pending).toEqual([{ id: "bad", collection: "pages" }]);
    });

    it("a second apply while one is running is a CONFLICT", async () => {
      const migration: Migration = { id: "slow", collection: "pages", up: () => null };
      const { migrations, content } = await make({ migrations: [migration] });
      expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft" }));

      const running = migrations.apply();
      expectErr(await migrations.apply(), "CONFLICT");
      expectOk(await running);
    });

    it("also migrates a single-kind type", async () => {
      const migration: Migration = { id: "settings-upper", collection: "settings", up: (ctx) => ({ ...ctx.document, title: (ctx.document.title as string).toUpperCase() }) };
      const { migrations, content } = await make({ migrations: [migration] });
      expectOk(await content.set("settings", { title: "hello" }));

      const result = expectOk(await migrations.apply());
      expect(applied(result)).toEqual([expect.objectContaining({ id: "settings-upper", documents: 1 })]);
      expect(expectOk(await content.get("settings"))?.title).toBe("HELLO");
    });
  });
}
