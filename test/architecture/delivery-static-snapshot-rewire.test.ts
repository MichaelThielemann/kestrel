import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Contract tests for delivery-static against snapshots. `publisher.ts`'s render/output implementation
 * internals were not read beyond exported signatures/TSDocs; its own header comment documents today's
 * behavior as rendering "the LIVE server", which is exactly the fact this suite's A point pins against.
 * Every point marked DESIGN is a surface this suite invents where the contract leaves it open (mirrors
 * published-snapshots.test.ts's own stance); every point marked AMBIGUITY is flagged, not silently resolved.
 *
 * AMBIGUITY — file layout. Whether `publisher.ts` moves into a `delivery-static/` module or is rewired in
 * place is open. Point A below is written to survive either: it locates the entrypoint by its EXPORTED
 * function name (`renderRoute`), not by a fixed file path.
 *
 * AMBIGUITY — no store-level "retract" write function. `snapshots.ts` exports `recordSnapshot` /
 * `republishSnapshot` / `currentSnapshot` / `currentRoutes` — there is no exported function that demotes a
 * route's current snapshot to "no current snapshot" (the shape retraction/unpublish needs). Point D below
 * pins the OBSERVABLE contract (after a real unpublish + republish, the route has no current snapshot and no
 * static output file) without assuming a specific store function name — if the implementer adds one, that is
 * additive and does not conflict with this suite.
 *
 * DESIGN — the real "generate" entrypoint reachable from a test without a full external `nuxt generate`
 * build is the `publish:run` Nitro task (`layers/public/server/tasks/publish/run.ts`, its own TSDoc: "the
 * dev-only task route; plumbing smoke test"). The e2e half of this suite
 * (`test/e2e/delivery-static-snapshot-parity.test.ts`) drives that task, not a child-process `nuxt generate` —
 * flagged there in more detail, including why a byte-compare against a committed pre-split baseline could not
 * be captured by this pass.
 */

const root = process.cwd()

describe('the static route-render entrypoint reads through the snapshot store', () => {
  function publishingModuleFiles(): string[] {
    const base = resolve(root, 'packages/kestrel-delivery-static/src')
    const out: string[] = []
    function walk(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name)
        if (entry.isDirectory()) { walk(full); continue }
        if (!/\.ts$/.test(entry.name) || entry.name.endsWith('.test.ts')) continue
        out.push(full)
      }
    }
    walk(base)
    return out
  }

  it('a file in the publishing module exports renderRoute (the static per-route render entrypoint)', () => {
    const hit = publishingModuleFiles().find((f) => /export\s+(async\s+)?function\s+renderRoute\b/.test(readFileSync(f, 'utf8')))
    expect(hit, 'no exported renderRoute found under layers/public/server/** — has it been renamed/moved?').toBeDefined()
  })

  it('that file imports currentSnapshot (or currentRoutes) from the snapshot store — RED until the rewire lands', () => {
    const files = publishingModuleFiles()
    const hit = files.find((f) => /export\s+(async\s+)?function\s+renderRoute\b/.test(readFileSync(f, 'utf8')))
    expect(hit).toBeDefined()
    const text = readFileSync(hit!, 'utf8')
    // The snapshot store now lives at `@kestrel/publishing` — a relative `.../snapshots(.ts)`
    // specifier is still accepted for any file that legitimately imports it from inside the package itself.
    const importsSnapshotRead = /import\s*\{[^}]*\b(currentSnapshot|currentRoutes)\b[^}]*\}\s*from\s*['"](?:[^'"]*\/snapshots(?:\.ts)?|@kestrel\/publishing)['"]/.test(text)
    expect(importsSnapshotRead, `${hit} must import currentSnapshot/currentRoutes from the snapshot store — the static render path may not read the live populate/render path directly`).toBe(true)
  })

  it("that file's own render call no longer names the live-render primitives (useNitroApp/localFetch) — today's documented behavior, must flip post-rewire", () => {
    const files = publishingModuleFiles()
    const hit = files.find((f) => /export\s+(async\s+)?function\s+renderRoute\b/.test(readFileSync(f, 'utf8')))
    expect(hit).toBeDefined()
    const text = readFileSync(hit!, 'utf8')
    expect(text.includes('useNitroApp') || text.includes('localFetch'), `${hit} still renders via the live Nitro app — the rewire should read published_snapshots instead`).toBe(false)
  })
})

describe("kestrel.config's delivery option (default 'static', normalized by resolveKestrel)", () => {
  it("resolveKestrel defaults delivery to 'static' when unset", async () => {
    const { resolveKestrel } = await import('@kestrel/core')
    const resolved = resolveKestrel({}, {}, '/root') as unknown as { delivery?: string }
    expect(resolved.delivery).toBe('static')
  })

  it("resolveKestrel honors an explicit config value ('live')", async () => {
    const { resolveKestrel } = await import('@kestrel/core')
    const resolved = resolveKestrel({ delivery: 'live' } as never, {}, '/root') as unknown as { delivery?: string }
    expect(resolved.delivery).toBe('live')
  })

  it('KESTREL_DELIVERY env overrides config, mirroring every other resolveKestrel setting (env → config → default)', async () => {
    const { resolveKestrel } = await import('@kestrel/core')
    const resolved = resolveKestrel({ delivery: 'static' } as never, { KESTREL_DELIVERY: 'live' }, '/root') as unknown as { delivery?: string }
    expect(resolved.delivery).toBe('live')
  })

  it('an invalid delivery value fails safe — either falls back to the default or throws, never passes through unnormalized', async () => {
    const { resolveKestrel } = await import('@kestrel/core')
    let result: { delivery?: string } | undefined
    let threw = false
    try {
      result = resolveKestrel({ delivery: 'edge-worker' } as never, {}, '/root') as unknown as { delivery?: string }
    } catch {
      threw = true
    }
    if (!threw) {
      expect(result!.delivery === 'static' || result!.delivery === 'live').toBe(true)
    }
  })
})
