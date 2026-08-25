/**
 * The event upcast registry: pure payload transformations that carry an {@link EventEnvelope}
 * from the version it was persisted at up to the latest version its `name` has registered
 * upcasts for.
 *
 * @packageDocumentation
 */

import { Schema } from 'effect'
import type { EventEnvelope } from './envelope.js'

/**
 * A single upcast step: transforms the payload of an event named `name` from `fromVersion` to
 * `fromVersion + 1`. Must be pure — no I/O, no ambient time, no randomness — since
 * {@link upcastToLatest} may apply a chain of these synchronously and repeatedly.
 *
 * @public
 */
export type UpcastFn = (payload: unknown) => unknown

/**
 * Registration was attempted for a `(name, fromVersion)` pair that already has an upcast
 * registered. Each step in a chain may only be defined once.
 *
 * @public
 */
export class DuplicateUpcast extends Schema.TaggedError<DuplicateUpcast>()('DuplicateUpcast', {
  eventName: Schema.String,
  fromVersion: Schema.Int,
}) {}

/**
 * {@link upcastToLatest} needed a step that was never registered: some `fromVersion` between the
 * event's version and the chain's latest registered version has no upcast. The chain must be
 * contiguous to be walkable.
 *
 * @public
 */
export class UpcastGap extends Schema.TaggedError<UpcastGap>()('UpcastGap', {
  eventName: Schema.String,
  fromVersion: Schema.Int,
}) {}

/**
 * Every error {@link registerUpcast} or {@link upcastToLatest} can throw.
 *
 * @public
 */
export type UpcastError = DuplicateUpcast | UpcastGap

const registry = new Map<string, Map<number, UpcastFn>>()

/**
 * Registers a pure upcast step for events named `name`: applied when an event of that name is
 * found at `fromVersion`, producing the payload for `fromVersion + 1`.
 *
 * Throws {@link DuplicateUpcast} if a step for the same `(name, fromVersion)` pair is already
 * registered.
 *
 * @public
 */
export function registerUpcast(name: string, fromVersion: number, fn: UpcastFn): void {
  let chain = registry.get(name)
  if (chain === undefined) {
    chain = new Map()
    registry.set(name, chain)
  }
  if (chain.has(fromVersion)) {
    throw new DuplicateUpcast({ eventName: name, fromVersion })
  }
  chain.set(fromVersion, fn)
}

/**
 * Walks an event's payload through every registered upcast step from its current `version` up to
 * the highest version registered for its `name`, returning a new envelope at that latest version.
 *
 * Invariants:
 * - **Pure**: only calls the registered `fn`s on `payload`; never reads the clock, I/O, or any
 *   ambient state. `occurredAt`, `id`, and every other envelope field pass through unchanged.
 * - **Idempotent**: an event already at or above the latest registered version (or whose `name`
 *   has no registered upcasts at all) is returned unchanged — re-running an already-upcast event
 *   through this function is always safe.
 * - **Total up to the registered max**: every version from 1 to the latest registered version
 *   upcasts without throwing, provided the chain is contiguous.
 * - **Gap ⇒ tagged error**: if the chain from the event's version to the latest registered
 *   version is missing a step, throws {@link UpcastGap} rather than silently skipping it.
 *
 * @public
 */
export function upcastToLatest(event: EventEnvelope): EventEnvelope {
  const chain = registry.get(event.name)
  if (chain === undefined || chain.size === 0) {
    return event
  }

  const latestVersion = Math.max(...chain.keys()) + 1
  if (event.version >= latestVersion) {
    return event
  }

  let version = event.version
  let payload = event.payload
  while (version < latestVersion) {
    const fn = chain.get(version)
    if (fn === undefined) {
      throw new UpcastGap({ eventName: event.name, fromVersion: version })
    }
    payload = fn(payload)
    version += 1
  }

  return { ...event, version, payload }
}

/**
 * Wipes every registered upcast for every event name. Intended for test isolation between runs
 * that register their own upcast chains against the shared module-level registry.
 *
 * @public
 */
export function clearUpcasts(): void {
  registry.clear()
}
