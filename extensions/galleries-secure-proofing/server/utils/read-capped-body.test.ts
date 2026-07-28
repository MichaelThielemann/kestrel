import { describe, it, expect } from 'vitest'
import { readCappedBody } from './read-capped-body'

/** An async iterable over the given chunks (models a Node request stream). */
async function* streamOf(...chunks: (string | Uint8Array)[]) {
  for (const c of chunks) yield typeof c === 'string' ? Buffer.from(c) : c
}

describe('readCappedBody — bound the buffered request body regardless of content-length', () => {
  it('returns the concatenated body when under the cap', async () => {
    const got = await readCappedBody(streamOf('foo', 'bar'), 1024)
    expect(got?.toString('utf8')).toBe('foobar')
  })

  it('returns an empty buffer for an empty stream', async () => {
    const got = await readCappedBody(streamOf(), 1024)
    expect(got?.length).toBe(0)
  })

  it('accepts a body exactly at the cap (cap is inclusive)', async () => {
    const got = await readCappedBody(streamOf('x'.repeat(10)), 10)
    expect(got?.toString('utf8')).toBe('x'.repeat(10))
  })

  it('returns null once the body exceeds the cap — a chunked flood cannot balloon memory', async () => {
    expect(await readCappedBody(streamOf('x'.repeat(11)), 10)).toBeNull()
    // exceeded partway through: must not return a partial body
    expect(await readCappedBody(streamOf('xxxxx', 'xxxxx', 'xxxxx'), 10)).toBeNull()
  })

  it('stops reading the stream as soon as the cap is exceeded (does not drain the rest)', async () => {
    let pulled = 0
    async function* counting() {
      for (let i = 0; i < 100; i++) { pulled++; yield Buffer.from('xxxxx') } // 5 bytes each
    }
    expect(await readCappedBody(counting(), 10)).toBeNull()
    expect(pulled).toBeLessThan(5) // bailed out near the cap, not after all 100 chunks
  })
})
