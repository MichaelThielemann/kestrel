#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve, basename, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashPassword, sessionSecret } from './lib/password.mjs'
import { PACKAGE_NAME, diagnoseProject, mergeEnv, mergePackageJson, renderTemplate, targetName, toPackageName } from './lib/scaffold.mjs'
import { Cancelled, MIN_PASSWORD_LENGTH, makePaint, out, parseArgs, promptPassword, readIf, readStdin, walk, write } from './lib/cli.mjs'

// Node builtins only, no build step: runs the same from a checkout, from node_modules and via `pnpm dlx`.
const PKG_ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const TEMPLATES = join(PKG_ROOT, 'templates')
const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))

const { dim, bold, red, yellow, green } = makePaint()
const fail = (s) => {
  process.stderr.write(`${red('error')} ${s}\n`)
  process.exit(1)
}

const templateVars = (name) => ({
  name,
  version: `^${pkg.version}`,
  nuxtVersion: pkg.dependencies?.nuxt ?? '^4.4.8',
  typescriptVersion: pkg.dependencies?.typescript ?? '^6.0.3',
  vueTscVersion: pkg.devDependencies?.['vue-tsc'] ?? '^3.3.7',
})

function inspect(target) {
  return diagnoseProject({
    packageJson: readIf(join(target, 'package.json')),
    nuxtConfig: readIf(join(target, 'nuxt.config.ts')) ?? readIf(join(target, 'nuxt.config.js')),
    appVue: readIf(join(target, 'app', 'app.vue')) ?? readIf(join(target, 'app.vue')),
    env: readIf(join(target, '.env')),
  })
}

function printFindings(found) {
  for (const d of found) {
    out(`${d.level === 'error' ? red('✖ error') : yellow('▲ warn ')} ${d.message}`)
    out()
  }
}

async function init(positional, flags) {
  const target = resolve(positional[0] ?? '.')
  const templateDir = join(TEMPLATES, 'starter')
  if (!existsSync(templateDir)) fail(`template payload missing at ${templateDir} — reinstall ${PACKAGE_NAME}.`)

  // Validate before touching disk: a half-scaffolded project is worse than a refused one.
  const manifestPath = join(target, 'package.json')
  const existingManifest = readIf(manifestPath)
  if (existingManifest !== null) {
    try {
      JSON.parse(existingManifest)
    } catch {
      fail(`${manifestPath} is not valid JSON — fix it first; refusing to scaffold over a broken manifest.`)
    }
  }

  let password = typeof flags.password === 'string' ? flags.password : undefined
  if (password !== undefined && password.length < MIN_PASSWORD_LENGTH) {
    fail(`--password must be at least ${MIN_PASSWORD_LENGTH} characters (an empty one would leave /admin open).`)
  }

  mkdirSync(target, { recursive: true })
  const projectName = toPackageName(typeof flags.name === 'string' ? flags.name : basename(target))

  out()
  out(`${bold('Kestrel')} ${dim(`v${pkg.version}`)} — setting up ${bold(relative(process.cwd(), target) || '.')}`)
  out()

  if (password === undefined && !flags.yes && process.stdin.isTTY) {
    try {
      password = await promptPassword({ warn: (m) => out(yellow(m)), note: (m) => out(dim(m)) })
    } catch (err) {
      if (err instanceof Cancelled) fail('cancelled')
      throw err
    }
    out()
  }

  const vars = templateVars(projectName)
  const created = []
  const kept = []
  const merged = []

  for (const rel of walk(templateDir).sort()) {
    const name = targetName(rel)
    const dest = join(target, name)
    const body = renderTemplate(readFileSync(join(templateDir, rel), 'utf8'), vars)
    const existing = readIf(dest)

    // A manifest is never overwritten, not even with --force: the caller most likely already ran
    // `pnpm add`, and replacing their dependencies and version is not a scaffold, it is data loss.
    if (name === 'package.json' && existing !== null) {
      const { merged: result, added } = mergePackageJson(JSON.parse(existing), JSON.parse(body))
      if (added.length) {
        write(dest, `${JSON.stringify(result, null, 2)}\n`)
        merged.push(`package.json ${dim(`(+ ${added.join(', ')})`)}`)
      } else kept.push('package.json')
      continue
    }
    if (existing !== null && !flags.force) {
      kept.push(name)
      continue
    }
    write(dest, body)
    created.push(name)
  }

  // Seed from `.env.example` so the generated file keeps its per-key comments.
  const envPath = join(target, '.env')
  const hadEnv = existsSync(envPath)
  const envEntries = { KESTREL_SESSION_SECRET: sessionSecret(), KESTREL_SECURE_COOKIES: 'false' }
  if (password !== undefined) envEntries.KESTREL_ADMIN_PASSWORD_HASH = hashPassword(password)
  const seed = hadEnv ? readFileSync(envPath, 'utf8') : (readIf(join(target, '.env.example')) ?? '')
  const { text, written } = mergeEnv(seed, envEntries)
  if (written.length) {
    write(envPath, text, 0o600)
    ;(hadEnv ? merged : created).push(`.env ${dim(`(${written.join(', ')})`)}`)
  } else kept.push('.env')

  const report = (label, items, paint) => {
    for (const f of items) out(`  ${paint(label)} ${f}`)
  }
  report('created', created, green)
  report('updated', merged, green)
  report('kept   ', kept, dim)

  // Existing files are kept, so init must never report success over a project that still can't serve /admin.
  const remaining = inspect(target)
  if (remaining.length) {
    out()
    out(bold('Still to fix:'))
    out()
    printFindings(remaining)
  }

  out()
  out(bold('Next:'))
  const rel = relative(process.cwd(), target)
  if (rel) out(`  cd ${rel}`)
  out('  pnpm install')
  out('  pnpm dev')
  out()
  out(`  Admin: ${bold('http://localhost:3000/admin')}`)
  out()
  return remaining.some((d) => d.level === 'error') ? 1 : 0
}

function doctor(positional) {
  const target = resolve(positional[0] ?? '.')
  const found = inspect(target)

  out()
  if (!found.length) {
    out(`${green('✔')} ${relative(process.cwd(), target) || '.'} looks like a working Kestrel project.`)
    out()
    return 0
  }
  printFindings(found)
  return found.some((d) => d.level === 'error') ? 1 : 0
}

async function hashPasswordCommand(positional) {
  let password = positional[0]
  if (password === undefined) {
    if (process.stdin.isTTY) {
      // Only the hash may reach stdout — an operator redirects it straight into a secret store.
      const ask = (m) => process.stderr.write(`${m}\n`)
      try {
        password = await promptPassword({ output: process.stderr, warn: (m) => ask(yellow(m)), note: (m) => ask(dim(m)) })
      } catch (err) {
        if (err instanceof Cancelled) fail('cancelled')
        throw err
      }
    } else password = await readStdin()
  }
  if (!password) fail('no password given')
  out(hashPassword(password))
}

function help() {
  out(`
${bold('kestrel')} ${dim(`v${pkg.version}`)}

  ${bold('kestrel init')} [dir]        scaffold a runnable Kestrel project (default: the current directory)
  ${bold('kestrel doctor')} [dir]      check a project for the things that silently break /admin
  ${bold('kestrel hash-password')} [p] print a KESTREL_ADMIN_PASSWORD_HASH value
  ${bold('kestrel secret')}            print a KESTREL_SESSION_SECRET value

${bold('init flags')}
  --name <name>       package name (default: the directory name, slugified)
  --password <pw>     set the admin password without prompting
  --yes               never prompt; leaves KESTREL_ADMIN_PASSWORD_HASH for you to fill in
  --force             overwrite existing files (package.json and .env are always merged, never replaced)

${dim('Existing files are kept and re-running init is safe. To create a NEW project: pnpm create kestrel')}
`)
}

const { flags, positional } = parseArgs(process.argv.slice(2), ['yes', 'force', 'help', 'version'])
const command = positional.shift()

if (flags.version || command === 'version') out(pkg.version)
else if (flags.help || !command || command === 'help') help()
else if (command === 'init') process.exitCode = await init(positional, flags)
else if (command === 'doctor') process.exitCode = doctor(positional)
else if (command === 'hash-password') await hashPasswordCommand(positional)
else if (command === 'secret') out(sessionSecret())
else fail(`unknown command "${command}" — run \`kestrel help\`.`)
