import { describe, it, expect } from 'vitest'
import { withLock, mediaLockKey } from '../../../src/server/utils/key-lock.js'

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('withLock', () => {
  it('serializes same-key tasks FIFO; interleaving is impossible', async () => {
    const log: string[] = []
    const task = (id: string, ms: number) => () => (async () => { log.push(`${id}:start`); await tick(ms); log.push(`${id}:end`) })()
    // B is enqueued after A; even though B is faster, it must wait for A to finish.
    const a = withLock('k', task('A', 30))
    const b = withLock('k', task('B', 1))
    await Promise.all([a, b])
    expect(log).toEqual(['A:start', 'A:end', 'B:start', 'B:end'])
  })

  it('runs different keys concurrently', async () => {
    const log: string[] = []
    const task = (id: string, ms: number) => () => (async () => { log.push(`${id}:start`); await tick(ms); log.push(`${id}:end`) })()
    await Promise.all([withLock('x', task('X', 20)), withLock('y', task('Y', 1))])
    // Y finishes before X because they don't share a key.
    expect(log).toEqual(['X:start', 'Y:start', 'Y:end', 'X:end'])
  })

  it('a failing task does not block the next same-key task', async () => {
    const a = withLock('k', async () => { throw new Error('boom') })
    const b = withLock('k', async () => 'ok')
    await expect(a).rejects.toThrow('boom')
    await expect(b).resolves.toBe('ok')
  })

  it('returns the task result unchanged', async () => {
    await expect(withLock('k', async () => 42)).resolves.toBe(42)
  })
})

describe('mediaLockKey', () => {
  it('keys on the exact storage key: same object serializes, different objects are concurrent', () => {
    expect(mediaLockKey('pics/a.png')).toBe('media:pics/a.png')
    expect(mediaLockKey('/pics/a.png')).toBe('media:pics/a.png') // leading slash normalized → same key
    expect(mediaLockKey('pics/a.png')).not.toBe(mediaLockKey('pics/b.png'))
  })
})
