import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const root = process.cwd()
const CEILINGS = 'test/architecture/public-api-ceilings.json'

/**
 * Every api-extractor report on disk (`packages/<pkg>/etc/*.api.md`), discovered rather than listed — a
 * new package, or a second entry point in an existing one, shows up here the run after it is generated.
 */
function reportFiles(): string[] {
  const base = resolve(root, 'packages')
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(base, e.name, 'etc'))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.api.md')).map((f) => join(dir, f)))
    .map((abs) => abs.slice(root.length + 1))
    .sort()
}

/** One release-tagged entry = one symbol on that entry point's public surface. */
function taggedEntries(relPath: string): number {
  return readFileSync(resolve(root, relPath), 'utf8')
    .split('\n')
    .filter((line) => /^\/\/ @(public|alpha|beta|internal)\b/.test(line))
    .length
}

describe('the packages\' public API surface stays under its recorded ceiling', () => {
  const ceilings = JSON.parse(readFileSync(resolve(root, CEILINGS), 'utf8')) as Record<string, number>
  const files = reportFiles()

  it('sanity: the reports are discovered and the ceilings are non-vacuous', () => {
    expect(files.length).toBeGreaterThanOrEqual(12)
    expect(Object.values(ceilings).every((n) => Number.isInteger(n) && n > 0)).toBe(true)
  })

  it(`${CEILINGS} covers exactly the reports that exist`, () => {
    expect(Object.keys(ceilings).sort(), `add the new report(s) to ${CEILINGS} with their current entry count`).toEqual(files)
  })

  for (const file of files) {
    it(`${file} stays at or below its ceiling`, () => {
      const ceiling = ceilings[file]
      expect(ceiling, `${file} has no ceiling in ${CEILINGS}`).toBeDefined()
      const count = taggedEntries(file)
      expect(
        count,
        `${file} now exports ${count} release-tagged symbols, above its ceiling of ${ceiling}. `
        + `Public API is a commitment: either keep the new symbol package-internal (drop it from the barrel, `
        + `or turn that module's \`export *\` into a named list) or raise the ceiling in ${CEILINGS} deliberately.`,
      ).toBeLessThanOrEqual(ceiling!)
    })
  }
})
