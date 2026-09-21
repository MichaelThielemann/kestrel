import type { JsonSchema } from "@michaelthielemann/kestrel/defineModule";
import type { ContentModel, FieldDefinition, FieldType } from "./content.ts";

export const FIELD_SCHEMA: Record<FieldType, JsonSchema> = {
  text: { type: "string" },
  richtext: { type: "string" },
  slug: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
  number: { type: "number" },
  boolean: { type: "boolean" },
  date: { type: "number", description: "milliseconds since epoch; ISO-8601 accepted on write" },
  json: {},
  enum: { type: "string" },
  ref: { type: "string", description: "id of the referenced document" },
};

export function fieldSchema(raw: FieldType | FieldDefinition, nullable: boolean): JsonSchema {
  const def = typeof raw === "string" ? { type: raw } : raw;
  const base: JsonSchema = { ...FIELD_SCHEMA[def.type] };
  if (def.type === "enum") base.enum = def.options ?? [];
  if (def.type === "ref") base.description = `id of a ${def.to ?? "document"}`;
  return nullable ? { anyOf: [base, { type: "null" }] } : base;
}

/** `siteFields` adds `_locale` and `_links`, which only `site@1` steps produce. */
export function documentSchema(model: ContentModel, type: string, options: { siteFields?: boolean } = {}): JsonSchema {
  const properties: Record<string, JsonSchema> = { id: { type: "string" }, createdAt: { type: "number" }, updatedAt: { type: "number" } };
  for (const [name, raw] of Object.entries(model.types[type]?.fields ?? {})) properties[name] = fieldSchema(raw, true);
  if (model.locales) {
    properties._locales = { type: "object", additionalProperties: { type: "string" }, description: "origin locale per field, only with fallback" };
    properties._translations = { type: "object", additionalProperties: { type: "boolean" }, description: "per locale: required localized fields present" };
    if (options.siteFields) {
      properties._locale = { type: "string", description: "effective locale of a site-resolved document" };
      properties._links = { type: "object", additionalProperties: { type: "object", properties: { path: { type: "string" }, locale: { type: "string" }, broken: { type: "boolean" } } }, description: "internal references by target id after site.resolveLinks" };
    }
  }
  return { type: "object", properties, required: ["id", "createdAt", "updatedAt"] };
}
