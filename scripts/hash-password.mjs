import { scryptSync, randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'

const N = 2 ** 17
const r = 8
const p = 1
const KEYLEN = 64
const MAXMEM = 256 * 1024 * 1024

function make(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEYLEN, { N, r, p, maxmem: MAXMEM })
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

const arg = process.argv[2]
if (arg) {
  process.stdout.write(make(arg) + '\n')
} else {
  const rl = createInterface({ input: process.stdin, terminal: false })
  process.stderr.write('Enter password, then press Enter:\n')
  rl.on('line', (line) => {
    process.stdout.write(make(line) + '\n')
    rl.close()
  })
}
