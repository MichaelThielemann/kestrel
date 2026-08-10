import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { createInterface } from 'node:readline/promises'

export const MIN_PASSWORD_LENGTH = 8

/**
 * `booleans` never consume the following token, so `init --force my-site` keeps `my-site` as the target
 * rather than scaffolding over the current directory. `--` ends flag parsing.
 */
export function parseArgs(argv, booleans = []) {
  const isBoolean = new Set(booleans)
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (a === '-h') {
      flags.help = true
      continue
    }
    if (a === '-v') {
      flags.version = true
      continue
    }
    if (!a.startsWith('--')) {
      positional.push(a)
      continue
    }
    const [key, inline] = a.slice(2).split(/=(.*)/s)
    if (inline !== undefined) flags[key] = inline
    else if (!isBoolean.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith('-')) flags[key] = argv[++i]
    else flags[key] = true
  }
  return { flags, positional }
}

export function makePaint(stream = process.stdout) {
  const on = stream.isTTY && !process.env.NO_COLOR
  const wrap = (code) => (s) => (on ? `\u001b[${code}m${s}\u001b[0m` : s)
  return { dim: wrap(2), bold: wrap(1), red: wrap(31), yellow: wrap(33), green: wrap(32) }
}

export const out = (s = '') => process.stdout.write(`${s}\n`)

export const readIf = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null)

/** `mode` is applied even when the file already exists, which `writeFileSync` alone does not do. */
export function write(file, content, mode) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, mode === undefined ? undefined : { mode })
  if (mode !== undefined) chmodSync(file, mode)
}

/** Every file under `dir`, as `/`-separated paths relative to it. */
export function walk(dir, base = dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...walk(full, base))
    else found.push(relative(base, full).split('\\').join('/'))
  }
  return found
}

/** Reads a line the interface is configured never to echo, so the prompt is ours to draw and to close. */
async function askHidden(rl, question, write) {
  write(question)
  try {
    return (await rl.question('')).trim()
  } finally {
    write('\n')
  }
}

export class Cancelled extends Error {}

/**
 * Owns its readline interface, because the two options that keep the secret off the screen can only be
 * set at construction: `output: null` makes readline write nothing at all, and `terminal: true` still
 * gives it the keypress handling (backspace, Ctrl-C, Ctrl-D) that would otherwise fall to the tty's own
 * echoing line discipline. Erasing readline's echo afterwards cannot match that — a pasted secret arrives
 * as one chunk that is echoed AND newlined in a single write, stranding the cleartext on a line no
 * repaint can still reach, and a redirected stdout leaves `terminal` false with nothing to suppress.
 *
 * Throws `Cancelled` on Ctrl-C / Ctrl-D so a caller can exit cleanly instead of on an AbortError stack.
 */
export async function promptPassword({
  input = process.stdin,
  output = process.stdout,
  warn = (m) => output.write(`${m}\n`),
  note = (m) => output.write(`${m}\n`),
} = {}) {
  const draw = (s) => output.write(s)
  const rl = createInterface({ input, output: null, terminal: true })
  note(`Choose a password for /admin — at least ${MIN_PASSWORD_LENGTH} characters, kept only as a scrypt hash.`)
  try {
    for (;;) {
      let first
      try {
        first = await askHidden(rl, 'New admin password: ', draw)
        if (first.length < MIN_PASSWORD_LENGTH) {
          warn(`  too short — at least ${MIN_PASSWORD_LENGTH} characters`)
          continue
        }
        if (first !== (await askHidden(rl, 'Repeat password: ', draw))) {
          warn('  the two entries differ — try again')
          continue
        }
      } catch (err) {
        throw err?.code === 'ABORT_ERR' ? new Cancelled() : err
      }
      if (first === undefined) throw new Cancelled()
      return first
    }
  } finally {
    rl.close()
  }
}

/** All of stdin as a string; `''` at EOF, which the callers turn into a clean error. */
export async function readStdin() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text.split('\n')[0].trim()
}
