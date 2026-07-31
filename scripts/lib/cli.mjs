import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

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

/**
 * Reads a line with the echo suppressed. readline echoes before we see the data event, so the fix is to
 * repaint the prompt over whatever was written — unconditionally, because a pasted secret arrives as one
 * chunk that ends in a newline and would otherwise be left on screen and in the scrollback.
 */
async function askHidden(rl, question) {
  const repaint = () => process.stdout.write(`\u001b[2K\u001b[200D${question}`)
  process.stdin.on('data', repaint)
  try {
    return (await rl.question(question)).trim()
  } finally {
    process.stdin.off('data', repaint)
    repaint()
    process.stdout.write('\n')
  }
}

export class Cancelled extends Error {}

/** Throws `Cancelled` on Ctrl-C / Ctrl-D so a caller can exit cleanly instead of on an AbortError stack. */
export async function promptPassword(rl, { warn = out } = {}) {
  for (;;) {
    let first
    try {
      first = await askHidden(rl, 'Admin password: ')
      if (first.length < MIN_PASSWORD_LENGTH) {
        warn(`  at least ${MIN_PASSWORD_LENGTH} characters, please`)
        continue
      }
      if (first !== (await askHidden(rl, 'Repeat password: '))) {
        warn('  the two entries differ — try again')
        continue
      }
    } catch (err) {
      throw err?.code === 'ABORT_ERR' ? new Cancelled() : err
    }
    if (first === undefined) throw new Cancelled()
    return first
  }
}

/** All of stdin as a string; `''` at EOF, which the callers turn into a clean error. */
export async function readStdin() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text.split('\n')[0].trim()
}
