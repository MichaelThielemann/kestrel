import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { setupPluginOrder, type MinimalNuxt } from './index'
import { resolvePluginOrder } from './plugin-order'

const repo = process.cwd()
const roots = [repo, ...readdirSync(resolve(repo, 'layers')).map((l) => resolve(repo, 'layers', l))]

/** A plain mock — no real Nuxt/Nitro instance — capturing whatever the module registers for each hook, the
 *  same way Nuxt itself would invoke it. */
function mockNuxt(): {
  nuxt: MinimalNuxt
  fireNitroConfig: (nitro: { plugins?: (string | undefined)[] }) => void
  fireNitroInit: (nitro: { options: { plugins: (string | undefined)[] } }) => void
} {
  let onConfig: ((nitro: { plugins?: (string | undefined)[] }) => void) | undefined
  let onInit: ((nitro: { options: { plugins: (string | undefined)[] } }) => void) | undefined
  const nuxt = {
    options: { _layers: roots.map((cwd) => ({ cwd })) },
    hook: ((name: string, fn: unknown) => {
      if (name === 'nitro:config') onConfig = fn as typeof onConfig
      if (name === 'nitro:init') onInit = fn as typeof onInit
    }) as MinimalNuxt['hook'],
  }
  return {
    nuxt,
    fireNitroConfig: (nitro) => onConfig!(nitro),
    fireNitroInit: (nitro) => onInit!(nitro),
  }
}

describe('setupPluginOrder — declared order ≡ effective order', () => {
  it('pushes PLUGIN_ORDER\'s resolved paths into nitro.plugins, in EXACT declared order, on an empty list', () => {
    const { nuxt, fireNitroConfig } = mockNuxt()
    setupPluginOrder(nuxt)
    const nitro: { plugins?: string[] } = {}
    fireNitroConfig(nitro)
    expect(nitro.plugins).toEqual(resolvePluginOrder(roots))
  })

  it('does not clobber an existing nitro.plugins array — appends after whatever is already there', () => {
    const { nuxt, fireNitroConfig } = mockNuxt()
    setupPluginOrder(nuxt)
    const nitro: { plugins?: string[] } = { plugins: ['/some/other/plugin.ts'] }
    fireNitroConfig(nitro)
    expect(nitro.plugins!.slice(0, 1)).toEqual(['/some/other/plugin.ts'])
    expect(nitro.plugins!.slice(1)).toEqual(resolvePluginOrder(roots))
  })

  it('validates (and would throw) BEFORE the nitro:config hook is even registered — a drifted repo fails setup(), not boot', () => {
    // setupPluginOrder itself calls validatePluginOrder(roots) synchronously against the REAL repo before
    // touching nuxt.hook at all — proven simply by this call not throwing against the real, undrifted tree
    // (the drift-throws case is covered directly in plugin-order.test.ts's own mutant tests).
    const { nuxt } = mockNuxt()
    expect(() => setupPluginOrder(nuxt)).not.toThrow()
  })

  it('the nitro:init hook does not throw when our block is a contiguous run AFTER a consumer/devtools plugin (real nuxt dev shape)', () => {
    // Real `nuxt dev` boots push @nuxt/devtools'/@nuxt/nitro-server's own internal plugins ahead of
    // everything via their own earlier nitro:config hooks — legitimate, not drift. "Prefix" would be the
    // wrong bar here; "one unbroken run" is what this proves tolerates it.
    const { nuxt, fireNitroInit } = mockNuxt()
    setupPluginOrder(nuxt)
    const withDevtoolsAhead = ['/nuxt/devtools/inline.ts', '/nuxt/nitro-server/dev-server-logs.ts', ...resolvePluginOrder(roots)]
    expect(() => fireNitroInit({ options: { plugins: withDevtoolsAhead } })).not.toThrow()
  })

  it('the nitro:init hook does not throw when a consumer/extension plugin is appended AFTER our block', () => {
    const { nuxt, fireNitroInit } = mockNuxt()
    setupPluginOrder(nuxt)
    expect(() => fireNitroInit({ options: { plugins: [...resolvePluginOrder(roots), '/consumer/own-plugin.ts'] } })).not.toThrow()
  })

  it('the nitro:init hook THROWS when something splits our declared block apart (interleaves INSIDE it)', () => {
    const { nuxt, fireNitroInit } = mockNuxt()
    setupPluginOrder(nuxt)
    const resolved = resolvePluginOrder(roots)
    const midpoint = Math.floor(resolved.length / 2)
    const tampered = [...resolved.slice(0, midpoint), '/sneaky/interloper.ts', ...resolved.slice(midpoint)]
    expect(() => fireNitroInit({ options: { plugins: tampered } })).toThrow(/does not contain PLUGIN_ORDER as one unbroken/i)
  })

  it('the nitro:init hook THROWS when the final array contains a duplicate of one of our own entries', () => {
    const { nuxt, fireNitroInit } = mockNuxt()
    setupPluginOrder(nuxt)
    const resolved = resolvePluginOrder(roots)
    const tampered = [...resolved, resolved[0]]
    expect(() => fireNitroInit({ options: { plugins: tampered } })).toThrow(/duplicate/i)
  })
})
