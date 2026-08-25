/**
 * The event envelope: the wire shape every domain event is wrapped in before it leaves the
 * outbox. Carries identity, ordering, and causation metadata alongside the opaque `payload`.
 *
 * @packageDocumentation
 */

import { Schema } from 'effect'

/**
 * The wire shape of a domain event as read from the outbox. `payload` is intentionally
 * `Schema.Unknown` — its shape is defined per event `name`/`version` and validated by the
 * consumer, not by this envelope.
 *
 * @public
 */
export const EventEnvelope = Schema.Struct({
  id: Schema.UUID,
  name: Schema.String,
  version: Schema.Int,
  aggregate: Schema.Struct({
    collection: Schema.String,
    recordId: Schema.Int,
  }),
  sequence: Schema.Int,
  correlationId: Schema.String,
  causation: Schema.Struct({
    pipeline: Schema.String,
    op: Schema.String,
  }),
  occurredAt: Schema.DateTimeUtc,
  payload: Schema.Unknown,
})

/**
 * The wire shape of a domain event as read from the outbox. `payload` is intentionally
 * `Schema.Unknown` — its shape is defined per event `name`/`version` and validated by the
 * consumer, not by this envelope.
 *
 * @public
 */
export type EventEnvelope = Schema.Schema.Type<typeof EventEnvelope>
