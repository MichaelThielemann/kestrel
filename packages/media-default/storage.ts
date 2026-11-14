import type { Document, Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { answerOf, blobSha256, sha256Of, type Detection, type MigrationContext, type MigrationNote, type MigrationQuestion, type ModuleStorage, type ShapeMigration, storageMigrationFailed, type ShapeMigrationError } from "@michaelthielemann/kestrel-contracts/helpers/shape-migrations";
import { err, isErr, ok, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import { COLLECTION, ITEMS_SCHEMA, LEGACY_KEYS, LEGACY_KEYS_SCHEMA, canonicalIdOf, keyFor, nameFor, suffixedName, urlNameOf } from "./impl.ts";

/** The module name the storage version row is kept under. */
export const MODULE = "media/default";

/** The storage shape version this release writes. */
export const STORAGE_VERSION = "6.0.0";

/** Converts 5.x items to the `<prefix><id>/<name>` key layout and fills in `location`. */
export const ID_KEY_LAYOUT = "media-default:id-key-layout";

/** Asked for an item whose original is missing: `keep` leaves the row (and `media.reconcile` lists it), `trash` moves it to the trash, where it holds no name in its folder. */
export const MISSING_ORIGINAL: MigrationQuestion = {
  id: `${ID_KEY_LAYOUT}:missing-original`,
  text: "An item's original is missing from the blob store. Keep the item, or move it to the trash?",
  choices: ["keep", "trash"],
  default: "keep",
};

/** The part of the module config the storage migrations read. */
export interface StorageConfig {
  prefix?: string;
}

/** Cleans the bytes of a stored SVG the way `sanitize.svg` cleans an upload; `Err` holds the reason it refuses the file. */
export type SvgSanitizer = (file: { filename: string; contentType: string; data: Uint8Array }) => Promise<Result<Uint8Array, string>>;

/** What the storage migrations use besides the module config. */
export interface StorageDeps {
  /** Without it, every 5.x SVG becomes a `.bin` download, since 5.x kept no record of whether it passed `sanitize.svg`. */
  sanitizeSvg?: SvgSanitizer;
}

interface Row extends Document {
  key: string;
  filename: string | null;
  folder: string | null;
  location: string | null;
  contentType: string;
  size: number;
  checksum: string | null;
  status: string | null;
  svgSanitized: boolean | null;
  trashVersion: number | null;
}

interface Assignment {
  row: Row;
  name: string;
  key: string;
  location: string | null;
}

const PAGE = 500;
const SAMPLE = 5;

function isTrashed(row: Row): boolean {
  return row.status === "trashed";
}

function holdsNoName(row: Row): boolean {
  return row.status === "trashed" || row.status === "removing";
}

function isReadyLike(row: Row): boolean {
  return row.status === "ready" || row.status === null;
}

function nameOf(row: Row): string {
  return nameFor(row.filename ?? urlNameOf(row.key), row.contentType, row.svgSanitized === true);
}

function isDemotedSvg(row: Row): boolean {
  return nameFor(row.filename ?? urlNameOf(row.key), row.contentType, true) !== nameOf(row);
}

type SvgOutcome = { sanitized: Uint8Array } | { refused: string };

const SVG = "image/svg+xml";

function demotedNote(row: Row, name: string, why: string): MigrationNote {
  return { item: row.id, reason: `${row.key} is an SVG ${why}: it is kept as ${name} and served as application/octet-stream; upload it again through sanitize.svg to serve it as an image` };
}

function demotionReason(outcomes: ReadonlyMap<string, SvgOutcome> | null, row: Row): string {
  if (outcomes === null) return "without a sanitize.svg record";
  const outcome = outcomes.get(row.id);
  if (outcome !== undefined && "refused" in outcome) return `that sanitize.svg refuses (${outcome.refused})`;
  return "whose original is missing, so sanitize.svg cannot clean it";
}

async function allRows<T extends Document>(db: Persistence, collection: string): Promise<Result<T[], ShapeMigrationError>> {
  const rows: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: Result<{ items: T[] }, ShapeMigrationError> = await db.findMany<T>(collection, cursor === null ? {} : { id: { gt: cursor } }, { sort: { id: "asc" }, limit: PAGE });
    if (isErr(page)) return page;
    rows.push(...page.value.items);
    if (page.value.items.length < PAGE) return ok(rows);
    cursor = page.value.items[page.value.items.length - 1]!.id;
  }
}

function assign(rows: readonly Row[], prefix: string): { pending: Assignment[]; conflicts: MigrationNote[] } {
  const inLayout = (row: Row): boolean => canonicalIdOf(row.key, prefix) === row.id;
  const needsWork = (row: Row): boolean => !inLayout(row) || (!holdsNoName(row) && row.location === null);
  const taken = new Set<string>();
  for (const row of rows) if (!needsWork(row) && row.location !== null) taken.add(row.location);
  const assigned = new Map<string, Assignment>();
  const conflicts: MigrationNote[] = [];
  const ordered = [...rows.filter((r) => needsWork(r) && isReadyLike(r)), ...rows.filter((r) => needsWork(r) && !isReadyLike(r))];
  const place = (row: Row, name: string): void => {
    const location = isTrashed(row) ? null : keyFor(row.folder ?? "", name);
    if (location !== null) taken.add(location);
    assigned.set(row.id, { row, name, key: `${prefix}${row.id}/${name}`, location });
  };
  for (const row of ordered.filter(inLayout)) {
    const name = urlNameOf(row.key);
    const location = keyFor(row.folder ?? "", name);
    if (taken.has(location)) {
      conflicts.push({ item: row.id, reason: `its location ${location} is held by another item and its key cannot change` });
      continue;
    }
    taken.add(location);
    assigned.set(row.id, { row, name, key: row.key, location });
  }
  const moving = ordered.filter((r) => !inLayout(r));
  for (const row of moving) {
    if (isTrashed(row) || !taken.has(keyFor(row.folder ?? "", nameOf(row)))) place(row, nameOf(row));
  }
  for (const row of moving) {
    if (assigned.has(row.id)) continue;
    const base = nameOf(row);
    let name = suffixedName(base, 2);
    for (let attempt = 3; taken.has(keyFor(row.folder ?? "", name)); attempt += 1) name = suffixedName(base, attempt);
    place(row, name);
  }
  const pending = ordered.flatMap((row) => assigned.get(row.id) ?? []);
  return { pending, conflicts };
}

async function anyOf(exists: (key: string) => Promise<Result<boolean, ShapeMigrationError>>, keys: readonly string[]): Promise<Result<boolean, ShapeMigrationError>> {
  for (const key of new Set(keys)) {
    const found = await exists(key);
    if (isErr(found) || found.value) return found;
  }
  return ok(false);
}

/** The storage of media/default: one migration, `media-default:id-key-layout`. */
export function storage(config: StorageConfig = {}, deps: StorageDeps = {}): ModuleStorage {
  const prefix = config.prefix ?? "media/";
  const { sanitizeSvg } = deps;

  const loaded = async (ctx: MigrationContext): Promise<Result<{ rows: Row[]; work: ReturnType<typeof assign> }, ShapeMigrationError>> => {
    const prepared = await ctx.db.ensureCollection(COLLECTION, ITEMS_SCHEMA);
    if (isErr(prepared)) return prepared;
    const rows = await allRows<Row>(ctx.db, COLLECTION);
    if (isErr(rows)) return rows;
    return ok({ rows: rows.value, work: assign(rows.value, prefix) });
  };

  const stored = async (ctx: MigrationContext): Promise<Result<(key: string) => Promise<Result<boolean, ShapeMigrationError>>, ShapeMigrationError>> => {
    const listed = await ctx.blobs.list(prefix);
    if (isErr(listed)) return listed;
    const keys = new Set(listed.value.map((b) => b.key));
    return ok(async (key) => {
      if (key.startsWith(prefix)) return ok(keys.has(key));
      const head = await ctx.blobOps.head(key);
      return isErr(head) ? head : ok(head.value !== null);
    });
  };

  const lostOriginals = async (rows: readonly Row[], exists: (key: string) => Promise<Result<boolean, ShapeMigrationError>>, cleaned: ReadonlySet<string>): Promise<Result<Set<string>, ShapeMigrationError>> => {
    const lost = new Set<string>();
    for (const { row, key } of assign(rows, prefix).pending) {
      if (isTrashed(row) || key === row.key || cleaned.has(row.id)) continue;
      const found = await anyOf(exists, [row.key, key, `${prefix}${row.id}/${nameOf(row)}`]);
      if (isErr(found)) return found;
      if (!found.value) lost.add(row.id);
    }
    return ok(lost);
  };

  const cleanedEarlier = async (ctx: MigrationContext, clean: SvgSanitizer, row: Row, owned: ReadonlySet<string>): Promise<Result<Uint8Array | null, ShapeMigrationError>> => {
    const folder = `${prefix}${row.id}/`;
    const listed = await ctx.blobs.list(folder);
    if (isErr(listed)) return listed;
    const found: Uint8Array[] = [];
    for (const { key } of listed.value) {
      if (key.slice(folder.length).includes("/") || !key.endsWith(".svg") || owned.has(key)) continue;
      const read = await ctx.blobs.get(key);
      if (isErr(read)) return read;
      if (read.value === null) continue;
      const again = await clean({ filename: row.filename ?? urlNameOf(row.key), contentType: row.contentType, data: read.value });
      if (!isErr(again) && Buffer.from(again.value).equals(read.value)) found.push(read.value);
    }
    return ok(found.length === 1 ? found[0]! : null);
  };

  const svgOutcomes = async (ctx: MigrationContext, rows: readonly Row[]): Promise<Result<Map<string, SvgOutcome> | null, ShapeMigrationError>> => {
    if (sanitizeSvg === undefined) return ok(null);
    const outcomes = new Map<string, SvgOutcome>();
    const owned = new Set(rows.map((r) => r.key));
    for (const row of rows) {
      if (canonicalIdOf(row.key, prefix) === row.id || !isDemotedSvg(row)) continue;
      const read = await ctx.blobs.get(row.key);
      if (isErr(read)) return read;
      if (read.value === null) {
        const earlier = await cleanedEarlier(ctx, sanitizeSvg, row, owned);
        if (isErr(earlier)) return earlier;
        if (earlier.value !== null) outcomes.set(row.id, { sanitized: earlier.value });
        continue;
      }
      const cleaned = await sanitizeSvg({ filename: row.filename ?? urlNameOf(row.key), contentType: row.contentType, data: read.value });
      outcomes.set(row.id, isErr(cleaned) ? { refused: cleaned.error } : { sanitized: cleaned.value });
    }
    return ok(outcomes);
  };

  const decided = async (ctx: MigrationContext, rows: Row[], exists: (key: string) => Promise<Result<boolean, ShapeMigrationError>>): Promise<Result<{ lost: Set<string>; work: ReturnType<typeof assign>; svgs: Map<string, SvgOutcome> | null }, ShapeMigrationError>> => {
    const answer = answerOf(ctx, MISSING_ORIGINAL);
    if (isErr(answer)) return answer;
    const svgs = await svgOutcomes(ctx, rows);
    if (isErr(svgs)) return svgs;
    const marked = rows.map((row): Row => {
      const outcome = svgs.value?.get(row.id);
      return outcome !== undefined && "sanitized" in outcome ? { ...row, svgSanitized: true, contentType: SVG } : row;
    });
    const cleaned = new Set([...(svgs.value ?? new Map<string, SvgOutcome>())].filter(([, outcome]) => "sanitized" in outcome).map(([id]) => id));
    const lost = answer.value === "trash" ? await lostOriginals(marked, exists, cleaned) : ok(new Set<string>());
    if (isErr(lost)) return lost;
    const effective = marked.map((row): Row => (lost.value.has(row.id) ? { ...row, status: "trashed", location: null } : row));
    return ok({ lost: lost.value, work: assign(effective, prefix), svgs: svgs.value });
  };

  const detected = (work: ReturnType<typeof assign>): Detection => ({
    pending: work.pending.length + work.conflicts.length,
    sample: [...work.pending.map((a) => a.row.id), ...work.conflicts.map((c) => c.item)].slice(0, SAMPLE),
  });

  const recordLegacyKeys = async (ctx: MigrationContext, rows: readonly Row[]): Promise<Result<number, ShapeMigrationError>> => {
    const ids = new Set(rows.map((r) => r.id));
    const owner = new Map(rows.filter((r) => canonicalIdOf(r.key, prefix) !== r.id).map((r) => [r.key, r.id]));
    const prepared = await ctx.db.ensureCollection(LEGACY_KEYS, LEGACY_KEYS_SCHEMA);
    if (isErr(prepared)) return prepared;
    const known = await allRows<Document>(ctx.db, LEGACY_KEYS);
    if (isErr(known)) return known;
    const recorded = new Set(known.value.map((r) => r.key));
    const listed = await ctx.blobs.list(prefix);
    if (isErr(listed)) return listed;
    const unowned = listed.value.map((b) => b.key).filter((key) => !owner.has(key) && !key.slice(prefix.length).split("/").slice(0, -1).some((segment) => ids.has(segment)));
    let added = 0;
    for (const key of [...owner.keys(), ...unowned]) {
      if (recorded.has(key)) continue;
      const created = await ctx.db.createOne(LEGACY_KEYS, { key, mediaId: owner.get(key) ?? null, recordedAt: ctx.now() });
      if (isErr(created) && created.error.code !== "CONFLICT") return created;
      added += 1;
    }
    return ok(added);
  };

  const idKeyLayout: ShapeMigration = {
    id: ID_KEY_LAYOUT,
    introducedIn: "6.0.0",
    kind: "auto",
    blobWrites: true,
    summary: `copies each original stored as <prefix><folder>/<filename> to <prefix><id>/<name>, checks its size and sha256 against the item (a difference is reported, and the item records those of the copy), switches the item to the new key and fills in its location; the old blob stays until a cleanup`,
    questions: [MISSING_ORIGINAL],

    async detect(ctx) {
      const state = await loaded(ctx);
      return isErr(state) ? state : ok(detected(state.value.work));
    },

    async plan(ctx) {
      const state = await loaded(ctx);
      if (isErr(state)) return state;
      const exists = await stored(ctx);
      if (isErr(exists)) return exists;
      const decision = await decided(ctx, state.value.rows, exists.value);
      if (isErr(decision)) return decision;
      const { work, svgs } = decision.value;
      const notes: MigrationNote[] = [...work.conflicts];
      let copies = 0;
      let renamed = 0;
      let missing = 0;
      let svgDemoted = 0;
      let svgSanitized = 0;
      for (const { row, name, key } of work.pending) {
        if (key === row.key) continue;
        const source = await exists.value(row.key);
        if (isErr(source)) return source;
        const target = source.value ? ok(true) : await exists.value(key);
        if (isErr(target)) return target;
        const svg = svgs?.get(row.id);
        if (source.value || (!target.value && svg !== undefined && "sanitized" in svg)) copies += 1;
        else if (!target.value) {
          missing += 1;
          notes.push({ item: row.id, reason: `original ${row.key} is missing` });
        }
        if (name !== nameOf(row)) renamed += 1;
        if (isDemotedSvg(row)) {
          svgDemoted += 1;
          notes.push(demotedNote(row, name, demotionReason(svgs, row)));
        } else if (svgs?.has(row.id) === true) svgSanitized += 1;
      }
      return ok({ counts: { items: work.pending.length, copies, renamed, missingOriginals: missing, trashed: decision.value.lost.size, svgSanitized, svgDemoted, conflicts: work.conflicts.length }, notes });
    },

    async apply(ctx) {
      const state = await loaded(ctx);
      if (isErr(state)) return state;
      const exists = await stored(ctx);
      if (isErr(exists)) return exists;
      const decision = await decided(ctx, state.value.rows, exists.value);
      if (isErr(decision)) return decision;
      const { lost, work, svgs } = decision.value;
      if (work.conflicts.length > 0) {
        return err(storageMigrationFailed(`${ID_KEY_LAYOUT}: ${work.conflicts.length} item(s) in the new key layout share a location: ${work.conflicts.map((c) => c.item).slice(0, SAMPLE).join(", ")}`, { conflicts: work.conflicts }));
      }
      const recorded = await recordLegacyKeys(ctx, state.value.rows);
      if (isErr(recorded)) return recorded;
      const notes: MigrationNote[] = [];
      let copied = 0;
      let trashed = 0;
      let svgDemoted = 0;
      let svgSanitized = 0;
      for (const { row, name, key, location } of work.pending) {
        const patch: Record<string, unknown> = { key, filename: name, location };
        const svg = svgs?.get(row.id);
        const cleaned = svg !== undefined && "sanitized" in svg ? svg.sanitized : null;
        if (key !== row.key && isDemotedSvg(row)) {
          svgDemoted += 1;
          notes.push(demotedNote(row, name, demotionReason(svgs, row)));
        }
        if (cleaned !== null) {
          Object.assign(patch, { contentType: SVG, svgSanitized: true, updatedAt: ctx.now() });
          svgSanitized += 1;
        }
        if (lost.has(row.id)) {
          notes.push({ item: row.id, reason: `original ${row.key} is missing` });
          Object.assign(patch, { status: "trashed", trashedAt: ctx.now(), trashVersion: (row.trashVersion ?? 0) + 1 });
          trashed += 1;
        } else if (key !== row.key) {
          const source = await ctx.blobOps.head(row.key);
          if (isErr(source)) return source;
          const target = await ctx.blobOps.head(key);
          if (isErr(target)) return target;
          if (source.value === null && target.value === null && cleaned === null) {
            notes.push({ item: row.id, reason: `original ${row.key} is missing` });
          } else if (source.value === null && target.value !== null && cleaned === null) {
            const targetSha = await blobSha256(ctx, key, target.value);
            if (isErr(targetSha)) return targetSha;
            if (target.value.size !== row.size || (row.checksum !== null && targetSha.value !== row.checksum)) {
              notes.push({ item: row.id, reason: `the bytes at ${key} differ from the item's recorded size or checksum, and its original ${row.key} is gone; the item records those of ${key}` });
            }
            Object.assign(patch, { size: target.value.size, checksum: targetSha.value });
          } else {
            let sourceSha: string | null = null;
            if (source.value !== null) {
              const read = await blobSha256(ctx, row.key, source.value);
              if (isErr(read)) return read;
              sourceSha = read.value;
              if (source.value.size !== row.size || (row.checksum !== null && sourceSha !== row.checksum)) {
                notes.push({ item: row.id, reason: `the bytes at ${row.key} differ from the item's recorded size or checksum; the item records those of the copy` });
              }
            }
            const bytes = cleaned;
            const want = bytes === null ? { size: source.value!.size, sha: sourceSha! } : { size: bytes.byteLength, sha: sha256Of(bytes) };
            Object.assign(patch, { size: want.size, checksum: want.sha });
            const targetSha = target.value === null ? ok(null) : await blobSha256(ctx, key, target.value);
            if (isErr(targetSha)) return targetSha;
            if (target.value === null || target.value.size !== want.size || targetSha.value !== want.sha) {
              const done = bytes === null ? await ctx.blobOps.copy(row.key, key, { contentType: row.contentType }) : await ctx.blobs.put(key, bytes, { contentType: SVG });
              if (isErr(done)) return done;
              const written = await ctx.blobOps.head(key);
              if (isErr(written)) return written;
              const writtenSha = await blobSha256(ctx, key, written.value);
              if (isErr(writtenSha)) return writtenSha;
              if (written.value === null || written.value.size !== want.size || writtenSha.value !== want.sha) {
                const what = bytes === null ? "the copy" : "the sanitized copy";
                return err(storageMigrationFailed(`${ID_KEY_LAYOUT}: ${what} of ${row.key} at ${key} does not match the ${bytes === null ? "original" : "sanitized bytes"}`, { item: row.id, from: row.key, to: key }));
              }
              copied += 1;
            }
          }
        }
        const switched = await ctx.db.updateOne(COLLECTION, row.id, patch);
        if (isErr(switched)) return switched;
      }
      return ok({ counts: { items: work.pending.length, copied, missingOriginals: notes.filter((n) => n.reason.endsWith("is missing")).length, trashed, svgSanitized, svgDemoted, legacyKeys: recorded.value }, notes });
    },
  };

  return { module: MODULE, version: STORAGE_VERSION, convertsFrom: "5.0.0", migrations: [idKeyLayout] };
}

/** Every migration of media/default, built for the default prefix; `storage(config).migrations` builds them for another one. */
export const migrations: readonly ShapeMigration[] = storage().migrations;
