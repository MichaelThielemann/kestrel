import { defineContract } from "@michaelthielemann/kestrel/defineContract";
import type { KestrelError, Result } from "./errors.ts";
import type { LinkTarget } from "./links.ts";
import type { Filter, FindOptions, Page } from "./query.ts";

export type FieldType = "text" | "richtext" | "number" | "boolean" | "date" | "slug" | "json" | "enum" | "ref";

export interface FieldDefinition {
  type: FieldType;
  required?: boolean;
  unique?: boolean;
  localized?: boolean;
  options?: string[];
  to?: string;
}

export type Kind = "single" | "multi";

export interface TypeDefinition {
  kind: Kind;
  fields: Record<string, FieldType | FieldDefinition>;
  completeWhen?: { field: string; equals: string };
}

export interface ContentModel {
  types: Record<string, TypeDefinition>;
  locales?: string[];
  defaultLocale?: string;
}

export interface ContentDocument {
  id: string;
  createdAt: number;
  updatedAt: number;
  _locales?: Record<string, string>;
  _translations?: Record<string, boolean>;
  _locale?: string;
  _links?: Record<string, LinkTarget>;
  [field: string]: unknown;
}

export interface FieldError {
  field: string;
  message: string;
}

export type Validation = { ok: true; data: Record<string, unknown> } | { ok: false; errors: FieldError[] };

export interface LocaleOptions {
  locale?: string;
  fallback?: boolean;
}

export type ContentError = KestrelError<"VALIDATION" | "NOT_FOUND" | "CONFLICT" | "TRANSIENT">;

export interface Content {
  model(): ContentModel;
  validate(type: string, data: Record<string, unknown>, mode: "create" | "update", options?: LocaleOptions): Validation;
  get(type: string, id?: string, options?: LocaleOptions): Promise<Result<ContentDocument | null, ContentError>>;
  list(type: string, filter?: Filter, options?: FindOptions & LocaleOptions): Promise<Result<Page<ContentDocument>, ContentError>>;
  create(type: string, data: Record<string, unknown>, options?: LocaleOptions): Promise<Result<ContentDocument, ContentError>>;
  set(type: string, data: Record<string, unknown>, options?: LocaleOptions): Promise<Result<ContentDocument, ContentError>>;
  update(type: string, id: string, patch: Record<string, unknown>, options?: LocaleOptions): Promise<Result<ContentDocument, ContentError>>;
  remove(type: string, id: string): Promise<Result<void, ContentError>>;
  /** Clears every localized field of `locale`; the document stays in its other locales. */
  removeTranslation(type: string, id: string, locale: string): Promise<Result<ContentDocument, ContentError>>;
}

export const CONTENT = defineContract<Content>()("content@1", ["model", "validate", "get", "list", "create", "set", "update", "remove", "removeTranslation"]);
