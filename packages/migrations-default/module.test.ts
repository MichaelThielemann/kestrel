import { describe, expect, it, vi } from "vitest";
import { createContentDefault } from "@michaelthielemann/kestrel-content-default/impl";
import { CONTENT, type Content } from "@michaelthielemann/kestrel-contracts/content";
import { EVENTS, type Events } from "@michaelthielemann/kestrel-contracts/events";
import { MIGRATIONS_TEST_MODEL } from "@michaelthielemann/kestrel-contracts/migrations.contract.test";
import type { Migration } from "@michaelthielemann/kestrel-contracts/migrations";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence, type FakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { VALIDATE, type Validate, type Validation } from "@michaelthielemann/kestrel-contracts/validate";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import { createContext, type Context, type Step } from "@michaelthielemann/kestrel/context";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import type { MigrationsDefault } from "./impl.ts";
import module, { configSchema } from "./module.ts";

const noLogger: Logger = { step() {}, info() {}, error() {} };

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

function ctx(payload: Record<string, unknown> = {}): Context {
  return createContext({ trigger: { kind: "http", name: "t" }, payload });
}

function fakeValidate(target: string, rejects: (value: unknown) => boolean, message = "invalid"): Validate {
  return {
    targets: () => [target],
    check: (t, value): Validation => (t === target && rejects(value) ? { ok: false, problems: [{ path: "/", message }] } : { ok: true, problems: [] }),
  };
}

interface BootOptions {
  mode?: "apply" | "check" | "off";
  validate?: Validate;
  content?: Content;
  db?: FakePersistence;
}

async function boot(migrations: Migration[], options: BootOptions = {}) {
  const db = options.db ?? createFakePersistence();
  const content = options.content ?? (await createContentDefault(MIGRATIONS_TEST_MODEL, db));
  const events = fakeEvents();
  const providers = new Map<string, unknown>([
    [CONTENT.name, content],
    [PERSISTENCE.name, db],
    [EVENTS.name, events],
    ...(options.validate === undefined ? [] : ([[VALIDATE.name, options.validate]] as [string, unknown][])),
  ]);
  const deps: Deps = {
    get<T>(contract: Contract<T>): T {
      if (!providers.has(contract.name)) throw new Error(`no provider for "${contract.name}"`);
      return providers.get(contract.name) as T;
    },
    find: <T>(contract: Contract<T>): T | undefined => providers.get(contract.name) as T | undefined,
    logger: noLogger,
    root: ".",
  };
  const config = configSchema.parse({ migrations, mode: options.mode ?? "off" });
  const instance = (await module.setup(config, deps)) as MigrationsDefault;
  return { instance, content, db, events };
}

function stepOf(instance: MigrationsDefault, name: "list" | "apply"): Step {
  return module.steps!(instance)[name];
}

describe("migrations/default configSchema", () => {
  it("applies defaults", () => {
    const parsed = configSchema.parse({ migrations: [] });
    expect(parsed).toMatchObject({ migrations: [], mode: "apply", chunk: 50 });
  });

  it("rejects unknown keys", () => {
    expect(configSchema.safeParse({ migrations: [], nope: true }).success).toBe(false);
  });

  it("passes the configured up function through unchanged (same identity)", () => {
    const up = () => null;
    const parsed = configSchema.parse({ migrations: [{ id: "m1", collection: "pages", up }] });
    expect(parsed.migrations[0]?.up).toBe(up);
  });
});

describe("migrations/default boot modes", () => {
  it('mode "check" rejects setup() with the list of pending migrations', async () => {
    const migrations: Migration[] = [
      { id: "m1", collection: "pages", up: () => null },
      { id: "m2", collection: "pages", up: () => null },
    ];
    await expect(boot(migrations, { mode: "check" })).rejects.toThrow('migrations: 2 pending migration(s): m1 (pages), m2 (pages) — set mode "apply" to run them');
  });

  it('mode "off" boots without applying anything', async () => {
    const up = vi.fn(() => null);
    const { instance } = await boot([{ id: "m1", collection: "pages", up }], { mode: "off" });
    expect(expectOk(await instance.list()).pending).toEqual([{ id: "m1", collection: "pages" }]);
    expect(up).not.toHaveBeenCalled();
  });

  it('mode "apply" applies every pending migration at boot', async () => {
    const migration: Migration = { id: "m1", collection: "pages", up: (c) => ({ ...c.document, title: "X" }) };
    const db = createFakePersistence();
    const content = await createContentDefault(MIGRATIONS_TEST_MODEL, db);
    expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft" }));
    const { instance } = await boot([migration], { mode: "apply", db, content });
    expect(expectOk(await instance.list()).pending).toEqual([]);
  });
});

describe("migrations/default steps", () => {
  it("list reports applied and pending migrations", async () => {
    const migration: Migration = { id: "m1", collection: "pages", up: (c) => ({ ...c.document, title: "X" }) };
    const { instance, content } = await boot([migration]);
    expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft" }));

    const before = expectOk(await stepOf(instance, "list")(ctx())).result as { applied: unknown[]; pending: unknown[] };
    expect(before.pending).toEqual([{ id: "m1", collection: "pages" }]);
    expect(before.applied).toEqual([]);
  });

  it("apply dry-runs when payload.dry === true, without writing", async () => {
    const migration: Migration = { id: "m1", collection: "pages", up: (c) => ({ ...c.document, title: "Changed" }) };
    const { instance, content } = await boot([migration]);
    const created = expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft" }));

    const dry = expectOk(await stepOf(instance, "apply")(ctx({ dry: true }))).result;
    expect(dry).toEqual({ dry: true, changes: [{ id: "m1", documents: 1 }] });
    expect(expectOk(await content.get("pages", created.id))?.title).toBe("A");
  });

  it("apply applies every pending migration and reports the ledger entries", async () => {
    const migration: Migration = { id: "m1", collection: "pages", up: (c) => ({ ...c.document, title: "Changed" }) };
    const { instance, content } = await boot([migration]);
    expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft" }));

    const result = expectOk(await stepOf(instance, "apply")(ctx())).result as { applied: Array<{ id: string; documents: number }> };
    expect(result.applied).toEqual([expect.objectContaining({ id: "m1", documents: 1 })]);
  });

  it("apply answers CONFLICT while another apply is running", async () => {
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
    const migration: Migration = { id: "m1", collection: "pages", up: (c) => ({ ...c.document, title: "X" }) };
    const { instance } = await boot([migration], { db, content: slowContent });
    const apply = stepOf(instance, "apply");

    const first = apply(ctx());
    const error = expectErr(await apply(ctx()), "CONFLICT");
    expect(error.status).toBe(409);
    expect(error.message).toBe("migrations: apply is running");
    release();
    expectOk(await first);
  });

  it("apply answers MIGRATION_FAILED with the migration's own message", async () => {
    const migration: Migration = { id: "bad", collection: "pages", up: (c) => ({ ...c.document, status: "nonsense" }) };
    const { instance, content } = await boot([migration]);
    const created = expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft" }));

    const error = expectErr(await stepOf(instance, "apply")(ctx()), "MIGRATION_FAILED");
    expect(error.status).toBe(500);
    expect(error.message).toMatch(new RegExp(`^migrations: "bad" failed on pages/${created.id}`));
    expect(error.details).toMatchObject({ migration: "bad", document: created.id });
  });

  it("both steps answer 503 with retryable: true on a transient persistence failure", async () => {
    const { instance, db } = await boot([{ id: "m1", collection: "pages", up: () => null }]);

    for (const name of ["list", "apply"] as const) {
      db.failNext("TRANSIENT");
      const error = expectErr(await stepOf(instance, name)(ctx()), "TRANSIENT");
      expect(error.status).toBe(503);
      expect(error.retryable).toBe(true);
    }
  });
});

describe("migrations/default validate@1 wiring", () => {
  it("uses a validate@1 provider found via deps.find, failing apply with MIGRATION_FAILED naming the target", async () => {
    const validate = fakeValidate("pages.body", (value) => value === "bad");
    const migration: Migration = { id: "m1", collection: "pages", up: (c) => ({ ...c.document, body: "bad" }) };
    const { instance, content } = await boot([migration], { validate });
    expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft", body: "ok" }));

    const error = expectErr(await stepOf(instance, "apply")(ctx()), "MIGRATION_FAILED");
    expect(error.message).toMatch(/\bbody\b/);
  });

  it("applies the migration successfully when deps.find(VALIDATE) returns undefined", async () => {
    const migration: Migration = { id: "m1", collection: "pages", up: (c) => ({ ...c.document, body: "bad" }) };
    const { instance, content } = await boot([migration]);
    expectOk(await content.create("pages", { slug: "a", title: "A", status: "draft", body: "ok" }));

    const result = expectOk(await stepOf(instance, "apply")(ctx())).result as { applied: Array<{ id: string; documents: number }> };
    expect(result.applied).toEqual([expect.objectContaining({ id: "m1", documents: 1 })]);
  });
});

describe("migrations/default describe", () => {
  it("describes both steps with their dataflow", () => {
    const descriptions = module.describe!(undefined);
    const list = descriptions.list as { summary?: string; reads?: string[]; writes?: string[] };
    expect(typeof list.summary).toBe("string");
    expect(list.reads).toEqual([]);
    expect(list.writes).toEqual(["result"]);

    const apply = descriptions.apply as { summary?: string; reads?: string[]; writes?: string[]; errors?: Record<number, string> };
    expect(typeof apply.summary).toBe("string");
    expect(apply.reads).toEqual([]);
    expect(apply.writes).toEqual(["result"]);
    expect(Object.keys(apply.errors ?? {}).sort()).toEqual(["409", "500"]);
    expect(typeof apply.errors?.[409]).toBe("string");
    expect(typeof apply.errors?.[500]).toBe("string");
  });
});
