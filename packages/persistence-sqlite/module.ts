import { z } from "zod";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import type { KestrelError } from "@michaelthielemann/kestrel/errors";
import { isErr, ok, type Err } from "@michaelthielemann/kestrel/result";
import { createPersistenceSqlite, persistenceFailure, type PersistenceSqlite } from "./impl.ts";

export const configSchema = z.object({ file: z.string().min(1), busyTimeoutMs: z.number().int().min(0).optional() }).strict();

// checkpoint/snapshot are maintenance calls outside persistence@1, so they signal a locked database
// by throwing; the step turns that into the same TRANSIENT the contract methods return.
function guard(ctx: Context, fn: () => void): Err<KestrelError> | null {
  try {
    fn();
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

  async setup(config): Promise<PersistenceSqlite> {
    return createPersistenceSqlite(config);
  },

  teardown: (db) => db.close(),

  steps: (db) => ({
    checkpoint: async (ctx: Context) => guard(ctx, () => db.checkpoint()) ?? ok(ctx),
    snapshot: stepFactory((file: string) => async (ctx: Context) => guard(ctx, () => db.snapshot(file)) ?? ok({ ...ctx, result: { file } })),
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
      errors: { 409: "a document with that id or a unique value already exists" },
    }),
    findOne: (collection: string) => ({
      summary: `Read the ${collection} document named by params.id`,
      reads: ["params.id"],
      writes: ["result"],
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
