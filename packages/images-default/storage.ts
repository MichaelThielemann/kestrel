import type { Document, Filter, Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import type { Detection, MigrationContext, MigrationNote, ModuleStorage, ShapeMigration, ShapeMigrationError } from "@michaelthielemann/kestrel-contracts/helpers/shape-migrations";
import { isErr, ok, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import { RETIRED, RETIRED_SCHEMA, VARIANTS, VARIANTS_SCHEMA } from "./collections.ts";

/** The module name the storage version row is kept under. */
export const MODULE = "images/default";

/** The storage shape version this release writes. */
export const STORAGE_VERSION = "6.0.0";

/** Fills in the `slot` of 5.x variant and retired rows, keeping one row per slot. */
export const VARIANT_SLOTS = "images-default:variant-slots";

interface VariantRow extends Document {
  mediaId: string | null;
  size: string | null;
  slot: string | null;
  state: string | null;
  updatedAt: number | null;
}

interface RetiredRow extends Document {
  mediaId: string | null;
  file: string | null;
  slot: string | null;
}

const PAGE = 200;
const SAMPLE = 5;

async function prepare(db: Persistence): Promise<Result<void, ShapeMigrationError>> {
  const variants = await db.ensureCollection(VARIANTS, VARIANTS_SCHEMA);
  if (isErr(variants)) return variants;
  return db.ensureCollection(RETIRED, RETIRED_SCHEMA);
}

async function unslotted<T extends Document>(db: Persistence, collection: string, limit?: number): Promise<Result<T[], ShapeMigrationError>> {
  const rows: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const filter: Filter = cursor === null ? { slot: { eq: null } } : { slot: { eq: null }, id: { gt: cursor } };
    const page: Result<{ items: T[] }, ShapeMigrationError> = await db.findMany<T>(collection, filter, { sort: { id: "asc" }, limit: PAGE });
    if (isErr(page)) return page;
    rows.push(...page.value.items);
    if (page.value.items.length < PAGE || (limit !== undefined && rows.length >= limit)) return ok(rows);
    cursor = page.value.items[page.value.items.length - 1]!.id;
  }
}

function slotOf(mediaId: string, name: string): string {
  return `${mediaId}/${name}`;
}

function rank(row: VariantRow): [number, number, string] {
  return [row.state === "done" ? 1 : 0, row.updatedAt ?? 0, row.id];
}

function newer(a: VariantRow, b: VariantRow): boolean {
  const [x, y] = [rank(a), rank(b)];
  return x[0] !== y[0] ? x[0] > y[0] : x[1] !== y[1] ? x[1] > y[1] : x[2] > y[2];
}

/** The storage of images/default: one migration, `images-default:variant-slots`, after media/default's. */
export function storage(): ModuleStorage {
  const detect = async (ctx: MigrationContext): Promise<Result<Detection, ShapeMigrationError>> => {
    const prepared = await prepare(ctx.db);
    if (isErr(prepared)) return prepared;
    const variants = await ctx.db.count(VARIANTS, { slot: { eq: null } });
    if (isErr(variants)) return variants;
    const retired = await ctx.db.count(RETIRED, { slot: { eq: null } });
    if (isErr(retired)) return retired;
    const sample = await unslotted<Document>(ctx.db, VARIANTS, SAMPLE);
    if (isErr(sample)) return sample;
    return ok({ pending: variants.value + retired.value, sample: sample.value.slice(0, SAMPLE).map((r) => r.id) });
  };

  const variantSlots: ShapeMigration = {
    id: VARIANT_SLOTS,
    introducedIn: "6.0.0",
    kind: "auto",
    blobWrites: false,
    summary: "fills in slot = <mediaId>/<size> on each variant row and <mediaId>/<file> on each retired row; of several variant rows for the same slot the newest finished one stays and the others are dropped, a row without an item or size is dropped",
    detect,

    async plan(ctx) {
      const prepared = await prepare(ctx.db);
      if (isErr(prepared)) return prepared;
      const variants = await unslotted<VariantRow>(ctx.db, VARIANTS);
      if (isErr(variants)) return variants;
      const retired = await unslotted<RetiredRow>(ctx.db, RETIRED);
      if (isErr(retired)) return retired;
      const notes: MigrationNote[] = [];
      const groups = new Map<string, VariantRow[]>();
      let unusable = 0;
      for (const row of variants.value) {
        if (row.mediaId === null || row.size === null) {
          unusable += 1;
          notes.push({ item: row.id, reason: "variant row without an item or size is dropped" });
          continue;
        }
        const slot = slotOf(row.mediaId, row.size);
        groups.set(slot, [...(groups.get(slot) ?? []), row]);
      }
      let duplicates = 0;
      for (const [slot, rows] of groups) {
        const taken = await ctx.db.count(VARIANTS, { slot });
        if (isErr(taken)) return taken;
        const dropped = rows.length - (taken.value > 0 ? 0 : 1);
        duplicates += dropped;
        if (dropped > 0) notes.push({ item: slot, reason: `${dropped} duplicate variant row(s) dropped` });
      }
      const unusableRetired = retired.value.filter((r) => r.mediaId === null || r.file === null).length;
      return ok({ counts: { variants: variants.value.length, duplicateVariants: duplicates, unusableVariants: unusable, retired: retired.value.length, unusableRetired }, notes });
    },

    async apply(ctx) {
      const prepared = await prepare(ctx.db);
      if (isErr(prepared)) return prepared;
      const notes: MigrationNote[] = [];
      let slotted = 0;
      let dropped = 0;
      for (;;) {
        const page = await ctx.db.findMany<VariantRow>(VARIANTS, { slot: { eq: null } }, { sort: { id: "asc" }, limit: PAGE });
        if (isErr(page)) return page;
        if (page.value.items.length === 0) break;
        const handled = new Set<string>();
        for (const row of page.value.items) {
          if (handled.has(row.id)) continue;
          handled.add(row.id);
          if (row.mediaId === null || row.size === null) {
            const gone = await ctx.db.deleteOne(VARIANTS, row.id);
            if (isErr(gone)) return gone;
            dropped += 1;
            notes.push({ item: row.id, reason: "variant row without an item or size dropped" });
            continue;
          }
          const slot = slotOf(row.mediaId, row.size);
          const group = await ctx.db.findMany<VariantRow>(VARIANTS, { mediaId: row.mediaId, size: row.size }, { sort: { id: "asc" }, limit: 1000 });
          if (isErr(group)) return group;
          const holder = await ctx.db.findOne<VariantRow>(VARIANTS, { slot });
          if (isErr(holder)) return holder;
          const candidates = group.value.items.filter((r) => r.slot === null);
          const keeper = holder.value ?? candidates.reduce((best, r) => (newer(r, best) ? r : best));
          for (const other of candidates) {
            handled.add(other.id);
            if (other.id === keeper.id) continue;
            const gone = await ctx.db.deleteOne(VARIANTS, other.id);
            if (isErr(gone)) return gone;
            dropped += 1;
            notes.push({ item: other.id, reason: `duplicate of ${slot}; ${keeper.id} stays` });
          }
          if (keeper.slot === null) {
            const set = await ctx.db.updateOne(VARIANTS, keeper.id, { slot });
            if (isErr(set)) return set;
            slotted += 1;
          }
        }
      }
      let retiredSlotted = 0;
      let retiredDropped = 0;
      for (;;) {
        const page = await ctx.db.findMany<RetiredRow>(RETIRED, { slot: { eq: null } }, { sort: { id: "asc" }, limit: PAGE });
        if (isErr(page)) return page;
        if (page.value.items.length === 0) break;
        for (const row of page.value.items) {
          const slot = row.mediaId === null || row.file === null ? null : slotOf(row.mediaId, row.file);
          const holder = slot === null ? ok(null) : await ctx.db.findOne<RetiredRow>(RETIRED, { slot });
          if (isErr(holder)) return holder;
          if (slot === null || holder.value !== null) {
            const gone = await ctx.db.deleteOne(RETIRED, row.id);
            if (isErr(gone)) return gone;
            retiredDropped += 1;
            notes.push({ item: row.id, reason: slot === null ? "retired row without an item or file dropped" : `duplicate retired row of ${slot} dropped` });
            continue;
          }
          const set = await ctx.db.updateOne(RETIRED, row.id, { slot });
          if (isErr(set)) return set;
          retiredSlotted += 1;
        }
      }
      return ok({ counts: { variantsSlotted: slotted, variantsDropped: dropped, retiredSlotted, retiredDropped }, notes });
    },
  };

  return { module: MODULE, version: STORAGE_VERSION, convertsFrom: "5.0.0", dependsOn: ["media/default"], migrations: [variantSlots] };
}

/** Every migration of images/default. */
export const migrations: readonly ShapeMigration[] = storage().migrations;
