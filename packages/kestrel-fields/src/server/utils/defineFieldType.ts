import type { FieldTypeDescriptor } from '@kestrel/core'
import { registerFieldType } from '../field-registry/index.js'

export type { FieldTypeDescriptor }
// Re-export the descriptor helpers so a consumer's field-type file can build the Drizzle column + Zod with
// the SAME optionality/constraint logic the built-ins use — all auto-imported in a `server/field-types/` file.
export { constrain, opt, optArr, isHardRequired, getFieldType, registerFieldType } from '../field-registry/index.js'

/**
 * A consumer-defined field type: a `name` plus the server contract — a Drizzle `column` and a Zod
 * `validator`. Drop a file in `server/field-types/` that default-exports `defineFieldType({...})`; it is
 * auto-discovered and registered BEFORE any table is built. Pair it with a client editor widget via
 * `registerFieldComponent('<name>', Component)` in an `app/plugins/*.client.ts`.
 *
 * @example
 * ```ts
 * // server/field-types/color.ts
 * import { text } from 'drizzle-orm/sqlite-core'
 * import { z } from 'zod'
 * export default defineFieldType({
 *   name: 'color',
 *   column: (n, f) => constrain(text(n), f),
 *   validator: (f) => opt(z.string().regex(/^#[0-9a-f]{6}$/i), f),
 * })
 * ```
 * @public
 */
export interface FieldTypeDef extends FieldTypeDescriptor {
  name: string
}

/** Registers `def` under `def.name` and returns its descriptor (column + validator + transform) —
 *  the function a consumer's `server/field-types/*.ts` file default-exports.
 * @public
 */
export function defineFieldType(def: FieldTypeDef): FieldTypeDescriptor {
  const { name, ...descriptor } = def // keep column, validator AND transform — don't drop a consumer's transform
  registerFieldType(name, descriptor)
  return descriptor
}
