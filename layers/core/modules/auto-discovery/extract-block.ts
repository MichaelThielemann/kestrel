import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parse } from '@babel/parser'
import type { FieldDef } from '../../server/utils/defineCollection'
import * as factoryModule from '../../../fields/app/utils/field-factories'
import { KESTREL_FIELD } from '../../../fields/app/utils/field-factories'

/** The extracted block definition (shape mirrors `BlockDef`, kept structural so this build-time module
 *  needs no `layers/fields` runtime import). */
export interface ExtractedBlock {
  name: string
  fields: Record<string, FieldDef>
  slots?: string[]
  label?: unknown
  icon?: string
  image?: string
}

// Only the callable factories are injected into the schema-eval scope (exclude the KESTREL_FIELD symbol).
const FACTORIES: Record<string, unknown> = Object.fromEntries(
  Object.entries(factoryModule).filter(([, v]) => typeof v === 'function'),
)
// The factory functions themselves, to catch an uncalled factory (`heading: textField` vs `textField()`).
const FACTORY_SET = new Set(Object.values(FACTORIES))

/** `Hero.vue` → `hero`, `BoxedContainer.vue` → `boxedContainer` (camel-case; `BlockRenderer` pascal-cases it
 *  back to the `Blocks<Name>` component). */
export function blockNameFromFile(fileBase: string): string {
  const name = fileBase.replace(/\.vue$/, '')
  return name.charAt(0).toLowerCase() + name.slice(1)
}

/** The raw `<script setup>` source. `setup` is matched in ANY attribute position (`<script setup lang="ts">`
 *  and `<script lang="ts" setup>` are both valid), so a plain `<script>` block (no `setup` word) is skipped.
 *  (A real Vite build could use `@vue/compiler-sfc parse` for full robustness — e.g. a `</script>` inside a
 *  string literal; a scoped match is adequate + dependency-light here.) */
function scriptSetup(sfc: string, where: string): string {
  const m = sfc.match(/<script\b[^>]*\bsetup\b[^>]*>([\s\S]*?)<\/script>/)
  if (!m) throw new Error(`${where}: a Kestrel block SFC must have a <script setup> block`)
  return m[1]
}

interface Node { type: string; start: number; end: number; [k: string]: unknown }

/** Peel the wrappers a macro call is commonly written behind so the CallExpression underneath is reached:
 *  a TS as-cast / satisfies (`defineProps({…}) as T`), a non-null assertion (`defineProps({…})!`), and
 *  parentheses. */
function unwrapExpr(node: unknown): Record<string, unknown> | undefined {
  let n = node as Record<string, unknown> | undefined
  while (n && (n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression' || n.type === 'TSNonNullExpression' || n.type === 'ParenthesizedExpression')) {
    n = n.expression as Record<string, unknown> | undefined
  }
  return n
}

/** If `call` resolves to `<macro>(…)`, its first arg node + whether it carried a type parameter
 *  (`defineProps<T>()`, unsupported — no runtime schema). Also looks INSIDE `withDefaults(defineProps(…), …)`
 *  — the most common props idiom — so that form is not silently extracted as an empty schema. */
function macroInCall(call: unknown, macro: string): { arg?: Node; hasTypeParam: boolean } | undefined {
  const n = unwrapExpr(call)
  if (n?.type !== 'CallExpression') return undefined
  const callee = n.callee as Record<string, unknown> | undefined
  if (callee?.type === 'Identifier' && callee.name === macro) {
    return { arg: (n.arguments as Node[])[0], hasTypeParam: !!(n.typeParameters || n.typeArguments) }
  }
  // withDefaults(defineProps(…), { … }) — recurse into its arguments to find the wrapped macro call.
  if (callee?.type === 'Identifier' && callee.name === 'withDefaults') {
    for (const a of (n.arguments as unknown[]) ?? []) {
      const hit = macroInCall(a, macro)
      if (hit) return hit
    }
  }
  return undefined
}

/** The FIRST TOP-LEVEL `<macro>(…)` call — a bare `defineBlock({…})` (ExpressionStatement), a
 *  `const props = defineProps({…})` (VariableDeclaration init, incl. `export const` and wrapper forms).
 *  Vue's macros are top-level by contract, so scanning only `program.body` (not a deep DFS) means a call
 *  nested in a helper function can't shadow it. */
function macroCall(ast: unknown, macro: string): { arg?: Node; hasTypeParam: boolean } | undefined {
  const body = (ast as { program?: { body?: unknown[] } }).program?.body
  if (!Array.isArray(body)) return undefined
  for (const raw of body as Array<Record<string, unknown>>) {
    // Unwrap `export const props = …` → the VariableDeclaration it wraps.
    const stmt = raw.type === 'ExportNamedDeclaration' && raw.declaration ? (raw.declaration as Record<string, unknown>) : raw
    if (stmt.type === 'ExpressionStatement') {
      const hit = macroInCall(stmt.expression, macro)
      if (hit) return hit
    } else if (stmt.type === 'VariableDeclaration') {
      for (const d of (stmt.declarations as Array<Record<string, unknown>>) ?? []) {
        const hit = macroInCall(d.init, macro)
        if (hit) return hit
      }
    }
  }
  return undefined
}

function evalObjectExpr(content: string, node: Node, scope: Record<string, unknown>, where: string): Record<string, unknown> {
  const src = content.slice(node.start, node.end)
  const names = Object.keys(scope)
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const fn = new Function(...names, `return (${src})`)
    const out = fn(...names.map((k) => scope[k]))
    if (!out || typeof out !== 'object') throw new Error('expected an object literal')
    return out as Record<string, unknown>
  } catch (e) {
    throw new Error(
      `${where}: could not evaluate the block declaration. Field/block args must be self-contained literals + ` +
        `field-factory calls (no imported constants, computed values, or TS type-args). Cause: ${(e as Error).message}`,
    )
  }
}

/**
 * Extract a `BlockDef` from a block SFC's source: `defineProps({ … field factories … })` → `fields`,
 * `defineBlock({ label, slots, icon })` → metadata, `name` ← filename. Static (no component execution): the
 * `defineProps`/`defineBlock` argument object-literals are sliced from source and evaluated with the field
 * factories in scope; each field's `[KESTREL_FIELD]` is lifted into the schema.
 */
export function extractBlockDef(sfcSource: string, fileBase: string): ExtractedBlock {
  const name = blockNameFromFile(fileBase)
  const content = scriptSetup(sfcSource, fileBase)
  let ast: ReturnType<typeof parse>
  try {
    ast = parse(content, { sourceType: 'module', plugins: ['typescript'] })
  } catch (e) {
    throw new Error(`${fileBase}: could not parse <script setup> — ${(e as Error).message}`)
  }

  const props = macroCall(ast, 'defineProps')
  if (props?.hasTypeParam && !props.arg) {
    throw new Error(`${fileBase}: use the runtime form defineProps({ … }) with field factories, not defineProps<T>() — the type-only form carries no schema`)
  }
  const propsObj = props?.arg ? evalObjectExpr(content, props.arg, FACTORIES, fileBase) : {}

  const block = macroCall(ast, 'defineBlock')
  const meta = block?.arg ? evalObjectExpr(content, block.arg, {}, fileBase) : {}

  const fields: Record<string, FieldDef> = {}
  for (const [key, value] of Object.entries(propsObj)) {
    const carried = value && typeof value === 'object' ? (value as Record<symbol, unknown>)[KESTREL_FIELD] : undefined
    if (carried === undefined) {
      // An UNCALLED field factory (`heading: textField` instead of `textField()`) evaluates to the factory
      // function itself — catch that common slip loudly rather than silently dropping the field.
      if (typeof value === 'function' && FACTORY_SET.has(value)) {
        throw new Error(`${fileBase}: prop "${key}" is a field factory that was not called — write ${(value as { name?: string }).name ?? 'xField'}({ … })`)
      }
      // Otherwise it's a plain (display-only) Vue prop (e.g. `media: Object`, the server-resolved $media bag
      // BlockRenderer passes) — not part of the block schema. A misspelled factory throws at eval time above.
      continue
    }
    const def = carried as FieldDef & { default?: unknown }
    if (typeof def.default === 'function') {
      // The registry is inlined as JSON (renderBlockRegistry) — a function default would be silently dropped.
      throw new Error(`${fileBase}: prop "${key}" has a function \`default\` — block field defaults must be JSON-serializable literals`)
    }
    fields[key] = carried as FieldDef
  }

  const out: ExtractedBlock = { name, fields }
  if (meta.label !== undefined) out.label = meta.label
  if (Array.isArray(meta.slots) && meta.slots.length) out.slots = meta.slots as string[]
  if (typeof meta.icon === 'string') out.icon = meta.icon
  if (typeof meta.image === 'string') out.image = meta.image
  return out
}

/** The `#kestrel/blocks` virtual body: extract each block SFC and inline the definitions as JSON data
 *  (the block registry is plain, JSON-safe data — no imports needed beyond the field-type side effect the
 *  caller prepends). */
export function renderBlockRegistry(vuePaths: string[]): string {
  const defs = vuePaths.map((p) => extractBlockDef(readFileSync(p, 'utf8'), basename(p)))
  return `export default ${JSON.stringify(defs)}`
}
