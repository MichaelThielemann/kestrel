/**
 * Tagged error classes for every way a Kestrel operation can fail, and the union that types the
 * error channel of an Effect. Each class is both a `Schema` (for encoding across the Promise
 * boundary, per ADR-0011) and a constructible/throwable value carrying its own `_tag`.
 *
 * @packageDocumentation
 */

import { Schema } from 'effect'

/**
 * The requested record does not exist in the given collection.
 *
 * @public
 */
export class NotFound extends Schema.TaggedError<NotFound>()('NotFound', {
  collection: Schema.String,
  id: Schema.Int,
  /** Present on a batch lookup (an all-or-nothing write/delete over several ids): every id that was
   *  missing, not just `id` (the first one). Absent on a single-record lookup. */
  ids: Schema.optional(Schema.Array(Schema.Int)),
}) {}

/**
 * The actor is not permitted to perform the attempted operation.
 *
 * @public
 */
export class Forbidden extends Schema.TaggedError<Forbidden>()('Forbidden', {
  reason: Schema.String,
}) {}

/**
 * The actor's identity could not be established (no session, or the credentials it presented were
 * rejected) — distinct from `Forbidden`, which requires a known identity that lacks permission.
 *
 * @public
 */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()('Unauthorized', {
  reason: Schema.String,
}) {}

/**
 * The specifics of a `Conflict` beyond `field`/`value`, for the shapes a consumer needs more than a
 * generic message to resolve: a rename suggestion for a duplicate upload, or the baseline the caller's
 * copy went stale against.
 *
 * @public
 */
export const ConflictDetails = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('duplicate'),
    suggestion: Schema.optional(Schema.String),
    existingId: Schema.optional(Schema.Int),
  }),
  Schema.Struct({
    kind: Schema.Literal('stale'),
    expectedUpdatedAt: Schema.String,
    actualUpdatedAt: Schema.String,
  }),
)

/**
 * @public
 */
export type ConflictDetails = Schema.Schema.Type<typeof ConflictDetails>

/**
 * A uniqueness constraint on `field` was violated by `value`. `details` is additive: absent for a plain
 * duplicate-value conflict, present when a consumer needs more than the message to resolve it.
 *
 * @public
 */
export class Conflict extends Schema.TaggedError<Conflict>()('Conflict', {
  field: Schema.String,
  value: Schema.String,
  details: Schema.optional(ConflictDetails),
}) {}

/**
 * Input failed schema validation; `issues` lists every field-level failure.
 *
 * @public
 */
export class ValidationFailed extends Schema.TaggedError<ValidationFailed>()('ValidationFailed', {
  issues: Schema.Array(
    Schema.Struct({
      // Real Zod issue path segments, verbatim: `path[0]` reads, a numeric segment is a repeater/array
      // index or a block position, and a consumer compares a raw segment (e.g. against 'content') to
      // route the issue to a block editor. Joining this into one string would throw that structure away.
      path: Schema.Array(Schema.Union(Schema.String, Schema.Number)),
      message: Schema.String,
      code: Schema.optional(Schema.String),
    }),
  ),
}) {}

/**
 * The target is locked for editing until the given timestamp.
 *
 * @public
 */
export class Locked extends Schema.TaggedError<Locked>()('Locked', {
  until: Schema.String,
}) {}

/**
 * The record failed a sealed read guarantee and was quarantined rather than served.
 *
 * @public
 */
export class Quarantined extends Schema.TaggedError<Quarantined>()('Quarantined', {
  id: Schema.Int,
}) {}

/**
 * Every error a Kestrel operation can fail with. The public API surfaces this union as a plain
 * tagged value, never as an Effect type (ADR-0011).
 *
 * @public
 */
export type KestrelError =
  | NotFound
  | Forbidden
  | Unauthorized
  | Conflict
  | ValidationFailed
  | Locked
  | Quarantined
