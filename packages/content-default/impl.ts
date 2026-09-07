import type { Content, ContentDocument, ContentError, ContentModel, FieldDefinition, FieldError, FieldType, LocaleOptions, TypeDefinition, Validation } from "@michaelthielemann/kestrel-contracts/content";
import { err, failure, isErr, ok, type KestrelError, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import type { Err } from "@michaelthielemann/kestrel/result";
import type { Document, FieldType as StorageType, Filter, FindOptions, Persistence, PersistenceError, Schema } from "@michaelthielemann/kestrel-contracts/persistence";

const RESERVED = new Set(["id", "createdAt", "updatedAt"]);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STORAGE: Record<FieldType, StorageType> = { text: "string", richtext: "string", slug: "string", enum: "string", ref: "string", number: "number", date: "number", boolean: "boolean", json: "json" };

function definition(field: FieldType | FieldDefinition): FieldDefinition {
  return typeof field === "string" ? { type: field } : field;
}

function check(def: FieldDefinition, value: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
  switch (def.type) {
    case "text":
    case "richtext":
      return typeof value === "string" ? { ok: true, value } : { ok: false, message: "expected a string" };
    case "slug":
      if (typeof value !== "string") return { ok: false, message: "expected a string" };
      return SLUG.test(value) ? { ok: true, value } : { ok: false, message: 'expected a slug like "my-page"' };
    case "ref":
      return typeof value === "string" && value !== "" ? { ok: true, value } : { ok: false, message: "expected a reference id" };
    case "enum":
      return typeof value === "string" && (def.options ?? []).includes(value) ? { ok: true, value } : { ok: false, message: `expected one of ${(def.options ?? []).join(", ")}` };
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? { ok: true, value } : { ok: false, message: "expected a number" };
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false, message: "expected a boolean" };
    case "date": {
      const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
      return Number.isFinite(ms) ? { ok: true, value: ms } : { ok: false, message: "expected an ISO date or milliseconds" };
    }
    case "json":
      return value !== undefined ? { ok: true, value } : { ok: false, message: "expected a value" };
  }
}

export function validateModel(model: ContentModel): void {
  const locales = model.locales ?? [];
  for (const [name, type] of Object.entries(model.types)) {
    if (!type.completeWhen) continue;
    const raw = type.fields[type.completeWhen.field];
    if (!raw) throw new Error(`content/default: completeWhen of "${name}" names unknown field "${type.completeWhen.field}"`);
    if (!definition(raw).localized) throw new Error(`content/default: completeWhen of "${name}" needs a localized field`);
  }
  if (model.locales !== undefined) {
    if (locales.length === 0) throw new Error("content/default: locales must not be empty");
    if (model.defaultLocale === undefined || !locales.includes(model.defaultLocale)) throw new Error("content/default: defaultLocale must be one of locales");
  }
  for (const [name, type] of Object.entries(model.types)) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`content/default: invalid type name "${name}"`);
    for (const [field, raw] of Object.entries(type.fields)) {
      const def = definition(raw);
      if (RESERVED.has(field) || field.includes("__")) throw new Error(`content/default: field name "${field}" of "${name}" is reserved`);
      if (!(def.type in STORAGE)) throw new Error(`content/default: unknown field type "${String(def.type)}" in "${name}.${field}"`);
      if (def.type === "enum" && (def.options === undefined || def.options.length === 0)) throw new Error(`content/default: enum "${name}.${field}" needs options`);
      if (def.type === "ref" && (def.to === undefined || def.to === "")) throw new Error(`content/default: ref "${name}.${field}" needs a target (to)`);
      if (def.localized && locales.length === 0) throw new Error(`content/default: "${name}.${field}" is localized but the model declares no locales`);
    }
  }
}

function fieldFailure(type: string, errors: FieldError[]): Err<KestrelError<"VALIDATION">> {
  return err(failure("VALIDATION", `${type}: ${errors.map((e) => `${e.field} ${e.message}`).join("; ")}`, { details: { fields: errors } }));
}

export async function createContentDefault(model: ContentModel, db: Persistence, now: () => number = Date.now): Promise<Content> {
  validateModel(model);
  const locales = model.locales ?? [];
  const defaultLocale = model.defaultLocale;

  const typeOf = (name: string): TypeDefinition => {
    const type = model.types[name];
    if (!type) throw new Error(`content/default: unknown type "${name}"`);
    return type;
  };
  const localeOf = (options?: LocaleOptions): Result<string | undefined, KestrelError<"VALIDATION">> => {
    if (options?.locale === undefined) return ok(defaultLocale);
    if (!locales.includes(options.locale)) return err(failure("VALIDATION", `content/default: unknown locale "${options.locale}"`));
    return ok(options.locale);
  };
  const column = (field: string, def: FieldDefinition, locale: string | undefined): string => (def.localized ? `${field}__${locale ?? ""}` : field);

  for (const [name, type] of Object.entries(model.types)) {
    const schema: Schema = { createdAt: "number", updatedAt: "number" };
    for (const [field, raw] of Object.entries(type.fields)) {
      const def = definition(raw);
      const stored = def.unique ? { type: STORAGE[def.type], unique: true } : STORAGE[def.type];
      if (def.localized) for (const locale of locales) schema[column(field, def, locale)] = stored;
      else schema[field] = stored;
    }
    const prepared = await db.ensureCollection(name, schema);
    if (isErr(prepared)) throw new Error(`content/default: cannot prepare collection "${name}": ${prepared.error.message}`);
  }

  const validate = (typeName: string, data: Record<string, unknown>, mode: "create" | "update", options?: LocaleOptions): Validation => {
    const type = typeOf(typeName);
    const errors: FieldError[] = [];
    if (options?.locale !== undefined && !locales.includes(options.locale)) errors.push({ field: "locale", message: `unknown locale "${options.locale}"` });
    const out: Record<string, unknown> = {};
    for (const field of Object.keys(data)) {
      if (RESERVED.has(field)) errors.push({ field, message: "is set by the system" });
      else if (!(field in type.fields)) errors.push({ field, message: "unknown field" });
    }
    for (const [field, raw] of Object.entries(type.fields)) {
      const def = definition(raw);
      const value = data[field];
      if (value === undefined || value === null) {
        if (mode === "create" && def.required) errors.push({ field, message: "required" });
        else if (value === null) out[field] = null;
        continue;
      }
      const result = check(def, value);
      if (result.ok) out[field] = result.value;
      else errors.push({ field, message: result.message });
    }
    return errors.length > 0 ? { ok: false, errors } : { ok: true, data: out };
  };

  const toRow = (typeName: string, fields: Record<string, unknown>, locale: string | undefined): Record<string, unknown> => {
    const type = typeOf(typeName);
    const row: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(fields)) row[column(field, definition(type.fields[field] as FieldType | FieldDefinition), locale)] = value;
    return row;
  };

  const fromRow = (typeName: string, row: Document, locale: string | undefined, fallback = false): ContentDocument => {
    const type = typeOf(typeName);
    const doc: Record<string, unknown> = { id: row.id, createdAt: row.createdAt, updatedAt: row.updatedAt };
    const origins: Record<string, string> = {};
    for (const [field, raw] of Object.entries(type.fields)) {
      const def = definition(raw);
      if (!def.localized) {
        doc[field] = row[field] ?? null;
        continue;
      }
      const own = row[column(field, def, locale)];
      if (own !== undefined && own !== null) {
        doc[field] = own;
        if (fallback && locale !== undefined) origins[field] = locale;
        continue;
      }
      const inherited = fallback ? row[column(field, def, defaultLocale)] : undefined;
      doc[field] = inherited ?? null;
      if (fallback && inherited !== undefined && inherited !== null && defaultLocale !== undefined) origins[field] = defaultLocale;
    }
    if (fallback) doc._locales = origins;
    if (locales.length > 0) {
      const localized = Object.entries(type.fields).map(([f, raw]) => [f, definition(raw)] as [string, FieldDefinition]).filter(([, def]) => def.localized);
      const decisive = localized.some(([, def]) => def.required) ? localized.filter(([, def]) => def.required) : localized;
      const translations: Record<string, boolean> = {};
      for (const l of locales) translations[l] = decisive.length > 0 && decisive.every(([f, def]) => row[column(f, def, l)] !== null && row[column(f, def, l)] !== undefined);
      doc._translations = translations;
    }
    return doc as ContentDocument;
  };

  const toFilter = (typeName: string, filter: Filter, locale: string | undefined): Filter => {
    const type = typeOf(typeName);
    const out: Filter = {};
    for (const [field, value] of Object.entries(filter)) {
      if (RESERVED.has(field)) {
        out[field] = value;
        continue;
      }
      const raw = type.fields[field];
      if (!raw) throw new Error(`content/default: unknown field "${field}" in filter for "${typeName}"`);
      out[column(field, definition(raw), locale)] = value;
    }
    return out;
  };

  const assertComplete = (typeName: string, merged: Record<string, unknown>, locale: string | undefined): Result<void, ContentError> => {
    const type = typeOf(typeName);
    const rule = type.completeWhen;
    if (!rule || locale === undefined) return ok();
    const stateField = definition(type.fields[rule.field] as FieldType | FieldDefinition);
    if (merged[column(rule.field, stateField, locale)] !== rule.equals) return ok();
    const missing = Object.entries(type.fields)
      .map(([f, raw]) => [f, definition(raw)] as [string, FieldDefinition])
      .filter(([f, def]) => def.localized && def.required && f !== rule.field && (merged[column(f, def, locale)] === null || merged[column(f, def, locale)] === undefined))
      .map(([f]) => f);
    if (missing.length > 0) return fieldFailure(typeName, [{ field: rule.field, message: `cannot be "${rule.equals}" for ${locale}: ${missing.join(", ")} missing` }]);
    return ok();
  };

  // The persistence enforces `unique` with an index; a race that slips past assertUnique still answers the same field error.
  const uniqueConflict = (typeName: string, error: PersistenceError, fields: Record<string, unknown>): Err<ContentError> => {
    const column = error.details?.field;
    if (error.code !== "CONFLICT" || typeof column !== "string") return err(error);
    const field = column.split("__")[0] ?? column;
    if (!(field in typeOf(typeName).fields)) return err(error);
    return fieldFailure(typeName, [{ field, message: `must be unique, ${JSON.stringify(fields[field])} exists` }]);
  };

  const assertUnique = async (typeName: string, fields: Record<string, unknown>, locale: string | undefined, exceptId?: string): Promise<Result<void, ContentError>> => {
    const type = typeOf(typeName);
    for (const [field, raw] of Object.entries(type.fields)) {
      const def = definition(raw);
      if (!def.unique || fields[field] === undefined || fields[field] === null) continue;
      const existing = await db.findOne<Document>(typeName, { [column(field, def, locale)]: fields[field] });
      if (isErr(existing)) return existing;
      if (existing.value && existing.value.id !== exceptId) return fieldFailure(typeName, [{ field, message: `must be unique, ${JSON.stringify(fields[field])} exists` }]);
    }
    return ok();
  };

  const single = (typeName: string) => db.findOne<Document>(typeName, {});

  const api: Content = {
    model: () => model,
    validate,

    async get(typeName, id, options) {
      const type = typeOf(typeName);
      const locale = localeOf(options);
      if (isErr(locale)) return locale;
      const fallback = options?.fallback ?? false;
      if (type.kind === "single") {
        const row = await single(typeName);
        if (isErr(row)) return row;
        return ok(row.value ? fromRow(typeName, row.value, locale.value, fallback) : null);
      }
      if (id === undefined) throw new Error(`content/default: get("${typeName}") needs an id for multi types`);
      const row = await db.findOne<Document>(typeName, { id });
      if (isErr(row)) return row;
      return ok(row.value ? fromRow(typeName, row.value, locale.value, fallback) : null);
    },

    async list(typeName, filter = {}, options = {}) {
      const { locale: requested, fallback = false, ...find } = options;
      const locale = localeOf({ ...(requested === undefined ? {} : { locale: requested }) });
      if (isErr(locale)) return locale;
      const query: FindOptions = { ...find };
      if (find.sort) {
        const fields = typeOf(typeName).fields;
        for (const field of Object.keys(find.sort)) {
          if (!RESERVED.has(field) && !fields[field]) return err(failure("VALIDATION", `content/default: unknown sort field "${field}" for "${typeName}"`));
        }
        query.sort = Object.fromEntries(Object.entries(toFilter(typeName, find.sort, locale.value)) as Array<[string, "asc" | "desc"]>);
      }
      const page = await db.findMany<Document>(typeName, toFilter(typeName, filter, locale.value), query);
      if (isErr(page)) return page;
      return ok({ items: page.value.items.map((row) => fromRow(typeName, row, locale.value, fallback)), total: page.value.total });
    },

    async create(typeName, data, options) {
      if (typeOf(typeName).kind !== "multi") throw new Error(`content/default: create() is only for multi types, "${typeName}" is single (use set)`);
      const locale = localeOf(options);
      if (isErr(locale)) return locale;
      const validation = validate(typeName, data, "create", options);
      if (!validation.ok) return fieldFailure(typeName, validation.errors);
      const fields = validation.data;
      const unique = await assertUnique(typeName, fields, locale.value);
      if (isErr(unique)) return unique;
      const complete = assertComplete(typeName, toRow(typeName, fields, locale.value), locale.value);
      if (isErr(complete)) return complete;
      const at = now();
      const row = await db.createOne<Document>(typeName, { ...toRow(typeName, fields, locale.value), createdAt: at, updatedAt: at });
      if (isErr(row)) return uniqueConflict(typeName, row.error, fields);
      return ok(fromRow(typeName, row.value, locale.value));
    },

    async set(typeName, data, options) {
      const type = typeOf(typeName);
      if (type.kind !== "single") throw new Error(`content/default: set() is only for single types, "${typeName}" is multi (use create)`);
      const locale = localeOf(options);
      if (isErr(locale)) return locale;
      const validation = validate(typeName, data, "create", options);
      if (!validation.ok) return fieldFailure(typeName, validation.errors);
      const fields = validation.data;
      const complete = assertComplete(typeName, toRow(typeName, fields, locale.value), locale.value);
      if (isErr(complete)) return complete;
      const at = now();
      const existing = await single(typeName);
      if (isErr(existing)) return existing;
      if (existing.value === null) {
        const created = await db.createOne<Document>(typeName, { ...toRow(typeName, fields, locale.value), createdAt: at, updatedAt: at });
        if (isErr(created)) return created;
        return ok(fromRow(typeName, created.value, locale.value));
      }
      const cleared: Record<string, unknown> = {};
      for (const [field, raw] of Object.entries(type.fields)) cleared[column(field, definition(raw), locale.value)] = null;
      const row = await db.updateOne<Document>(typeName, existing.value.id, { ...cleared, ...toRow(typeName, fields, locale.value), updatedAt: at });
      if (isErr(row)) return row;
      return ok(fromRow(typeName, row.value, locale.value));
    },

    async update(typeName, id, patch, options) {
      typeOf(typeName);
      const locale = localeOf(options);
      if (isErr(locale)) return locale;
      const validation = validate(typeName, patch, "update", options);
      if (!validation.ok) return fieldFailure(typeName, validation.errors);
      const fields = validation.data;
      const unique = await assertUnique(typeName, fields, locale.value, id);
      if (isErr(unique)) return unique;
      const existing = await db.findOne<Document>(typeName, { id });
      if (isErr(existing)) return existing;
      if (existing.value === null) return err(failure("NOT_FOUND", `${typeName}/${id} not found`));
      const complete = assertComplete(typeName, { ...existing.value, ...toRow(typeName, fields, locale.value) }, locale.value);
      if (isErr(complete)) return complete;
      const row = await db.updateOne<Document>(typeName, id, { ...toRow(typeName, fields, locale.value), updatedAt: now() });
      if (isErr(row)) return uniqueConflict(typeName, row.error, fields);
      return ok(fromRow(typeName, row.value, locale.value));
    },

    async remove(typeName, id) {
      typeOf(typeName);
      const removed = await db.deleteOne(typeName, id);
      if (isErr(removed)) return removed;
      return ok();
    },

    async removeTranslation(typeName, id, locale) {
      const type = typeOf(typeName);
      if (!locales.includes(locale)) return fieldFailure(typeName, [{ field: "locale", message: `unknown locale "${locale}"` }]);
      const existing = type.kind === "single" ? await single(typeName) : await db.findOne<Document>(typeName, { id });
      if (isErr(existing)) return existing;
      if (existing.value === null) return err(failure("NOT_FOUND", `${typeName}/${id} not found`));
      const translations = fromRow(typeName, existing.value, defaultLocale)._translations ?? {};
      if (!translations[locale]) return err(failure("NOT_FOUND", `${typeName}/${id} has no ${locale} translation`));
      if (Object.values(translations).filter(Boolean).length === 1) return err(failure("CONFLICT", `${typeName}/${id}: ${locale} is the last translation – remove the document`));
      const cleared: Record<string, unknown> = {};
      for (const [field, raw] of Object.entries(type.fields)) {
        const def = definition(raw);
        if (def.localized) cleared[column(field, def, locale)] = null;
      }
      const row = await db.updateOne<Document>(typeName, existing.value.id, { ...cleared, updatedAt: now() });
      if (isErr(row)) return row;
      return ok(fromRow(typeName, row.value, defaultLocale));
    },
  };
  return api;
}
