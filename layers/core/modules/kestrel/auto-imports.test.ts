import { describe, expect, it } from 'vitest'
import { appAutoImports, serverAutoImports } from './auto-imports'

describe('kestrel auto-imports', () => {
  it('covers the authoring API a 3.x site used unimported', async () => {
    const server = (await serverAutoImports()).map((e) => e.name)
    for (const name of ['defineCollection', 'getCollection', 'useDb', 'definePipeline', 'defineFieldType', 'registerAccessGrant', 'publishFull']) {
      expect(server, `server auto-imports lack ${name}`).toContain(name)
    }
    expect((await appAutoImports()).map((e) => e.name)).toContain('defineBlock')
  })

  it('registers every name once per context, from a package that really exports it', async () => {
    const server = await serverAutoImports()
    const app = await appAutoImports()
    for (const entries of [server, app]) {
      const names = entries.map((e) => e.name)
      expect(new Set(names).size).toBe(names.length)
      expect(names).not.toContain('default')
      expect(names).not.toContain('kestrelDiscovery')
      expect(names).not.toContain('renderRouteLive')
    }
    for (const { name, from } of [...server, ...app]) {
      const mod = (await import(from)) as Record<string, unknown>
      expect(name in mod, `${from} does not export ${name}`).toBe(true)
    }
  })
})
