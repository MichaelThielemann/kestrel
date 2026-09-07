import type { Content, ContentDocument, FieldDefinition, FieldType } from "@michaelthielemann/kestrel-contracts/content";
import { isErr, ok, type KestrelError, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import { collectInternalRefs } from "@michaelthielemann/kestrel-contracts/links";
import type { Document, Persistence } from "@michaelthielemann/kestrel-contracts/persistence";

export const INDEX = "references_index";

/** Where a reference was found: a `ref` field of the content model, or an internal link inside a `json` field. */
export type Via = "field" | "body";

export type Target = { content: string } | { collection: string };

export interface Config {
  targets: Record<string, Target>;
}

export interface Missing {
  field: string;
  to: string;
  id: string;
}

export interface Referrer {
  type: string;
  field: string;
  id: string;
  via: Via;
}

export interface IndexEntry extends Document {
  fromType: string;
  fromId: string;
  field: string;
  locale: string;
  toTarget: string;
  toId: string;
  via: Via;
  broken: boolean;
  checkedAt: number | null;
}

export type ReferencesError = KestrelError<"VALIDATION" | "NOT_FOUND" | "CONFLICT" | "TRANSIENT">;

export interface References {
  missing(type: string, data: Record<string, unknown>): Promise<Result<Missing[], ReferencesError>>;
  index(type: string, id: string): Promise<Result<number, ReferencesError>>;
  unindex(type: string, id: string): Promise<Result<number, ReferencesError>>;
  referrers(target: string, id: string): Promise<Result<Referrer[], ReferencesError>>;
  scan(): Promise<Result<{ checked: number; broken: number }, ReferencesError>>;
  report(target?: string): Promise<Result<IndexEntry[], ReferencesError>>;
  rebuild(): Promise<Result<{ documents: number; entries: number }, ReferencesError>>;
}

const PAGE = 100;

function definition(field: FieldType | FieldDefinition): FieldDefinition {
  return typeof field === "string" ? { type: field } : field;
}

export function createReferencesDefault(config: Config, content: Content, db: Persistence, now: () => number = Date.now): References {
  const model = content.model();
  const locales = model.locales ?? [];
  const fieldsOfType = (type: string, kind: FieldType): Array<[string, FieldDefinition]> =>
    Object.entries(model.types[type]?.fields ?? {})
      .map(([f, raw]) => [f, definition(raw)] as [string, FieldDefinition])
      .filter(([, def]) => def.type === kind);
  const refFields = (type: string): Array<[string, FieldDefinition]> => fieldsOfType(type, "ref");
  const jsonFields = (type: string): Array<[string, FieldDefinition]> => fieldsOfType(type, "json");

  for (const type of Object.keys(model.types)) {
    for (const [field, def] of refFields(type)) {
      if (def.to === undefined || !(def.to in config.targets)) throw new Error(`references/default: "${type}.${field}" points to "${def.to ?? ""}" which is not a configured target`);
    }
  }
  const knownType = (type: string): void => {
    if (!(type in model.types)) throw new Error(`references/default: unknown type "${type}"`);
  };
  const knownTarget = (target: string): Target => {
    const t = config.targets[target];
    if (!t) throw new Error(`references/default: unknown target "${target}"`);
    return t;
  };

  const exists = async (target: Target, id: string): Promise<Result<boolean, ReferencesError>> => {
    if ("content" in target) {
      const doc = await content.get(target.content, id);
      if (isErr(doc)) return doc;
      return ok(doc.value !== null);
    }
    const row = await db.findOne(target.collection, { id });
    if (isErr(row)) return row;
    return ok(row.value !== null);
  };

  const entriesOf = async (type: string, id: string): Promise<Result<Array<Omit<IndexEntry, "id">>, ReferencesError>> => {
    const refs = refFields(type);
    const jsons = jsonFields(type);
    if (refs.length === 0 && jsons.length === 0) return ok([]);
    const out: Array<Omit<IndexEntry, "id">> = [];
    const docs = new Map<string, ContentDocument | null>();
    const docFor = async (locale: string | undefined): Promise<Result<ContentDocument | null, ReferencesError>> => {
      const key = locale ?? "";
      if (docs.has(key)) return ok(docs.get(key) ?? null);
      const doc = await content.get(type, id, locale === undefined ? {} : { locale });
      if (isErr(doc)) return doc;
      docs.set(key, doc.value);
      return ok(doc.value);
    };
    const localesOf = (def: FieldDefinition): Array<string | undefined> => (def.localized ? locales : [undefined]);
    for (const [field, def] of refs) {
      for (const locale of localesOf(def)) {
        const doc = await docFor(locale);
        if (isErr(doc)) return doc;
        const value = doc.value?.[field];
        if (typeof value !== "string" || value === "") continue;
        out.push({ fromType: type, fromId: id, field, locale: locale ?? "", toTarget: def.to ?? "", toId: value, via: "field", broken: false, checkedAt: null });
      }
    }
    for (const [field, def] of jsons) {
      for (const locale of localesOf(def)) {
        const doc = await docFor(locale);
        if (isErr(doc)) return doc;
        const value = doc.value?.[field];
        for (const ref of collectInternalRefs(value)) {
          if (!(ref.type in config.targets)) continue;
          out.push({ fromType: type, fromId: id, field, locale: locale ?? "", toTarget: ref.type, toId: ref.id, via: "body", broken: false, checkedAt: null });
        }
      }
    }
    return ok(out);
  };

  const ready = (async () => {
    const prepared = await db.ensureCollection(INDEX, { fromType: "string", fromId: "string", field: "string", locale: "string", toTarget: "string", toId: "string", via: "string", broken: "boolean", checkedAt: "number" });
    if (isErr(prepared)) throw new Error(`references/default: cannot prepare collection "${INDEX}": ${prepared.error.message}`);
  })();

  // Rows written before `via` existed have no value for it; persistence adds the column but leaves them null.
  const withVia = (row: IndexEntry): IndexEntry => (row.via === "body" ? row : { ...row, via: "field" });

  const index: References["index"] = async (type, id) => {
    knownType(type);
    await ready;
    const deleted = await db.deleteMany(INDEX, { fromType: type, fromId: id });
    if (isErr(deleted)) return deleted;
    const entries = await entriesOf(type, id);
    if (isErr(entries)) return entries;
    if (entries.value.length > 0) {
      const created = await db.createMany<IndexEntry>(INDEX, entries.value);
      if (isErr(created)) return created;
    }
    return ok(entries.value.length);
  };

  return {
    async missing(type, data) {
      knownType(type);
      const out: Missing[] = [];
      for (const [field, def] of refFields(type)) {
        const id = data[field];
        if (typeof id !== "string" || id === "") continue;
        const to = def.to as string;
        const found = await exists(knownTarget(to), id);
        if (isErr(found)) return found;
        if (!found.value) out.push({ field, to, id });
      }
      return ok(out);
    },
    index,
    async unindex(type, id) {
      knownType(type);
      await ready;
      return db.deleteMany(INDEX, { fromType: type, fromId: id });
    },
    async referrers(target, id) {
      knownTarget(target);
      await ready;
      const page = await db.findMany<IndexEntry>(INDEX, { toTarget: target, toId: id }, { sort: { fromType: "asc", fromId: "asc" } });
      if (isErr(page)) return page;
      const rows = page.value.items.map(withVia);
      const out: Referrer[] = [];
      for (const row of rows) {
        if (row.fromType === target && row.fromId === id) continue;
        if (!out.some((r) => r.type === row.fromType && r.id === row.fromId && r.via === row.via)) out.push({ type: row.fromType, field: row.field, id: row.fromId, via: row.via });
      }
      return ok(out);
    },
    async scan() {
      await ready;
      const cache = new Map<string, boolean>();
      let checked = 0;
      let broken = 0;
      for (let offset = 0; ; offset += PAGE) {
        const page = await db.findMany<IndexEntry>(INDEX, {}, { sort: { id: "asc" }, limit: PAGE, offset });
        if (isErr(page)) return page;
        for (const row of page.value.items) {
          const key = `${row.toTarget}/${row.toId}`;
          let known = cache.get(key);
          if (known === undefined) {
            const found = await exists(knownTarget(row.toTarget), row.toId);
            if (isErr(found)) return found;
            known = found.value;
            cache.set(key, known);
          }
          checked += 1;
          if (!known) broken += 1;
          if (row.broken !== !known || row.checkedAt === null) {
            const updated = await db.updateOne<IndexEntry>(INDEX, row.id, { broken: !known, checkedAt: now() });
            if (isErr(updated)) return updated;
          }
        }
        if (page.value.items.length < PAGE) break;
      }
      return ok({ checked, broken });
    },
    async report(target) {
      await ready;
      if (target !== undefined) knownTarget(target);
      const page = await db.findMany<IndexEntry>(INDEX, target === undefined ? { broken: true } : { broken: true, toTarget: target }, { sort: { fromType: "asc", fromId: "asc" } });
      if (isErr(page)) return page;
      return ok(page.value.items.map(withVia));
    },
    async rebuild() {
      await ready;
      const deleted = await db.deleteMany(INDEX, {});
      if (isErr(deleted)) return deleted;
      let documents = 0;
      let entries = 0;
      for (const type of Object.keys(model.types)) {
        if (refFields(type).length === 0 && jsonFields(type).length === 0) continue;
        for (let offset = 0; ; offset += PAGE) {
          const page = await content.list(type, {}, { limit: PAGE, offset });
          if (isErr(page)) return page;
          for (const doc of page.value.items) {
            documents += 1;
            const count = await index(type, doc.id);
            if (isErr(count)) return count;
            entries += count.value;
          }
          if (page.value.items.length < PAGE) break;
        }
      }
      return ok({ documents, entries });
    },
  };
}

export async function referrersLive(content: Content, target: string, id: string): Promise<Result<Referrer[], ReferencesError>> {
  const model = content.model();
  const out: Referrer[] = [];
  for (const type of Object.keys(model.types)) {
    for (const [field, raw] of Object.entries(model.types[type]?.fields ?? {})) {
      const def = definition(raw);
      if (def.type !== "ref" || def.to !== target) continue;
      const fieldLocales = def.localized ? (model.locales ?? []) : [undefined];
      for (const locale of fieldLocales) {
        const page = await content.list(type, { [field]: id }, { limit: PAGE, ...(locale === undefined ? {} : { locale }) });
        if (isErr(page)) return page;
        for (const doc of page.value.items) if (!out.some((r) => r.type === type && r.id === doc.id)) out.push({ type, field, id: doc.id, via: "field" });
      }
    }
  }
  return ok(out);
}
