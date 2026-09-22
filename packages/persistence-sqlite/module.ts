import { z } from "zod";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import type { KestrelError } from "@michaelthielemann/kestrel/errors";
import { isErr, ok, type Err } from "@michaelthielemann/kestrel/result";
import { createPersistenceSqlite, persistenceFailure, type PersistenceSqlite } from "./impl.ts";

export const configSchema = z
  .object({
    file: z.string().min(1),
    busyTimeoutMs: z.number().int().min(0).optional(),
    /** How long a request may wait for its turn at the connection before it is answered 503. */
    acquireTimeoutMs: z.number().int().min(100).default(5000),
    /** How long an atomic group may hold the connection once it has it, measured from BEGIN IMMEDIATE. */
    scopeTimeoutMs: z.number().int().min(100).default(5000),
  })
  .strict()
  .superRefine((config, ctx) => {
    const busy = config.busyTimeoutMs ?? 5000;
    if (config.acquireTimeoutMs <= busy) {
      ctx.addIssue({
        code: "custom",
        path: ["acquireTimeoutMs"],
        message: `must be greater than busyTimeoutMs (${busy}); BEGIN IMMEDIATE blocks the event loop for up to that long, so an equal budget expires exactly when the wait succeeded`,
      });
    }
  });

async function guard(ctx: Context, fn: () => Promise<void>): Promise<Err<KestrelError> | null> {
  try {
    await fn();
    return null;
  } catch (cause) {
    const error = persistenceFailure(cause);
    if (error === null) throw cause;
    return ctx.fail(error);
  }
}

export default defineModule({
  name: "persistence/sqlite",
  provides: [PERSISTENCE],
  requires: [],
  configSchema,

  async setup(config, deps): Promise<PersistenceSqlite> {
    return createPersistenceSqlite(config, { logger: deps.logger });
  },

  teardown: (db) => db.close(),

  atomicScope: (db, info, body) => db.scope(info, body),

  steps: (db) => ({
    checkpoint: async (ctx: Context) => (await guard(ctx, () => db.checkpoint())) ?? ok(ctx),
    snapshot: stepFactory((file: string) => async (ctx: Context) => (await guard(ctx, () => db.snapshot(file))) ?? ok({ ...ctx, result: { file } })),
    createOne: stepFactory((collection: string) => async (ctx: Context) => {
      const created = await db.createOne(collection, ctx.payload);
      if (isErr(created)) return ctx.fail(created.error);
      return ok({ ...ctx, result: created.value });
    }),
    findOne: stepFactory((collection: string) => async (ctx: Context) => {
      const doc = await db.findOne(collection, { id: ctx.params.id });
      if (isErr(doc)) return ctx.fail(doc.error);
      if (doc.value === null) return ctx.fail("NOT_FOUND", `${collection}/${ctx.params.id ?? ""} not found`);
      return ok({ ...ctx, result: doc.value });
    }),
    findMany: stepFactory((collection: string) => async (ctx: Context) => {
      const page = await db.findMany(collection, {});
      if (isErr(page)) return ctx.fail(page.error);
      return ok({ ...ctx, result: page.value });
    }),
    updateOne: stepFactory((collection: string) => async (ctx: Context) => {
      if (!ctx.params.id) return ctx.fail("VALIDATION", "missing id");
      const doc = await db.updateOne(collection, ctx.params.id, ctx.payload);
      if (isErr(doc)) return ctx.fail(doc.error);
      return ok({ ...ctx, result: doc.value });
    }),
    deleteOne: stepFactory((collection: string) => async (ctx: Context) => {
      if (!ctx.params.id) return ctx.fail("VALIDATION", "missing id");
      const removed = await db.deleteOne(collection, ctx.params.id);
      if (isErr(removed)) return ctx.fail(removed.error);
      return ok({ ...ctx, result: { ok: true } });
    }),
  }),

  describe: () => ({
    checkpoint: { summary: "Fold the write-ahead log into the main database file", reads: [], writes: [] },
    snapshot: (file: string) => ({
      summary: `Write a transactionally consistent copy of the database to ${file}`,
      reads: [],
      writes: ["result"],
      output: { type: "object", properties: { file: { type: "string" } }, required: ["file"] },
    }),
    createOne: (collection: string) => ({
      summary: `Create one ${collection} document from the payload`,
      reads: [],
      writes: ["result"],
      input: { type: "object", additionalProperties: true },
      output: { type: "object" },
      errors: { 409: "a document with that id or a unique value already exists" },
    }),
    findOne: (collection: string) => ({
      summary: `Read the ${collection} document named by params.id`,
      reads: ["params.id"],
      writes: ["result"],
      output: { type: "object" },
      errors: { 404: "no such document" },
    }),
    findMany: (collection: string) => ({
      summary: `List every ${collection} document`,
      reads: [],
      writes: ["result"],
      output: { type: "object", properties: { items: { type: "array", items: { type: "object" } }, total: { type: "number" } }, required: ["items", "total"] },
    }),
    updateOne: (collection: string) => ({
      summary: `Patch the ${collection} document named by params.id from the payload`,
      reads: ["params.id"],
      writes: ["result"],
      input: { type: "object", additionalProperties: true },
      output: { type: "object" },
      errors: { 400: "missing id", 404: "no such document", 409: "a unique value already exists" },
    }),
    deleteOne: (collection: string) => ({
      summary: `Delete the ${collection} document named by params.id`,
      reads: ["params.id"],
      writes: ["result"],
      output: { type: "object", properties: { ok: { type: "boolean", enum: [true] } }, required: ["ok"] },
      errors: { 400: "missing id" },
    }),
  }),
});
