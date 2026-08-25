import { createInterface } from 'node:readline'
import { hashPassword } from './lib/password.mjs'
import { Cancelled, promptPassword } from './lib/cli.mjs'

// Not used at runtime: this prints a value an operator pastes into KESTREL_ADMIN_PASSWORD_HASH. Kept as a
// standalone entry point because docs/guide/getting-started.md tells consumers to run it straight out of
// node_modules, which must keep working whether or not the `kestrel` bin is on PATH.
const arg = process.argv[2]
if (arg) {
  process.stdout.write(hashPassword(arg) + '\n')
} else if (process.stdin.isTTY) {
  // Only the hash may reach stdout — an operator pipes it straight into a secret store.
  try {
    process.stdout.write(hashPassword(await promptPassword({ output: process.stderr })) + '\n')
  } catch (err) {
    if (!(err instanceof Cancelled)) throw err
    process.stderr.write('cancelled\n')
    process.exitCode = 1
  }
} else {
  // `terminal: false` keeps the piped form (`echo pw | node hash-password.mjs`) working; it is only safe
  // because stdin is not a tty here, so there is no line discipline echoing the password onto a screen.
  const rl = createInterface({ input: process.stdin, terminal: false })
  process.stderr.write('Enter password, then press Enter:\n')
  rl.on('line', (line) => {
    process.stdout.write(hashPassword(line) + '\n')
    rl.close()
  })
}
