import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

describe('port-graph output location', () => {
  it('does not write into the directory graphify owns', () => {
    const src = readFileSync('scripts/port-graph.mjs', 'utf8')
    expect(src).not.toMatch(/writeFileSync\([^)]*graphify-out/)
    expect(src).toContain('reports/graph')
  })
})
