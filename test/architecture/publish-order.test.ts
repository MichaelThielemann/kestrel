import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const root = process.cwd()

/**
 * The @kestrel/* publish/install order appears in two hand-written lists — the release.yml publish
 * steps and consumer-template-ci.mjs's PACKAGES array. This rail derives the real dependency graph
 * from the packages' own manifests on disk and asserts both lists are complete, mutually consistent,
 * and topologically valid (every package listed only after everything it depends on).
 */

function kestrelPackages(): Map<string, string[]> {
  const base = resolve(root, 'packages')
  const graph = new Map<string, string[]>()
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(base, entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name?: string
      dependencies?: Record<string, string>
    }
    if (!manifest.name?.startsWith('@kestrel/')) continue
    graph.set(
      manifest.name,
      Object.keys(manifest.dependencies ?? {}).filter((dep) => dep.startsWith('@kestrel/')),
    )
  }
  return graph
}

function releaseYmlOrder(): string[] {
  const yml = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8')
  return [...yml.matchAll(/working-directory: packages\/kestrel-([a-z0-9-]+)/g)].map(
    (m) => `@kestrel/${m[1]}`,
  )
}

function ciScriptOrder(): string[] {
  const source = readFileSync(resolve(root, 'scripts/consumer-template-ci.mjs'), 'utf8')
  const match = source.match(/const PACKAGES = \[([^\]]+)\]/)
  expect(match, 'consumer-template-ci.mjs must declare a PACKAGES array literal').not.toBeNull()
  return [...match![1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => `@kestrel/${m[1]}`)
}

function assertTopological(order: string[], graph: Map<string, string[]>, label: string): void {
  expect([...graph.keys()].sort(), `${label} must list every @kestrel/* package exactly once`).toEqual(
    [...order].sort(),
  )
  const position = new Map(order.map((name, i) => [name, i]))
  for (const name of order) {
    for (const dep of graph.get(name)!) {
      expect(
        position.get(dep)!,
        `${label}: ${name} depends on ${dep} but is listed before it`,
      ).toBeLessThan(position.get(name)!)
    }
  }
}

describe('@kestrel/* publish order is topologically valid', () => {
  const graph = kestrelPackages()

  it('sanity: the graph derivation is not vacuous', () => {
    expect(graph.size).toBeGreaterThanOrEqual(10)
    expect([...graph.values()].some((deps) => deps.length > 0)).toBe(true)
  })

  it('release.yml publishes every package after all of its dependencies', () => {
    assertTopological(releaseYmlOrder(), graph, 'release.yml')
  })

  it('consumer-template-ci.mjs packs in the same dependency-safe order', () => {
    assertTopological(ciScriptOrder(), graph, 'consumer-template-ci.mjs')
  })
})
