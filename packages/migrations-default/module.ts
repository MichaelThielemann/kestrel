import { z } from "zod";
import { CONTENT } from "@michaelthielemann/kestrel-contracts/content";
import { EVENTS } from "@michaelthielemann/kestrel-contracts/events";
import { MIGRATIONS, type Migration } from "@michaelthielemann/kestrel-contracts/migrations";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { VALIDATE } from "@michaelthielemann/kestrel-contracts/validate";
import type { Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { createMigrations, type MigrationsDefault } from "./impl.ts";

export const configSchema = z
  .object({
    migrations: z.array(
      z
        .object({
          id: z.string().min(1),
          collection: z.string().min(1),
          up: z.custom<Migration["up"]>((v) => typeof v === "function", "up must be a function"),
        })
        .strict(),
    ),
    mode: z.enum(["apply", "check", "off"]).default("apply"),
    chunk: z.number().int().min(1).max(500).default(50),
  })
  .strict();

const LEDGER_SCHEMA = { type: "object", properties: { id: { type: "string" }, appliedAt: { type: "number" }, documents: { type: "number" }, durationMs: { type: "number" } }, required: ["id", "appliedAt", "documents", "durationMs"] };
const PENDING_SCHEMA = { type: "object", properties: { id: { type: "string" }, collection: { type: "string" } }, required: ["id", "collection"] };
const DRY_SCHEMA = { type: "object", properties: { dry: { const: true }, changes: { type: "array", items: { type: "object", properties: { id: { type: "string" }, documents: { type: "number" } }, required: ["id", "documents"] } } }, required: ["dry", "changes"] };
const APPLIED_SCHEMA = { type: "object", properties: { applied: { type: "array", items: LEDGER_SCHEMA } }, required: ["applied"] };

export default defineModule({
  name: "migrations/default",
  provides: [MIGRATIONS],
  requires: [CONTENT, PERSISTENCE, EVENTS],
  optional: [VALIDATE],
  configSchema,

  async setup(config, deps): Promise<MigrationsDefault> {
    const validate = deps.find(VALIDATE);
    const instance = await createMigrations(config, {
      content: deps.get(CONTENT),
      db: deps.get(PERSISTENCE),
      events: deps.get(EVENTS),
      logger: deps.logger,
      ...(validate === undefined ? {} : { validate }),
    });
    await instance.runBoot(config.mode);
    return instance;
  },

  steps: (m) => ({
    list: async (ctx: Context) => {
      const listed = await m.list();
      if (isErr(listed)) return ctx.fail(listed.error);
      return ok({ ...ctx, result: listed.value });
    },

    apply: async (ctx: Context) => {
      const result = await m.apply(ctx.payload.dry === true ? { dry: true } : {});
      if (isErr(result)) return ctx.fail(result.error);
      return ok({ ...ctx, result: result.value });
    },
  }),

  describe: () => ({
    list: {
      summary: "Applied migrations (ledger, oldest first) and still-pending migrations (config order)",
      reads: [],
      writes: ["result"],
      output: { type: "object", properties: { applied: { type: "array", items: LEDGER_SCHEMA }, pending: { type: "array", items: PENDING_SCHEMA } }, required: ["applied", "pending"] },
    },
    apply: {
      summary: "Apply every pending migration; payload.dry === true reports the changes without writing",
      reads: [],
      writes: ["result"],
      input: { type: "object", properties: { dry: { type: "boolean" } }, additionalProperties: false },
      output: { oneOf: [DRY_SCHEMA, APPLIED_SCHEMA] },
      errors: { 409: "another apply() is already running", 500: "a migration failed (message names the migration, document and locale)" },
    },
  }),
});
