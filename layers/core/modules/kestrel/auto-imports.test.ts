import { describe, expect, it } from 'vitest'
import { appAutoImports, serverAutoImports } from './auto-imports'

describe('kestrel auto-imports', () => {
  it('every registered name is exported by its package', async () => {
    const bySource = new Map<string, string[]>()
    for (const { name, from } of [...serverAutoImports, ...appAutoImports]) {
      bySource.set(from, [...(bySource.get(from) ?? []), name])
    }
    for (const [from, names] of bySource) {
      const mod = (await import(from)) as Record<string, unknown>
      const missing = names.filter((n) => typeof mod[n] !== 'function')
      expect(missing, `${from} does not export`).toEqual([])
    }
  })

  it('registers no name twice', () => {
    const names = [...serverAutoImports, ...appAutoImports].map((e) => e.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
