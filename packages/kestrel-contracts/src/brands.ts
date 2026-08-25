/**
 * Branded schemas: values that only exist once they have passed through a specific decode, so the
 * type system can tell "raw string" apart from "string that went through sanitizing". A brand is
 * erased at runtime — nothing except `Schema.decodeUnknownSync`/`decodeUnknownEither` (or a literal
 * cast) can produce one, which is what makes the compile-time distinction meaningful.
 *
 * @packageDocumentation
 */

import { Schema } from 'effect'

/**
 * Richtext HTML that has passed the sanitizer. Not assignable from a plain `string`.
 *
 * @public
 */
export const SanitizedRichtext = Schema.String.pipe(Schema.brand('Sanitized'))

/**
 * Richtext HTML that has passed the sanitizer. Not assignable from a plain `string`.
 *
 * @public
 */
export type SanitizedRichtext = Schema.Schema.Type<typeof SanitizedRichtext>

/**
 * A string that has been HTML-escaped. Distinct from `SanitizedRichtext`: escaping and sanitizing
 * serve different call sites and are not interchangeable despite both wrapping `string`.
 *
 * @public
 */
export const EscapedHtml = Schema.String.pipe(Schema.brand('Escaped'))

/**
 * A string that has been HTML-escaped. Distinct from `SanitizedRichtext`: escaping and sanitizing
 * serve different call sites and are not interchangeable despite both wrapping `string`.
 *
 * @public
 */
export type EscapedHtml = Schema.Schema.Type<typeof EscapedHtml>

/**
 * A slug that has been resolved against the collection's uniqueness rules.
 *
 * @public
 */
export const ResolvedSlug = Schema.String.pipe(Schema.brand('Slug'))

/**
 * A slug that has been resolved against the collection's uniqueness rules.
 *
 * @public
 */
export type ResolvedSlug = Schema.Schema.Type<typeof ResolvedSlug>

/**
 * Input that has passed schema validation. The field shape is a placeholder — every collection's
 * actual input schema differs, so this brand exists to be composed with a collection-specific
 * struct at the call site, not to describe one universal shape.
 *
 * @public
 */
export const ValidatedInput = Schema.mutable(Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
})).pipe(Schema.brand('Validated'))

/**
 * Input that has passed schema validation. The field shape is a placeholder — every collection's
 * actual input schema differs, so this brand exists to be composed with a collection-specific
 * struct at the call site, not to describe one universal shape.
 *
 * @public
 */
export type ValidatedInput = Schema.Schema.Type<typeof ValidatedInput>

/**
 * The fully materialized, publishable state of one route: rendered HTML with every media reference
 * already resolved to a fixed URL (never a pointer a delivery adapter would need to look up), the locale
 * variant it was rendered for (`null` for a non-translatable route), and the fingerprint the snapshot
 * store deduplicates on. A `DeliveryPort` never sees a draft — every method on that port exchanges this
 * shape, so every delivery adapter (static or live) renders the same published state by construction.
 *
 * @public
 */
export const PublishedSnapshot = Schema.Struct({
  route: Schema.String,
  locale: Schema.NullOr(Schema.String),
  html: Schema.String,
  media: Schema.Array(Schema.String),
  fingerprint: Schema.String,
  publishedAt: Schema.Number,
}).pipe(Schema.brand('Snapshot'))

/**
 * The fully materialized, publishable state of one route: rendered HTML with every media reference
 * already resolved to a fixed URL (never a pointer a delivery adapter would need to look up), the locale
 * variant it was rendered for (`null` for a non-translatable route), and the fingerprint the snapshot
 * store deduplicates on. A `DeliveryPort` never sees a draft — every method on that port exchanges this
 * shape, so every delivery adapter (static or live) renders the same published state by construction.
 *
 * @public
 */
export type PublishedSnapshot = Schema.Schema.Type<typeof PublishedSnapshot>
