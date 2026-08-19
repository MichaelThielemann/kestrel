import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Vitest runs from the package root.
const root = process.cwd()
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8')
const fieldTypesMd = read('docs/field-types.md')
const defineCollectionTs = read('layers/core/server/utils/defineCollection.ts')

/** The built-in arms of the `FieldType` union — the open `(string & {})` arm is the consumer escape hatch. */
const builtinTypes = (): string[] => {
  const union = defineCollectionTs.match(/export type FieldType =([\s\S]*?)\n\n/)?.[1] ?? ''
  return [...union.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!)
}

describe('docs — field types', () => {
  it('covers every built-in field type', () => {
    // An undocumented type is one a consumer either never finds or uses wrong; `json` shipped
    // unmentioned for exactly that reason.
    const types = builtinTypes()
    expect(types.length).toBe(12)
    for (const type of types) {
      expect(fieldTypesMd, `docs/field-types.md is missing a "## ${type}" section`).toMatch(
        new RegExp(`^## ${type}$`, 'm'),
      )
    }
  })

  it('gives every type a runnable example and a signature', () => {
    for (const type of builtinTypes()) {
      const section = fieldTypesMd.split(new RegExp(`^## ${type}$`, 'm'))[1]?.split(/^## /m)[0] ?? ''
      expect(section, `"## ${type}" has no code block`).toMatch(/```ts/)
      expect(section, `"## ${type}" never names its own type`).toMatch(new RegExp(`type: '${type}'`))
    }
  })

  it('keeps the caveats that are not derivable from the type signatures', () => {
    // Each of these is a behaviour the TypeScript signature actively misleads about.
    expect(fieldTypesMd).toMatch(/integer by default/i)
    expect(fieldTypesMd).toMatch(/`unique` is a no-op/i)
    expect(fieldTypesMd).toMatch(/advisory/i)
  })

  it('is reachable from the README and the consuming guide', () => {
    expect(read('README.md')).toMatch(/\(docs\/field-types\.md\)/)
    expect(read('docs/consuming-kestrel.md')).toMatch(/\(\.\/field-types\.md\)/)
  })
})
