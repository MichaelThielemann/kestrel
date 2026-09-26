import { z } from "zod";
import { BLOBSTORE } from "@michaelthielemann/kestrel-contracts/blobstore";
import { CONTENT } from "@michaelthielemann/kestrel-contracts/content";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { ownedPersistence } from "@michaelthielemann/kestrel-contracts/helpers/persistence.owned";
import type { Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { COLLECTIONS, createRedirects, requestPath, type Move, type Redirects } from "./impl.ts";
import { RedirectRuleError } from "./rules.ts";

export const configSchema = z
  .object({
    type: z.string().min(1).default("redirects"),
    field: z.string().min(1).default("rules"),
    prefix: z.string().default(""),
    key: z.string().min(1).default("redirects.json"),
  })
  .strict();

const RULE_SCHEMA = { type: "object", properties: { pattern: { type: "string" }, target: { type: "string" }, status: { type: "integer", enum: [301, 302, 307, 308] } }, required: ["pattern", "target", "status"] };
const ROW_SCHEMA = { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, status: { type: ["string", "number"] } } };
const MOVE_SCHEMA = { type: "object", properties: { type: { type: "string" }, id: { type: "string" }, locale: { type: "string" }, from: { type: ["string", "null"] }, to: { type: ["string", "null"] }, seq: { type: "number" } }, required: ["type", "id", "locale", "from", "to", "seq"] };
const AUTO_REDIRECT_SCHEMA = { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, type: { type: "string" }, docId: { type: "string" }, locale: { type: "string" }, seq: { type: "number" } }, required: ["from", "to", "type", "docId", "locale", "seq"] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMove(value: unknown): value is Move {
  if (!isRecord(value)) return false;
  return (
    typeof value.type === "string" &&
    value.type !== "" &&
    typeof value.id === "string" &&
    value.id !== "" &&
    typeof value.locale === "string" &&
    (value.from === null || typeof value.from === "string") &&
    (value.to === null || typeof value.to === "string") &&
    typeof value.seq === "number" &&
    Number.isFinite(value.seq)
  );
}

function parseMoves(raw: unknown): Move[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.every(isMove) ? raw : null;
}

export default defineModule({
  name: "redirects/default",
  provides: [],
  requires: [CONTENT, BLOBSTORE, PERSISTENCE],
  configSchema,

  async setup(config, deps): Promise<Redirects & { field: string }> {
    const db = ownedPersistence(deps.get(PERSISTENCE), "redirects/default", COLLECTIONS);
    const redirects = await createRedirects(config, { content: deps.get(CONTENT), blobs: deps.get(BLOBSTORE), db, logger: deps.logger });
    return { ...redirects, field: config.field };
  },

  steps: (redirects) => ({
    validate: async (ctx: Context) => {
      const rules = ctx.payload[redirects.field];
      if (rules === undefined || rules === null) return ok(ctx);
      try {
        const validated = await redirects.validate(rules);
        if (isErr(validated)) return ctx.fail(validated.error);
      } catch (e) {
        if (!(e instanceof RedirectRuleError)) throw e;
        const row = /^Row (\d+):/.exec(e.message);
        return row ? ctx.fail("VALIDATION", `redirects: ${e.message}`, { row: Number(row[1]) }) : ctx.fail("VALIDATION", `redirects: ${e.message}`);
      }
      return ok(ctx);
    },
    recordMoves: async (ctx: Context) => {
      const moves = parseMoves(ctx.payload.moves);
      if (moves === null) return ctx.fail("VALIDATION", "redirects: payload.moves must be a list of { type, id, locale, from, to, seq }");
      const recorded = await redirects.recordMoves(moves);
      if (isErr(recorded)) return ctx.fail(recorded.error);
      const previous = isRecord(ctx.result) ? ctx.result : {};
      return ok({ ...ctx, result: { ...previous, autoRedirects: { recorded: recorded.value.recorded } } });
    },
    lookup: async (ctx: Context) => {
      const hit = await redirects.lookup(requestPath(ctx.params.path ?? ""));
      if (isErr(hit)) return ctx.fail(hit.error);
      return hit.value ? ctx.done({ redirect: hit.value }) : ok(ctx);
    },
    export: async (ctx: Context) => {
      const previous = isRecord(ctx.result) ? ctx.result : {};
      const exported = await redirects.export();
      if (isErr(exported)) return ctx.fail(exported.error);
      return ok({ ...ctx, result: { ...previous, redirects: exported.value } });
    },
    render: async (ctx: Context) => {
      const rendered = await redirects.render();
      if (isErr(rendered)) return ctx.fail(rendered.error);
      return ok({ ...ctx, result: rendered.value });
    },
    listAuto: async (ctx: Context) => {
      const list = await redirects.listAuto();
      if (isErr(list)) return ctx.fail(list.error);
      return ok({ ...ctx, result: list.value });
    },
    removeAuto: async (ctx: Context) => {
      if (ctx.params.path === undefined) return ctx.fail("VALIDATION", "redirects: missing path");
      const removed = await redirects.removeAuto(ctx.params.path);
      if (isErr(removed)) return ctx.fail(removed.error);
      return ok(ctx);
    },
  }),

  describe: (redirects) => ({
    validate: {
      summary: "Compile the redirect rules of the payload; VALIDATION names the offending row, also for a rule that redirects into an active automatic redirect",
      reads: [],
      writes: [],
      input: { type: "object", properties: { [redirects.field]: { type: "array", items: ROW_SCHEMA } }, additionalProperties: false },
      errors: { 400: "Row N: <reason>" },
    },
    recordMoves: {
      summary: "Apply site.pathsMoved moves to the automatic-redirect state: per document the highest seq wins, a tie inside one run favours the destination path",
      reads: ["payload"],
      writes: ["result.autoRedirects"],
      input: { type: "object", properties: { moves: { type: "array", items: MOVE_SCHEMA } }, additionalProperties: true },
      extendsOutput: { type: "object", properties: { autoRedirects: { type: "object", properties: { recorded: { type: "integer" } }, required: ["recorded"] } }, required: ["autoRedirects"] },
      errors: { 400: "payload.moves is missing or malformed" },
    },
    lookup: {
      summary: "End the pipeline with { redirect: { to, status } } on an editor rule or an automatic redirect (a moved document's old path); pass through otherwise",
      reads: ["params.path"],
      writes: ["result?"],
      terminalOutput: {
        type: "object",
        properties: { redirect: { type: "object", properties: { to: { type: "string" }, status: { type: "integer", enum: [301, 302, 307, 308] } }, required: ["to", "status"], additionalProperties: false } },
        required: ["redirect"],
        additionalProperties: false,
      },
    },
    export: {
      summary: "Write redirects.json to the blobstore: editor rules first, then automatic ones (adds `redirects: { rules, skipped }` to the result)",
      reads: [],
      writes: ["result.redirects"],
      extendsOutput: { type: "object", properties: { redirects: { type: "object", properties: { rules: { type: "integer" }, skipped: { type: "array", items: { type: "string" } } }, required: ["rules", "skipped"] } }, required: ["redirects"] },
    },
    render: { summary: "The compiled redirect list (same content as redirects.json)", reads: [], writes: ["result"], output: { type: "array", items: RULE_SCHEMA } },
    listAuto: {
      summary: "Effective automatic redirects (a moved document's old path, sorted by from)",
      reads: [],
      writes: ["result"],
      output: { type: "array", items: AUTO_REDIRECT_SCHEMA },
    },
    removeAuto: {
      summary: "Turn the automatic redirect at params.path into a removed tombstone; a replay of the move that created it cannot restore it",
      reads: ["params.path"],
      writes: [],
      errors: { 400: "missing path", 404: "no automatic redirect at that path" },
    },
  }),
});
