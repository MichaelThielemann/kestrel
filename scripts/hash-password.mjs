import { createInterface } from 'node:readline'
import { hashPassword } from './lib/password.mjs'

// Not used at runtime: this prints a value an operator pastes into KESTREL_ADMIN_PASSWORD_HASH. Kept as a
// standalone entry point because docs/consuming-kestrel.md tells consumers to run it straight out of
// node_modules, which must keep working whether or not the `kestrel` bin is on PATH.
const arg = process.argv[2]
if (arg) {
  process.stdout.write(hashPassword(arg) + '\n')
} else {
  const rl = createInterface({ input: process.stdin, terminal: false })
  process.stderr.write('Enter password, then press Enter:\n')
  rl.on('line', (line) => {
    process.stdout.write(hashPassword(line) + '\n')
    rl.close()
  })
}
