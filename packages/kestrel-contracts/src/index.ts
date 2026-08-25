/**
 * The single source of Kestrel's system specification: tagged error unions, branded ids, and event
 * payloads shared between the engine and its consumers. The public surface never exposes an Effect
 * type — Promises, plain objects, and tagged error values only.
 *
 *
 * @packageDocumentation
 */

export * from './brands.js'
export * from './errors.js'
export * from './envelope.js'
export * from './events.js'
export * from './extension-points.js'

/**
 * The contracts package's own semantic version, independent of the engine's release version.
 *
 * @public
 */
export const CONTRACTS_VERSION = '0.1.0'
