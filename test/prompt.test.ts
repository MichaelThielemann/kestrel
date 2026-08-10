import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
// @ts-expect-error — plain .mjs script lib, imported explicitly (auto-imports do not reach node tests).
import { Cancelled, MIN_PASSWORD_LENGTH, promptPassword } from '../scripts/lib/cli.mjs'

const BACKSPACE = String.fromCharCode(127)
const CTRL_C = String.fromCharCode(3)
const ESC = String.fromCharCode(27)

/**
 * A fake tty pair. `promptPassword` builds its interface with `terminal: true` regardless of whether the
 * streams are real ttys, which is what makes the line editing (and therefore the echo suppression it
 * depends on) observable here at all. Each line has to be written only once its prompt has been printed —
 * readline drops a second line that arrives in the same chunk, on any implementation.
 */
function harness() {
  const input = new PassThrough()
  const output = new PassThrough()
  const printed: string[] = []
  let waiting: { needle: string; resolve: () => void } | null = null
  output.on('data', (chunk: Buffer) => {
    printed.push(chunk.toString('binary'))
    if (waiting && chunk.toString('binary').includes(waiting.needle)) {
      const w = waiting
      waiting = null
      w.resolve()
    }
  })
  const warned: string[] = []
  const noted: string[] = []
  const start = () => promptPassword({ input, output, warn: (m: string) => warned.push(m), note: (m: string) => noted.push(m) })
  const awaitPrompt = (needle: string) =>
    new Promise<void>((resolve) => {
      if (printed.some((s) => s.includes(needle))) return resolve()
      waiting = { needle, resolve }
    })
  return {
    input,
    printed,
    warned,
    noted,
    start,
    awaitPrompt,
    get text() {
      return printed.join('')
    },
  }
}

describe('promptPassword', () => {
  it('prints each prompt once and never lets the secret reach the terminal', async () => {
    const h = harness()
    const done = h.start()
    await h.awaitPrompt('New admin password: ')
    h.input.write('hunter2hunter2\n')
    await h.awaitPrompt('Repeat password: ')
    h.input.write('hunter2hunter2\n')

    expect(await done).toBe('hunter2hunter2')
    // The whole transcript, byte for byte: one prompt each, no echo, and no cursor games to erase one.
    expect(h.text).toBe('New admin password: \nRepeat password: \n')
    expect(h.text).not.toContain('hunter2')
    expect(h.text).not.toContain(ESC)
  })

  it('says up front that a password is being chosen, what it unlocks and how short is too short', async () => {
    const h = harness()
    const done = h.start()
    await h.awaitPrompt('New admin password: ')
    h.input.write('hunter2hunter2\n')
    await h.awaitPrompt('Repeat password: ')
    h.input.write('hunter2hunter2\n')
    await done

    expect(h.noted).toHaveLength(1)
    expect(h.noted[0]).toMatch(/choose/i)
    expect(h.noted[0]).toContain('/admin')
    expect(h.noted[0]).toContain(String(MIN_PASSWORD_LENGTH))
  })

  it('applies line editing without echoing it', async () => {
    const h = harness()
    const done = h.start()
    await h.awaitPrompt('New admin password: ')
    h.input.write('hunter2hunterX')
    h.input.write(BACKSPACE)
    h.input.write('2\n')
    await h.awaitPrompt('Repeat password: ')
    h.input.write('hunter2hunter2\n')

    expect(await done).toBe('hunter2hunter2')
    expect(h.text).toBe('New admin password: \nRepeat password: \n')
  })

  it('re-asks on a mismatch', async () => {
    const h = harness()
    const done = h.start()
    await h.awaitPrompt('New admin password: ')
    h.input.write('hunter2hunter2\n')
    await h.awaitPrompt('Repeat password: ')
    h.input.write('something-else\n')

    // The second round reprints the pair; `awaitPrompt` is already satisfied, so count writes instead.
    const secondAsk = new Promise<void>((resolve) => {
      const tick = () => (h.printed.filter((s) => s === 'New admin password: ').length > 1 ? resolve() : setTimeout(tick, 5))
      tick()
    })
    await secondAsk
    h.input.write('hunter2hunter2\n')
    await new Promise((r) => setTimeout(r, 20))
    h.input.write('hunter2hunter2\n')

    expect(await done).toBe('hunter2hunter2')
    expect(h.warned.join(' ')).toContain('differ')
    expect(h.noted).toHaveLength(1)
  })

  it('re-asks on a too-short entry', async () => {
    const h = harness()
    const done = h.start()
    await h.awaitPrompt('New admin password: ')
    h.input.write('short\n')

    const secondAsk = new Promise<void>((resolve) => {
      const tick = () => (h.printed.filter((s) => s === 'New admin password: ').length > 1 ? resolve() : setTimeout(tick, 5))
      tick()
    })
    await secondAsk
    h.input.write('hunter2hunter2\n')
    await new Promise((r) => setTimeout(r, 20))
    h.input.write('hunter2hunter2\n')

    expect(await done).toBe('hunter2hunter2')
    expect(h.warned.join(' ')).toContain(String(MIN_PASSWORD_LENGTH))
    // A too-short first entry must not be repeated back either.
    expect(h.text).not.toContain('short\n')
  })

  it('maps Ctrl-C to Cancelled rather than an AbortError stack', async () => {
    const h = harness()
    const done = h.start()
    await h.awaitPrompt('New admin password: ')
    h.input.write(CTRL_C)

    await expect(done).rejects.toBeInstanceOf(Cancelled)
  })
})
