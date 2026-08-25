import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'

const REPORT = 'reports/coverage/coverage-final.json'

describe('coverage artifact', () => {
  it('is produced with branch data for at least one package source file', () => {
    if (!existsSync(REPORT)) {
      throw new Error(`${REPORT} missing — run \`pnpm test:coverage\` first`)
    }
    const cov = JSON.parse(readFileSync(REPORT, 'utf8'))
    const entries = Object.entries(cov).filter(([path]) => path.includes('/packages/'))
    expect(entries.length).toBeGreaterThan(0)

    const [, first] = entries[0]
    expect(first).toHaveProperty('branchMap')
    expect(first).toHaveProperty('b')
    expect(first).toHaveProperty('fnMap')
    expect(first).toHaveProperty('f')
  })
})
