import { describe, expect, it, vi } from "vitest";
import { createContentDefault } from "@michaelthielemann/kestrel-content-default/impl";
import type { Content, ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { migrationsContractTests, MIGRATIONS_TEST_MODEL } from "@michaelthielemann/kestrel-contracts/migrations.contract.test";
import type { ApplyResult, LedgerEntry, Migration, MigrationContext, MigrationsError } from "@michaelthielemann/kestrel-contracts/migrations";
import type { Result } from "@michaelthielemann/kestrel-contracts/errors";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import type { Validate, Validation } from "@michaelthielemann/kestrel-contracts/validate";
import type { Events } from "@michaelthielemann/kestrel-contracts/events";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { defineMigration, mapBlocks, omit, renameBlock, type Block } from "./helpers.ts";
import { createMigrations, type MigrationsDefault } from "./impl.ts";

const noLogger: Logger = { step() {}, info() {}, error() {} };

const MODEL_WITH_REDIRECTS: ContentModel = {
  ...MIGRATIONS_TEST_MODEL,
  types: { ...MIGRATIONS_TEST_MODEL.types, redirects: { kind: "multi", fields: { rules: "json" } } },
};

const MODEL_WITH_PRIORITY: ContentModel = {
  ...MIGRATIONS_TEST_MODEL,
  types: {
    ...MIGRATIONS_TEST_MODEL.types,
    pages: { ...MIGRATIONS_TEST_MODEL.types.pages!, fields: { ...MIGRATIONS_TEST_MODEL.types.pages!.fields, priority: "number" } },
  },
};

const MODEL_WITH_TAGS: ContentModel = {
  ...MIGRATIONS_TEST_MODEL,
  types: {
    ...MIGRATIONS_TEST_MODEL.types,
    pages: { ...MIGRATIONS_TEST_MODEL.types.pages!, fields: { ...MIGRATIONS_TEST_MODEL.types.pages!.fields, tags: "json" } },
  },
};

function fakeEvents(): Events & { emitted: Array<{ name: string; data: Record<string, unknown> }> } {
  const emitted: Array<{ name: string; data: Record<string, unknown> }> = [];
  return {
    emitted,
    emit: vi.fn(async (name: string, data: Record<string, unknown>) => {
      emitted.push({ name, data: Object.freeze({ ...data }) });
    }),
    on: () => () => {},
  };
}

function fakeValidate(target: string, rejects: (value: unknown) => boolean, message = "invalid"): Validate {
  return {
    targets: () => [target],
    check: (t, value): Validation => (t === target && rejects(value) ? { ok: false, problems: [{ path: "/", message }] } : { ok: true, problems: [] }),
  };
}

interface TestSetup {
  migrations: MigrationsDefault;
  content: Content;
  db: ReturnType<typeof createFakePersistence>;
  events: Events & { emitted: Array<{ name: string; data: Record<string, unknown> }> };
}

async function createTestMigrations(options: {
  migrations: Migration[];
  model?: ContentModel;
  content?: Content;
  chunk?: number;
  validate?: Validate;
  now?: () => number;
}): Promise<TestSetup> {
  const db = createFakePersistence();
  const content = options.content ?? (await createContentDefault(options.model ?? MIGRATIONS_TEST_MODEL, db));
  const events = fakeEvents();
  const migrations = await createMigrations(
    { migrations: options.migrations, chunk: options.chunk ?? 50 },
    { content, db, events, logger: noLogger, ...(options.validate === undefined ? {} : { validate: options.validate }), ...(options.now === undefined ? {} : { now: options.now }) },
  );
  return { migrations, content, db, events };
}

function applied(result: ApplyResult): LedgerEntry[] {
  if (result.dry) throw new Error("expected a non-dry apply result");
  return result.applied;
}

migrationsContractTests(async ({ migrations, model }) => {
  const setup = await createTestMigrations({ migrations, ...(model === undefined ? {} : { model }) });
  return { migrations: setup.migrations, content: setup.content };
});

describe("migrations/default construction", () => {
  it("rejects a duplicate id", async () => {
    const db = createFakePersistence();
    const content = await createContentDefault(MIGRATIONS_TEST_MODEL, db);
    const migrations: Migration[] = [
      { id: "m1", collection: "pages", up: () => null },
      { id: "m1", collection: "pages", up: () => null },
    ];
    await expect(createMigrations({ migrations, chunk: 50 }, { content, db, events: fakeEvents(), logger: noLogger })).rejects.toThrow(/duplicate id "m1"/);
  });

  it("rejects a migration naming an unknown collection", async () => {
    const db = createFakePersistence();
    const content = await createContentDefault(MIGRATIONS_TEST_MODEL, db);
    const migrations: Migration[] = [{ id: "m1", collection: "nope", up: () => null }];
    await expect(createMigrations({ migrations, chunk: 50 }, { content, db, events: fakeEvents(), logger: noLogger })).rejects.toThrow(/unknown collection "nope"/);
  });

  it("rejects an id that does not match the id pattern", async () => {
    const db = createFakePersistence();
    const content = await createContentDefault(MIGRATIONS_TEST_MODEL, db);
    const migrations: Migration[] = [{ id: "bad id!", collection: "pages", up: () => null }];
    await expect(createMigrations({ migrations, chunk: 50 }, { content, db, events: fakeEvents(), logger: noLogger })).rejects.toThrow(/invalid id "bad id!"/);
  });

  it("fails construction when the ledger collection cannot be prepared", async () => {
    const db = createFakePersistence();
    const content = await createContentDefault(MIGRATIONS_TEST_MODEL, db);
    db.failNext("TRANSIENT");
    await expect(createMigrations({ migrations: [], chunk: 50 }, { content, db, events: fakeEvents(), logger: noLogger })).rejects.toThrow(/ledger collection could not be prepared/);
  });
});

describe("migrations/default transient persistence", () => {
  it("propagates a transient ledger read as TRANSIENT from list, check and apply", async () => {
    const { migrations, db } = await createTestMigrations({ migrations: [{ id: "m1", collection: "pages", up: () => null }] });

    const calls: Array<() => Promise<Result<unknown, MigrationsError>>> = [() => migrations.list(), () => migrations.check(), () => migrations.apply()];
    for (const call of calls) {
      db.failNext("TRANSIENT");
      const error = expectErr(await call(), "TRANSIENT");
      expect(error.status).toBe(503);
      expect(error.retryable).toBe(true);
    }
  });
});

describe("migrations/default events", () => {
  it("emits exactly one migrations.applied event with the applied ids and total changed documents", async () => {
    const m1: Migration = { id: "m1", collection: "pages", up: (ctx) => ({ ...ctx.document, title: "X" }) };
    const m2: Migration = { id: "m2", collection: "pages", up: (ctx) => ({ ...ctx.document, title: `${ctx.document.title as string}!` }) };
    const { migrations, content, events } = await createTestMigrations({ migrations: [m1, m2] });
    expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft" }));
    expectOk(await content.create("pages", { slug: "b", title: "B", status: "draft" }));

    expectOk(await migrations.apply());

    expect(events.emitted).toEqual([{ name: "migrations.applied", data: { migrations: ["m1", "m2"], documents: 4 } }]);
  });

  it("logs a failing migrations.applied listener instead of failing the run", async () => {
    const migration: Migration = { id: "m1", collection: "pages", up: ({ document }) => ({ ...document, title: `${document.title as string}!` }) };
    const db = createFakePersistence();
    const content = await createContentDefault(MIGRATIONS_TEST_MODEL, db);
    expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft" }));
    const errors: string[] = [];
    const logger: Logger = { ...noLogger, error: (message) => void errors.push(message) };
    const events: Events = {
      emit: async () => {
        throw new AggregateError([new Error("boom")], "events: 1 handler(s) failed");
      },
      on: () => () => {},
    };
    const migrations = await createMigrations({ migrations: [migration], chunk: 50 }, { content, db, events, logger });
    expect(applied(expectOk(await migrations.apply()))).toHaveLength(1);
    expect(errors).toEqual(["migrations: a migrations.applied listener failed"]);
    expect(expectOk(await migrations.list()).pending).toEqual([]);
  });

  it("does not emit anything when nothing was pending", async () => {
    const { migrations, events } = await createTestMigrations({ migrations: [] });
    expectOk(await migrations.apply());
    expect(events.emitted).toEqual([]);
  });

  it("does not emit anything on a dry run", async () => {
    const migration: Migration = { id: "m1", collection: "pages", up: (ctx) => ({ ...ctx.document, title: "X" }) };
    const { migrations, content, events } = await createTestMigrations({ migrations: [migration] });
    expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft" }));
    expectOk(await migrations.apply({ dry: true }));
    expect(events.emitted).toEqual([]);
  });
});

describe("migrations/default busy", () => {
  it("a second concurrent apply() answers CONFLICT while the first is still running", async () => {
    const db = createFakePersistence();
    const content = await createContentDefault(MIGRATIONS_TEST_MODEL, db);
    expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft" }));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowContent: Content = {
      ...content,
      async get(type, id, options) {
        await gate;
        return content.get(type, id, options);
      },
    };

    const migration: Migration = { id: "m1", collection: "pages", up: (ctx) => ({ ...ctx.document, title: "changed" }) };
    const migrations = await createMigrations({ migrations: [migration], chunk: 50 }, { content: slowContent, db, events: fakeEvents(), logger: noLogger });

    const first = migrations.apply();
    const error = expectErr(await migrations.apply(), "CONFLICT");
    expect(error.status).toBe(409);
    expect(error.message).toBe("migrations: apply is running");
    release();
    expectOk(await first);
  });
});

describe("migrations/default validate@1", () => {
  it("a validate@1 problem on a patch field fails the migration and leaves the ledger untouched", async () => {
    const validate = fakeValidate("pages.body", (value) => value === "bad");
    const migration: Migration = { id: "m1", collection: "pages", up: (ctx) => ({ ...ctx.document, body: "bad" }) };
    const { migrations, content } = await createTestMigrations({ migrations: [migration], validate });
    expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft", body: "ok" }));

    const error = expectErr(await migrations.apply(), "MIGRATION_FAILED");
    expect(error.status).toBe(500);
    expect(error.message).toMatch(/body \/ invalid/);
    expect(error.details?.migration).toBe("m1");
    expect(error.details?.locale).toBe("de");
    expect(error.details?.problems).toEqual([{ field: "body", path: "/", message: "invalid" }]);
    expect(expectOk(await migrations.list()).pending).toEqual([{ id: "m1", collection: "pages" }]);
  });

  it("does not check a patch field with no registered validate@1 target, even against another field's own target", async () => {
    const validate = fakeValidate("pages.title", (value) => value === "bad-value");
    const migration: Migration = { id: "m1", collection: "pages", up: (ctx) => ({ ...ctx.document, body: "bad-value" }) };
    const { migrations, content } = await createTestMigrations({ migrations: [migration], validate });
    expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft" }));

    expect(applied(expectOk(await migrations.apply()))).toEqual([expect.objectContaining({ id: "m1", documents: 1 })]);
  });

  it("does not call validate for a registered target whose patch value is null", async () => {
    let validateCalled = false;
    const validate: Validate = {
      targets: () => ["pages.tags"],
      check: (): Validation => {
        validateCalled = true;
        return { ok: false, problems: [{ path: "/", message: "should not be called" }] };
      },
    };
    const migration: Migration = { id: "m1", collection: "pages", up: (ctx) => ({ ...ctx.document, title: "New Title", tags: null }) };
    const { migrations, content } = await createTestMigrations({ migrations: [migration], model: MODEL_WITH_TAGS, validate });
    expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft", tags: null }));

    expect(applied(expectOk(await migrations.apply()))).toEqual([expect.objectContaining({ id: "m1", documents: 1 })]);
    expect(validateCalled).toBe(false);
  });
});

describe("migrations/default locale selection", () => {
  it("migrates a collection with no localized fields in a localized model with a single pass (locale undefined)", async () => {
    const calls: (string | undefined)[] = [];
    const up = (ctx: MigrationContext) => {
      calls.push(ctx.locale);
      return { ...ctx.document, rules: [{ from: "/old", to: "/new" }] };
    };
    const migration: Migration = { id: "m1", collection: "redirects", up };
    const { migrations, content } = await createTestMigrations({ migrations: [migration], model: MODEL_WITH_REDIRECTS });
    expectOk(await content.create("redirects", { rules: [] }));

    expectOk(await migrations.apply());

    expect(calls).toEqual([undefined]);
  });

  it("gives one pass with locale undefined when a document's localized fields are null in every locale", async () => {
    const calls: (string | undefined)[] = [];
    const up = (ctx: MigrationContext) => {
      calls.push(ctx.locale);
      return null;
    };
    const migration: Migration = { id: "m1", collection: "settings", up };
    const { migrations, content } = await createTestMigrations({ migrations: [migration] });
    expectOk(await content.set("settings", {}));

    expectOk(await migrations.apply());

    expect(calls).toEqual([undefined]);
  });
});

describe("migrations/default patch diffing", () => {
  it("does not rewrite a non-localized field again in a later locale pass once up returns it unchanged", async () => {
    const up = (ctx: MigrationContext) => ({ ...ctx.document, priority: 5 });
    const migration: Migration = { id: "m1", collection: "pages", up };
    const { migrations, content } = await createTestMigrations({ migrations: [migration], model: MODEL_WITH_PRIORITY });
    const created = expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft", priority: 1 }));
    expectOk(await content.update("pages", created.id, { title: "A", status: "draft" }, { locale: "en" }));
    const updateSpy = vi.spyOn(content, "update");

    expectOk(await migrations.apply());

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith("pages", created.id, { priority: 5 }, { locale: "de" });
  });

  it("does not write a locale's null localized field left untouched by up (no translation invented)", async () => {
    const up = (ctx: MigrationContext) => ({ ...ctx.document, title: `${ctx.document.title as string}!` });
    const migration: Migration = { id: "m1", collection: "pages", up };
    const { migrations, content } = await createTestMigrations({ migrations: [migration] });
    const created = expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft", body: "de-body" }));
    expectOk(await content.update("pages", created.id, { title: "A", status: "draft" }, { locale: "en" }));
    const updateSpy = vi.spyOn(content, "update");

    expectOk(await migrations.apply());

    const en = expectOk(await content.get("pages", created.id, { locale: "en" }));
    expect(en?.body).toBeNull();
    const enCall = updateSpy.mock.calls.find((call) => (call[3] as { locale?: string } | undefined)?.locale === "en");
    expect(enCall?.[2]).not.toHaveProperty("body");
  });

  it("counts an up returning a partial object of only-unchanged values as no change", async () => {
    const up = (ctx: MigrationContext) => ({ title: ctx.document.title });
    const migration: Migration = { id: "m1", collection: "pages", up };
    const { migrations, content } = await createTestMigrations({ migrations: [migration] });
    expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft" }));

    expect(applied(expectOk(await migrations.apply()))).toEqual([expect.objectContaining({ id: "m1", documents: 0 })]);
  });
});

describe("migrations/default partial failure", () => {
  it("emits migrations.applied for the migrations already applied in this run before answering MIGRATION_FAILED", async () => {
    const m1: Migration = { id: "m1", collection: "pages", up: (ctx) => ({ ...ctx.document, title: "X" }) };
    const m2: Migration = { id: "m2", collection: "pages", up: (ctx) => ({ ...ctx.document, status: "nonsense" }) };
    const { migrations, content, events } = await createTestMigrations({ migrations: [m1, m2] });
    expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft" }));

    const error = expectErr(await migrations.apply(), "MIGRATION_FAILED");
    expect(error.details?.migration).toBe("m2");

    expect(events.emitted).toEqual([{ name: "migrations.applied", data: { migrations: ["m1"], documents: 1 } }]);
    expect(expectOk(await migrations.list()).pending).toEqual([{ id: "m2", collection: "pages" }]);
  });

  it("reports a throwing up as MIGRATION_FAILED naming the migration and the document", async () => {
    const migration: Migration = {
      id: "boom",
      collection: "pages",
      up: () => {
        throw new Error("up exploded");
      },
    };
    const { migrations, content } = await createTestMigrations({ migrations: [migration] });
    const created = expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft" }));

    const error = expectErr(await migrations.apply(), "MIGRATION_FAILED");
    expect(error.message).toBe(`migrations: "boom" failed on pages/${created.id} locale de: up exploded`);
    expect(error.details).toMatchObject({ migration: "boom", document: created.id, locale: "de" });
  });
});

describe("migrations/default runBoot", () => {
  it('mode "check" throws the exact spec message listing every pending migration', async () => {
    const migrations: Migration[] = [
      { id: "m1", collection: "pages", up: () => null },
      { id: "m2", collection: "pages", up: () => null },
    ];
    const { migrations: m } = await createTestMigrations({ migrations });
    await expect(m.runBoot("check")).rejects.toThrow('migrations: 2 pending migration(s): m1 (pages), m2 (pages) — set mode "apply" to run them');
  });

  it('mode "off" applies nothing', async () => {
    const up = vi.fn(() => null);
    const { migrations: m } = await createTestMigrations({ migrations: [{ id: "m1", collection: "pages", up }] });
    await m.runBoot("off");
    expect(expectOk(await m.list()).pending).toEqual([{ id: "m1", collection: "pages" }]);
    expect(up).not.toHaveBeenCalled();
  });

  it('mode "apply" applies every pending migration', async () => {
    const migration: Migration = { id: "m1", collection: "pages", up: (ctx) => ({ ...ctx.document, title: "X" }) };
    const { migrations: m, content } = await createTestMigrations({ migrations: [migration] });
    expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft" }));
    await m.runBoot("apply");
    expect(expectOk(await m.list()).pending).toEqual([]);
  });

  it('mode "apply" turns a failing migration into a boot failure carrying its message', async () => {
    const migration: Migration = { id: "bad", collection: "pages", up: (ctx) => ({ ...ctx.document, status: "nonsense" }) };
    const { migrations: m, content } = await createTestMigrations({ migrations: [migration] });
    expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft" }));
    await expect(m.runBoot("apply")).rejects.toThrow(/^migrations: "bad" failed on pages\//);
  });
});

describe("migrations/default paging", () => {
  it("visits every document exactly once across pages", async () => {
    const seen: string[] = [];
    const up = (ctx: MigrationContext) => {
      seen.push(ctx.document.id);
      return null;
    };
    const { migrations, content } = await createTestMigrations({ migrations: [{ id: "m1", collection: "pages", up }], chunk: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(expectOk(await content.create("pages", { slug: `s${i}`, title: `T${i}`, status: "draft" })).id);

    expectOk(await migrations.apply());

    expect(seen.slice().sort()).toEqual(ids.slice().sort());
    expect(seen).toHaveLength(5);
  });
});

describe("migrations/default worked example (helpers)", () => {
  it("moves serviced-apartments.images into the first category, end to end", async () => {
    const migration = defineMigration({
      id: "serviced-apartments-images",
      collection: "pages",
      up: ({ document }) =>
        mapBlocks(document, "serviced-apartments", (block) => {
          const props = block.props ?? {};
          const images = props.images;
          const categories = (props.categories as Array<Record<string, unknown>> | undefined) ?? [];
          if (!Array.isArray(images) || categories.length === 0) return block;
          const [first, ...rest] = categories;
          return { ...block, props: omit({ ...props, categories: [{ ...first, images }, ...rest] }, "images") };
        }),
    });
    const { migrations, content } = await createTestMigrations({ migrations: [migration] });
    const created = expectOk(
      await content.create("pages", {
        slug: "a",
        title: "A",
        status: "draft",
        body: [{ type: "serviced-apartments", props: { images: ["a.jpg", "b.jpg"], categories: [{ name: "Studio" }, { name: "Suite" }] } }],
      }),
    );

    expectOk(await migrations.apply());

    const after = expectOk(await content.get("pages", created.id));
    const blocks = after?.body as Block[];
    expect(blocks[0]?.props?.images).toBeUndefined();
    expect(blocks[0]?.props?.categories).toEqual([{ name: "Studio", images: ["a.jpg", "b.jpg"] }, { name: "Suite" }]);
  });

  it("renames a block type, end to end", async () => {
    const migration: Migration = { id: "rename-apartments", collection: "pages", up: ({ document }) => renameBlock(document, "serviced-apartments", "apartments") };
    const { migrations, content } = await createTestMigrations({ migrations: [migration] });
    const created = expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft", body: [{ type: "serviced-apartments", props: {} }] }));

    expectOk(await migrations.apply());

    const after = expectOk(await content.get("pages", created.id));
    expect((after?.body as Block[])[0]?.type).toBe("apartments");
  });
});
