import { z } from "zod";
import { CONTENT } from "@michaelthielemann/kestrel-contracts/content";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { first, stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { createReferencesDefault, type References, type Referrer } from "./impl.ts";

export const configSchema = z
  .object({
    targets: z.record(z.union([z.object({ content: z.string().min(1) }).strict(), z.object({ collection: z.string().min(1) }).strict()])),
  })
  .strict();

export default defineModule({
  name: "references/default",
  provides: [],
  requires: [CONTENT, PERSISTENCE],
  configSchema,

  async setup(config, deps): Promise<References> {
    return createReferencesDefault(config, deps.get(CONTENT), deps.get(PERSISTENCE));
  },

  steps: (refs) => ({
    check: stepFactory((type: string) => async (ctx: Context) => {
      const missing = await refs.missing(type, ctx.payload);
      if (isErr(missing)) return ctx.fail(missing.error);
      if (missing.value.length > 0) {
        return ctx.fail("DANGLING_REF", `${type}: ${missing.value.map((m) => `${m.field} references ${m.to}/${m.id} which does not exist`).join("; ")}`, {
          fields: missing.value.map((m) => ({ field: m.field, message: `references ${m.to}/${m.id} which does not exist` })),
          refs: missing.value.map((m) => ({ field: m.field, to: m.to, id: m.id })),
        });
      }
      return ok(ctx);
    }),
    index: stepFactory((type: string) => async (ctx: Context) => {
      const result = ctx.result as { id?: unknown } | undefined;
      const id = result?.id;
      if (typeof id !== "string") throw new Error(`references.index:${type}: no document id in result`);
      const indexed = await refs.index(type, id);
      if (isErr(indexed)) return ctx.fail(indexed.error);
      return ok(ctx);
    }),
    unindex: stepFactory((type: string) => async (ctx: Context) => {
      if (!ctx.params.id) return ctx.fail("VALIDATION", "missing id");
      const removed = await refs.unindex(type, ctx.params.id);
      if (isErr(removed)) return ctx.fail(removed.error);
      return ok(ctx);
    }),
    guard: stepFactory((target: string) => async (ctx: Context) => {
      if (!ctx.params.id) return ctx.fail("VALIDATION", "missing id");
      const referrers = await refs.referrers(target, ctx.params.id);
      if (isErr(referrers)) return ctx.fail(referrers.error);
      if (referrers.value.length > 0) return ctx.fail("CONFLICT", `${target}/${ctx.params.id} is referenced by ${referrers.value.map((r) => `${r.type}/${r.id} (${r.field})`).join(", ")}`, { referrers: referrers.value });
      return ok(ctx);
    }),
    referrers: stepFactory((target: string) => async (ctx: Context) => {
      if (!ctx.params.id) return ctx.fail("VALIDATION", "missing id");
      const referrers = await refs.referrers(target, ctx.params.id);
      if (isErr(referrers)) return ctx.fail(referrers.error);
      return ok({ ...ctx, result: referrers.value });
    }),
    referrersMany: stepFactory((target: string) => async (ctx: Context) => {
      const rawIds: unknown = ctx.payload.ids;
      const raw: string[] = Array.isArray(rawIds) ? rawIds.filter((id): id is string => typeof id === "string") : typeof rawIds === "string" ? [rawIds] : [];
      const ids = [...new Set(raw.flatMap((id) => id.split(",")).map((id) => id.trim()).filter((id) => id !== ""))];
      if (ids.length === 0) return ctx.fail("VALIDATION", "references: missing ids");
      if (ids.length > 200) return ctx.fail("VALIDATION", "references: at most 200 ids");
      const result: Record<string, Referrer[]> = {};
      for (const id of ids) {
        const referrers = await refs.referrers(target, id);
        if (isErr(referrers)) return ctx.fail(referrers.error);
        result[id] = referrers.value;
      }
      return ok({ ...ctx, result });
    }),
    guardAll: stepFactory((target: string) => async (ctx: Context) => {
      const result = ctx.result as { ids?: unknown } | undefined;
      const ids = result?.ids;
      if (!Array.isArray(ids)) throw new Error(`references.guardAll:${target}: no ids in result`);
      const referenced: string[] = [];
      for (const id of ids as string[]) {
        const referrers = await refs.referrers(target, id);
        if (isErr(referrers)) return ctx.fail(referrers.error);
        if (referrers.value.length > 0) referenced.push(id);
      }
      if (referenced.length > 0) return ctx.fail("CONFLICT", `${referenced.length} ${target} item(s) are still referenced: ${referenced.slice(0, 5).map((id) => `${target}/${id}`).join(", ")}${referenced.length > 5 ? ", …" : ""}`, { referenced });
      return ok(ctx);
    }),
    scan: async (ctx: Context) => {
      const result = await refs.scan();
      if (isErr(result)) return ctx.fail(result.error);
      return ok({ ...ctx, result: result.value });
    },
    report: async (ctx: Context) => {
      const result = await refs.report(first(ctx.payload.target));
      if (isErr(result)) return ctx.fail(result.error);
      return ok({ ...ctx, result: result.value });
    },
    rebuild: async (ctx: Context) => {
      const result = await refs.rebuild();
      if (isErr(result)) return ctx.fail(result.error);
      return ok({ ...ctx, result: result.value });
    },
  }),

  describe: () => ({
    check: (type: string) => ({ summary: `Referenced ids of ${type} must exist`, reads: [], writes: [], errors: { 400: "a referenced document does not exist" } }),
    index: (type: string) => ({ summary: `Index the references of a ${type} document`, reads: ["result.id"], writes: [] }),
    unindex: (type: string) => ({ summary: `Drop indexed references of a ${type} document`, reads: ["params.id"], writes: [], errors: { 400: "missing id" } }),
    guard: (target: string) => ({ summary: `Refuse deletion while ${target} is referenced`, reads: ["params.id"], writes: [], errors: { 400: "missing id", 409: "still referenced" } }),
    referrers: (target: string) => ({
      summary: `Documents referencing a ${target}`,
      reads: ["params.id"],
      writes: ["result"],
      errors: { 400: "missing id" },
      output: { type: "array", items: { type: "object", properties: { type: { type: "string" }, field: { type: "string" }, id: { type: "string" }, via: { type: "string", enum: ["field", "body"] } }, required: ["type", "field", "id", "via"] } },
    }),
    referrersMany: (target: string) => ({
      summary: `Documents referencing each of up to 200 ${target} ids`,
      reads: [],
      writes: ["result"],
      query: { ids: { type: "string" } },
      output: { type: "object", additionalProperties: { type: "array", items: { type: "object", properties: { type: { type: "string" }, field: { type: "string" }, id: { type: "string" }, via: { type: "string", enum: ["field", "body"] } }, required: ["type", "field", "id", "via"] } } },
      errors: { 400: "missing ids or more than 200 ids" },
    }),
    guardAll: (target: string) => ({ summary: `Refuse while any of result.ids of ${target} is referenced`, reads: ["result.ids"], writes: [], errors: { 409: "still referenced" } }),
    scan: { summary: "Re-check every reference", reads: [], writes: ["result"], output: { type: "object", properties: { checked: { type: "number" }, broken: { type: "number" } } } },
    report: { summary: "Broken references", reads: [], writes: ["result"], query: { target: { type: "string" } }, output: { type: "array", items: { type: "object", properties: { fromType: { type: "string" }, fromId: { type: "string" }, field: { type: "string" }, locale: { type: "string" }, toTarget: { type: "string" }, toId: { type: "string" }, via: { type: "string", enum: ["field", "body"] }, broken: { type: "boolean" }, checkedAt: { type: ["number", "null"] } } } } },
    rebuild: { summary: "Rebuild the reference index", reads: [], writes: ["result"], output: { type: "object", properties: { documents: { type: "number" }, entries: { type: "number" } } } },
  }),
});
