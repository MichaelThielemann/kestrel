import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  KESTREL_COMPONENT_PREFIX,
  KESTREL_LAYER_PRIORITY,
  KESTREL_OVERRIDE_PRIORITY,
} from '../layers/core/modules/component-namespace/shared'
import { KESTREL_OVERRIDE_DIR } from '../layers/core/modules/component-namespace/index'

// Vitest runs from the package root.
const root = process.cwd()
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8')
const layers = readdirSync(resolve(root, 'layers'))

describe('component namespace', () => {
  it('namespaces every layer that ships components', () => {
    // Nuxt gives the consumer's app dir the highest layer-derived priority, so an un-namespaced layer
    // puts generic names (UiButton, UiIcon, …) back into the consumer's global namespace, where their
    // own design system silently replaces the admin's.
    const shipping = layers.filter((l) => existsSync(resolve(root, `layers/${l}/app/components`)))
    expect(shipping.length).toBeGreaterThan(0)
    for (const layer of shipping) {
      expect(read(`layers/${layer}/nuxt.config.ts`)).toMatch(/kestrelComponents\(import\.meta\.url\)/)
    }
  })

  it('keeps the override seam above the layers, and both above any layer-derived priority', () => {
    expect(KESTREL_OVERRIDE_PRIORITY).toBeGreaterThan(KESTREL_LAYER_PRIORITY)
    // Nuxt derives `layerCount - i`; the floor keeps headroom for a deep consumer layer stack.
    expect(KESTREL_LAYER_PRIORITY).toBeGreaterThan(20)
  })

  it('keeps the override directory ending in `components`', () => {
    // Nuxt reports a missing registered dir (NUXT_B3001) unless the path matches its default-components
    // pattern. Without the suffix, every consumer who never uses the seam gets a build warning.
    expect(KESTREL_OVERRIDE_DIR).toMatch(/(^|\/)components$/)
    expect(read('layers/core/nuxt.config.ts')).toMatch(/component-namespace\/index\.ts/)
  })

  it('imports only namespaced components from #components inside the engine', () => {
    // A plugin's script context has no auto-imports, so it names the component explicitly — the one place
    // a stale bare name survives a template-level rename.
    for (const file of walk(resolve(root, 'layers'))) {
      for (const m of read(file).matchAll(/import\s+\{([^}]+)\}\s+from\s+'#components'/g)) {
        for (const binding of m[1]!.split(',').map((s) => s.trim().split(/\s+as\s+/)[0]!.trim()).filter(Boolean)) {
          expect(binding, `${file} imports ${binding} from #components`).toMatch(
            new RegExp(`^${KESTREL_COMPONENT_PREFIX}`),
          )
        }
      }
    }
  })
})

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) walk(path, acc)
    else if (path.endsWith('.ts') || path.endsWith('.vue')) acc.push(path)
  }
  return acc
}
