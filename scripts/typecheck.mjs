// Typecheck gate. vitest/esbuild and `nuxt build` do NOT typecheck, so real type errors slip through
// every other gate — this is the one that catches them. It typechecks the PLAYGROUND, which composes
// the engine layers + both galleries extensions + a real consumer app/server, so this single run covers
// app, `.vue`, modules, config AND server code.
//
// Two passes, because Nuxt 4 splits the tsconfig by environment:
//   1. `tsc` over the Nitro server project (the app aggregator EXCLUDES server dirs).
//   2. `vue-tsc` (via `nuxt typecheck`) over the app/`.vue`/modules/config aggregator.
// Both exclude `*.test.ts` (vitest covers those at runtime) via the nuxt.config `typescript.tsConfig.exclude`
// and the derived server config below.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const playground = join(root, 'playground')
const bin = (name) => join(root, 'node_modules', '.bin', name)
const env = { ...process.env, CI: 'true', NUXT_TELEMETRY_DISABLED: '1' }

// 1. (Re)generate the Nuxt/Nitro tsconfigs for the playground.
execFileSync(bin('nuxt'), ['prepare'], { cwd: playground, stdio: 'inherit', env })

// 2. Server (Nitro) project — derive a test-excluding config alongside the generated one so its relative
//    include/paths still resolve.
const generated = join(playground, '.nuxt', 'tsconfig.server.json')
const cfg = JSON.parse(readFileSync(generated, 'utf8'))
cfg.exclude = [...(cfg.exclude ?? []), '../../**/*.test.ts', '../**/*.test.ts']
const gateConfig = join(playground, '.nuxt', 'tsconfig.typecheck.json')
writeFileSync(gateConfig, JSON.stringify(cfg, null, 2))
// Both passes always run, and the gate fails at the END: aborting on the first one hides every error of
// the other, and the two cover disjoint file sets — a red server pass would report zero app errors.
const failed = []
function pass(label, cmd, args) {
  console.log(`› typechecking ${label}…`)
  try {
    execFileSync(bin(cmd), args, { cwd: playground, stdio: 'inherit', env })
  } catch {
    failed.push(label)
  }
}

pass('server (Nitro) project', 'tsc', ['--noEmit', '-p', gateConfig])
// 3. App / `.vue` / modules / config — vue-tsc via `nuxt typecheck` (needs the committed root tsconfig.json).
pass('app + .vue (vue-tsc)', 'nuxt', ['typecheck'])

// 4. Standalone workspace packages have their own tsconfig, outside the playground project. Globbed by
// pnpm's own filter (topological order, every current and future `@michaelthielemann/kestrel-*` package, `create-kestrel`
// excluded by name) rather than a hand-written list per package — the class of drift a hand list invites
// (a package silently missing from this one script) is the exact failure mode this rail exists to avoid.
console.log('› typechecking packages (@michaelthielemann/kestrel-*)…')
try {
  execFileSync('pnpm', ['--filter', '@michaelthielemann/kestrel-*', '-r', 'typecheck'], { cwd: root, stdio: 'inherit', env })
} catch {
  failed.push('packages (@michaelthielemann/kestrel-*)')
}

if (failed.length) {
  console.error(`\n✗ typecheck failed: ${failed.join(', ')}`)
  process.exit(1)
}
console.log('\n✓ typecheck passed (app + .vue + server; *.test.ts excluded)')
