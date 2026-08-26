// The ONLY real package-consumption test. Every earlier gate (api:check, pkg:lint) inspects one
// package's own tarball in isolation; this script is the one that scaffolds an actual consumer from
// templates/starter (via create-kestrel's real CLI), packs the engine + every @michaelthielemann/kestrel-* package the way
// `npm publish` would, installs them into that consumer with a real `npm install` (no workspace protocol,
// no symlinks back into this repo), builds it, boots the production server, and hits it over real HTTP.
//
// Local: `pnpm ci:consumer-template`. CI: the `consumer-template` job in .github/workflows/ci.yml.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const root = process.cwd()
const log = (msg) => console.log(`[consumer-template-ci] ${msg}`)
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts })

// @michaelthielemann/kestrel-* in the order `pnpm --filter "@michaelthielemann/kestrel-*" -r exec` resolves them (a real topological walk of
// the workspace graph, not a hand guess) — mirrors the publish order in .github/workflows/release.yml.
const PACKAGES = ['contracts', 'core', 'auth', 'access', 'fields', 'collections', 'media', 'publishing', 'delivery-live', 'delivery-static']

const work = mkdtempSync(join(tmpdir(), 'kestrel-consumer-ci-'))
const tarballDir = join(work, 'tarballs')
const consumerDir = join(work, 'site')
mkdirSync(tarballDir, { recursive: true })
log(`work dir: ${work}`)

let server
try {
  log('building @michaelthielemann/kestrel-* packages (dist/ must exist before pnpm pack)')
  run('pnpm', ['--filter', '@michaelthielemann/kestrel-*', '-r', 'build'], { cwd: root })

  log('packing the engine + every @michaelthielemann/kestrel-* package as npm publish would')
  const tarball = {}
  for (const dir of ['.', ...PACKAGES.map((n) => `packages/kestrel-${n}`)]) {
    const out = execFileSync('pnpm', ['pack', '--pack-destination', tarballDir], { cwd: join(root, dir) }).toString().trim()
    const file = out.split('\n').pop().trim()
    const name = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')).name
    tarball[name] = file
    log(`  ${name} -> ${file}`)
  }

  log('scaffolding a consumer from templates/starter via the real create-kestrel CLI')
  const password = 'consumer-ci-password'
  run('node', [join(root, 'packages/create-kestrel/index.mjs'), consumerDir, '--yes', '--password', password], { cwd: work })

  log('pointing the scaffolded package.json at the packed tarballs (no registry, no workspace protocol)')
  const pkgPath = join(consumerDir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.dependencies['@michaelthielemann/kestrel'] = `file:${tarball['@michaelthielemann/kestrel']}`
  // npm's `overrides` redirects a dependency AT ANY DEPTH — the engine tarball's own manifest declares
  // "@michaelthielemann/kestrel-core": "0.1.0" etc. (pnpm pack already rewrote the workspace:* protocol to that real
  // version), which would otherwise 404 against the real registry since these packages are not published
  // yet in this checkout's tag. This is what actually forces npm's resolver to read each package's real
  // `exports` map / `main` / `types` from a standalone tarball, the same way a real end user's install
  // would — not a symlink into this repo's own packages/*/src.
  pkg.overrides = Object.fromEntries(PACKAGES.map((n) => [`@michaelthielemann/kestrel-${n}`, `file:${tarball[`@michaelthielemann/kestrel-${n}`]}`]))
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

  // The runner's ambient npm (10.9.8 as of this writing) hits a real npm/arborist bug resolving nuxt's
  // large optional-peer set (`TypeError: Cannot read properties of null (reading 'edgesOut')`, inside
  // `#loadPeerSet`) — reproduced directly, unrelated to anything this script does. npm >= 11 does not
  // have it. `npx --yes npm@11` sidesteps needing a global npm upgrade (which needs root the runner may
  // not have) while still using real npm, not pnpm.
  log('npm install (real npm 11 via npx — the most representative simulation of an actual end user)')
  run('npx', ['--yes', 'npm@11', 'install'], { cwd: consumerDir })

  log('verifying no @michaelthielemann/kestrel-* dependency resolved back into this repo (would prove nothing)')
  for (const n of PACKAGES) {
    let resolved = ''
    try {
      resolved = execFileSync('npm', ['ls', `@michaelthielemann/kestrel-${n}`, '--json'], { cwd: consumerDir }).toString()
    } catch (err) {
      // `npm ls` exits non-zero on a peer-dep mismatch warning even when the tree itself resolved fine;
      // its stdout (on the error object) still carries the real tree, which is what matters here.
      resolved = err.stdout?.toString() ?? ''
    }
    if (resolved.includes(root)) throw new Error(`@michaelthielemann/kestrel-${n} resolved into ${root} — the override did not take effect`)
  }

  log('reading the .env create-kestrel wrote (session secret + admin password hash)')
  const env = Object.fromEntries(
    readFileSync(join(consumerDir, '.env'), 'utf8')
      .split('\n')
      .map((l) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(l))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  )
  // KESTREL_SECURE_COOKIES=false is what create-kestrel writes for a brand-new site (local http dev) —
  // the app itself refuses it under a production boot ("KESTREL_SECURE_COOKIES=false is not allowed in
  // production"), which is the correct, secure-by-default behavior, not a bug this script should route
  // around by keeping the flag. Unset it; the production default is secure.
  delete env.KESTREL_SECURE_COOKIES

  const devPort = 41822
  log('nuxt dev (brief boot, then kill) — schema auto-syncs additively at dev boot; a production boot never touches it (by design), so this is what a real `pnpm dev` first run also does')
  const dev = spawn('npx', ['nuxt', 'dev', '--port', String(devPort)], {
    cwd: consumerDir,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  })
  try {
    await waitForServer(`http://localhost:${devPort}/robots.txt`, 60000)
  } finally {
    dev.kill()
    await sleep(1000) // let the dev Nitro process release the sqlite file before the production build reopens it
  }

  log('nuxt build (production) — the real exports-map/deps resolution surface, not a dev-mode shortcut')
  run('npx', ['nuxt', 'build'], { cwd: consumerDir, env: { ...process.env, ...env } })

  log('booting the built server and hitting it over real HTTP')
  const port = 41823
  server = spawn('node', [join(consumerDir, '.output/server/index.mjs')], {
    cwd: consumerDir,
    env: { ...process.env, ...env, PORT: String(port), NITRO_PORT: String(port) },
    stdio: 'inherit',
  })
  await waitForServer(`http://localhost:${port}/robots.txt`, 30000)

  const checks = [
    ['GET /robots.txt', `http://localhost:${port}/robots.txt`, 200],
    ['GET /sitemap.xml', `http://localhost:${port}/sitemap.xml`, 200],
    ['GET /admin (login page, SPA shell)', `http://localhost:${port}/admin`, 200],
  ]
  for (const [label, url, wantStatus] of checks) {
    const res = await fetch(url)
    if (res.status !== wantStatus) throw new Error(`${label} -> ${res.status}, expected ${wantStatus}`)
    log(`  ${label} -> ${res.status} OK`)
  }

  const loginRes = await fetch(`http://localhost:${port}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  if (loginRes.status !== 200) throw new Error(`POST /api/login -> ${loginRes.status}, expected 200 (the packed admin auth stack did not resolve)`)
  log('  POST /api/login -> 200 OK (the packed @michaelthielemann/kestrel-auth + @michaelthielemann/kestrel-access stack authenticates for real)')

  log('PASS — a real npm install of the packed engine + packages boots and serves under production, and login round-trips through the packed auth stack.')
} finally {
  server?.kill()
  if (!process.env.KEEP_CONSUMER_TEMPLATE_CI_WORKDIR) rmSync(work, { recursive: true, force: true })
  else log(`KEEP_CONSUMER_TEMPLATE_CI_WORKDIR set — leaving ${work} in place`)
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(url)
      if (res.status) return
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not come up at ${url} within ${timeoutMs}ms`)
    await sleep(250)
  }
}
