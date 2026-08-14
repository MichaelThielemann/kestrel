import { describe, it, expect } from 'vitest'
import type { StorageDriver } from '../../../../core/server/utils/storage'
import { patternToRegexSource } from './redirect-rules'
import { REDIRECTS_KEY, writeRedirectsArtifact } from './redirects-artifact'

function fakeDriver(fail?: Error) {
  const puts: Array<{ key: string; body: string; contentType: string; cacheControl?: string }> = []
  return {
    puts,
    async put(key: string, bytes: Buffer, contentType: string, opts?: { cacheControl?: string }) {
      if (fail) throw fail
      puts.push({ key, body: bytes.toString(), contentType, cacheControl: opts?.cacheControl })
    },
    async copy() {},
    async delete() {},
    publicUrl: (key: string) => `/${key}`,
  } as StorageDriver & { puts: Array<{ key: string; body: string; contentType: string; cacheControl?: string }> }
}

describe('writeRedirectsArtifact', () => {
  it('writes the compiled rules to redirects.json at the output root', async () => {
    const driver = fakeDriver()
    await writeRedirectsArtifact([{ from: '/blog/*', to: '/artikel/$1', status: '301' }], driver)
    expect(driver.puts.map((p) => p.key)).toEqual([REDIRECTS_KEY])
    expect(REDIRECTS_KEY).toBe('redirects.json')
    expect(JSON.parse(driver.puts[0]!.body)).toEqual([
      { pattern: patternToRegexSource('/blog/*'), target: '/artikel/$1', status: 301 },
    ])
  })

  it('serves it as JSON and always revalidated — the edge polls it', async () => {
    const driver = fakeDriver()
    await writeRedirectsArtifact([], driver)
    expect(driver.puts[0]!.contentType).toBe('application/json; charset=utf-8')
    expect(driver.puts[0]!.cacheControl).toBe('public, max-age=0, must-revalidate')
  })

  it('writes `[]` for an empty collection rather than skipping the PUT', async () => {
    const driver = fakeDriver()
    await writeRedirectsArtifact([], driver)
    expect(driver.puts.map((p) => p.key)).toEqual([REDIRECTS_KEY])
    expect(driver.puts[0]!.body).toBe('[]')
  })

  it('writes `[]` for an absent field too — a never-saved singleton is zero redirects', async () => {
    const driver = fakeDriver()
    await writeRedirectsArtifact(null, driver)
    expect(driver.puts[0]!.body).toBe('[]')
  })

  it('rejects when the driver rejects — nothing swallows a stale artifact', async () => {
    const driver = fakeDriver(new Error('s3 unreachable'))
    await expect(writeRedirectsArtifact([], driver)).rejects.toThrow('s3 unreachable')
  })

  it('rejects an unpublishable rule before touching the driver', async () => {
    const driver = fakeDriver()
    await expect(writeRedirectsArtifact([{ from: '/a?x=1', to: '/b' }], driver)).rejects.toThrow(/Row 1/)
    expect(driver.puts).toEqual([])
  })
})

describe('the collection contract', () => {
  it('names the collection and its repeater field once, for every consumer of the row', async () => {
    const { REDIRECTS_COLLECTION, REDIRECTS_FIELD } = await import('./redirects-artifact')
    const redirects = (await import('../../collections/redirects')).default
    expect(REDIRECTS_COLLECTION).toBe(redirects.def.name)
    expect(Object.keys(redirects.def.fields)).toContain(REDIRECTS_FIELD)
  })
})
