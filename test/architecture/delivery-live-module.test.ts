import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Contract tests for delivery-live. The real logic (`port.ts`, `pipeline.ts`, `redirects.ts`) lives in
 * `@kestrel/delivery-live`'s own `src/`; only `serve.ts` (the request-handling entry point the Nitro
 * middleware calls) stays a layer file — see `docs/internals/publishing.md`. `moduleFiles()`
 * scans BOTH locations, so the B3 "never reads content the wrong way" contract still covers the real logic
 * wherever it lives, not just what happens to still be in the layer.
 *
 * DESIGN — module discovery locates delivery-live's exports by name/shape rather than assume one exact
 * file layout.
 *
 * AMBIGUITY — export naming. delivery-static's factory is `createStaticDeliveryPort`; this suite assumes
 * the live sibling follows the same `create<Adjective>DeliveryPort` naming (`createLiveDeliveryPort`).
 * If the implementer names it differently, point A1 below needs updating — flagged, not silently widened
 * to "any exported function", which would defeat the point of pinning a discoverable factory at all.
 */

const root = process.cwd()
const scanDirs = [
  resolve(root, 'layers/public/server/delivery-live'),
  resolve(root, 'packages/kestrel-delivery-live/src'),
]

function moduleFiles(): string[] {
  const out: string[] = []
  function walk(dir: string): void {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.ts$/.test(entry.name) || entry.name.endsWith('.test.ts')) continue
      out.push(full)
    }
  }
  for (const dir of scanDirs) walk(dir)
  return out
}

describe('delivery-live exists (layer + package) and exports a DeliveryPort factory', () => {
  it('both scan locations exist', () => {
    for (const dir of scanDirs) expect(existsSync(dir), `expected ${dir} to exist`).toBe(true)
  })

  it('a file exports createLiveDeliveryPort', () => {
    const hit = moduleFiles().find((f) => /export\s+(async\s+)?function\s+createLiveDeliveryPort\b/.test(readFileSync(f, 'utf8')))
    expect(hit, `no exported createLiveDeliveryPort found under ${scanDirs.join(' or ')}`).toBeDefined()
  })

  it('deliveryPortFor("live", driver) returns a working port instead of throwing (port.ts\'s own documented seam)', async () => {
    const { deliveryPortFor } = await import('@kestrel/delivery-static')
    const stubDriver = {
      put: async () => {}, delete: async () => {}, exists: async () => false, list: async () => [], publicUrl: (k: string) => k,
    }
    let port: unknown
    expect(() => { port = deliveryPortFor('live', stubDriver as never) }).not.toThrow()
    expect(port).toBeDefined()
    const p = port as { publishSnapshot?: unknown; removeRoutes?: unknown; rebuildAll?: unknown }
    expect(typeof p.publishSnapshot).toBe('function')
    expect(typeof p.removeRoutes).toBe('function')
    expect(typeof p.rebuildAll).toBe('function')
  })
})

describe('delivery-live never reads content tables or the live-render/populate path', () => {
  it('module files that reference the current snapshot import it from the snapshot store, not raw SQL', () => {
    const files = moduleFiles()
    expect(files.length, `no files under ${scanDirs.join(' or ')} to scan`).toBeGreaterThan(0)
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      if (!/\bcurrentSnapshot\b|\bcurrentRoutes\b/.test(text)) continue
      // The snapshot store now lives at `@kestrel/publishing` — a relative `.../snapshots(.ts)`
      // specifier is still accepted for any file that legitimately imports it from inside the package itself.
      const importsFromStore = /import\s*\{[^}]*\b(currentSnapshot|currentRoutes)\b[^}]*\}\s*from\s*['"](?:[^'"]*\/snapshots(?:\.ts)?|@kestrel\/publishing)['"]/.test(text)
      expect(importsFromStore, `${f} references currentSnapshot/currentRoutes but does not import them from the snapshot store`).toBe(true)
    }
  })

  it('no module file imports the live-render/populate producer (render-live) or the content pipeline layer', () => {
    const files = moduleFiles()
    expect(files.length).toBeGreaterThan(0)
    const forbidden = [
      /from\s*['"][^'"]*\/render-live(\.ts)?['"]/,
      /from\s*['"][^'"]*\/pipelines\//,
      /\busePipelineDb\b/,
      /\bdbOf\(/,
    ]
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      const hit = forbidden.find((re) => re.test(text))
      expect(hit, `${f} matched a forbidden live-populate/content-pipeline import: ${hit}`).toBeUndefined()
    }
  })
})
