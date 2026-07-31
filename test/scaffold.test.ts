import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import {
  PACKAGE_NAME,
  diagnoseProject,
  mergeEnv,
  mergePackageJson,
  renderTemplate,
  targetName,
  toPackageName,
} from '../scripts/lib/scaffold.mjs'
import { hashPassword, sessionSecret } from '../scripts/lib/password.mjs'
import { parseArgs } from '../scripts/lib/cli.mjs'
import { diagnoseAppShell } from '../layers/core/modules/kestrel/app-shell'

const root = process.cwd()
const templateDir = resolve(root, 'templates', 'starter')

const VARS = { name: 'x', version: '^1.0.0', nuxtVersion: '^4.0.0', typescriptVersion: '^6.0.0', vueTscVersion: '^3.0.0' }

const walk = (dir: string, base = dir): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full, base) : [full.slice(base.length + 1).split('\\').join('/')]
  })

describe('targetName', () => {
  // npm strips a literal `.gitignore` from a tarball AND applies it as an ignore rule, taking its listed
  // siblings with it; `_`-prefixing is the only way a template can ship a dotfile at all.
  it.each([
    ['_gitignore', '.gitignore'],
    ['_env.example', '.env.example'],
    ['_package.json', 'package.json'],
    ['app/app.vue', 'app/app.vue'],
    ['app/blocks/Prose.vue', 'app/blocks/Prose.vue'],
  ])('maps %s to %s', (from, to) => {
    expect(targetName(from)).toBe(to)
  })

  it('only renames the basename, never a directory segment', () => {
    expect(targetName('_gitignore/app/app.vue')).toBe('_gitignore/app/app.vue')
  })
})

describe('parseArgs', () => {
  const BOOLEANS = ['yes', 'force', 'help', 'version']
  const run = (argv: string[]) => parseArgs(argv, BOOLEANS)

  // A boolean flag that swallowed the next token turned `init --force my-site` into "scaffold over the
  // current directory with --force" — the target vanished and someone else's project got overwritten.
  it('does not let a valueless flag consume the target directory', () => {
    expect(run(['init', '--force', 'my-site'])).toEqual({ flags: { force: true }, positional: ['init', 'my-site'] })
  })

  it('still reads a value for a flag that takes one', () => {
    expect(run(['--password', 'secret']).flags.password).toBe('secret')
    expect(run(['--password=secret']).flags.password).toBe('secret')
    expect(run(['--password=']).flags.password).toBe('')
  })

  it('does not read a following flag as a value', () => {
    expect(run(['--name', '--force']).flags).toEqual({ name: true, force: true })
  })

  it('stops parsing at a bare --', () => {
    expect(run(['--yes', '--', '--not-a-flag'])).toEqual({ flags: { yes: true }, positional: ['--not-a-flag'] })
  })

  it('understands the short -h and -v', () => {
    expect(run(['-h']).flags.help).toBe(true)
    expect(run(['-v']).flags.version).toBe(true)
  })
})

describe('renderTemplate', () => {
  it('substitutes known placeholders', () => {
    expect(renderTemplate('name: {{name}} v{{version}}', { name: 'shop', version: '^1.2.3' })).toBe('name: shop v^1.2.3')
  })

  it('leaves an unknown placeholder visible rather than blanking it', () => {
    expect(renderTemplate('{{nope}}', { name: 'x' })).toBe('{{nope}}')
  })
})

describe('toPackageName', () => {
  it.each([
    ['My Site', 'my-site'],
    ['../weird//name', 'weird-name'],
    ['ok-name', 'ok-name'],
    ['!!!', 'kestrel-site'],
  ])('turns %s into %s', (from, to) => {
    expect(toPackageName(from)).toBe(to)
  })
})

describe('mergeEnv', () => {
  it('fills an empty key in place, keeping the comment above it attached', () => {
    const { text, written } = mergeEnv('# the secret\nKESTREL_SESSION_SECRET=\n', { KESTREL_SESSION_SECRET: 'abc' })
    expect(text).toBe('# the secret\nKESTREL_SESSION_SECRET=abc\n')
    expect(written).toEqual(['KESTREL_SESSION_SECRET'])
  })

  // Re-running init must not rotate a live session secret (every signed-in session would drop) or
  // replace a password hash the operator set by hand.
  it('never overwrites a key that already has a value', () => {
    const { text, written } = mergeEnv('KESTREL_SESSION_SECRET=keep-me\n', { KESTREL_SESSION_SECRET: 'new' })
    expect(text).toContain('KESTREL_SESSION_SECRET=keep-me')
    expect(written).toEqual([])
  })

  it('appends a key that is absent entirely', () => {
    const { text, written } = mergeEnv('OTHER=1\n', { KESTREL_ADMIN_PASSWORD_HASH: 'scrypt$x' })
    expect(text).toContain('OTHER=1')
    expect(text).toContain('KESTREL_ADMIN_PASSWORD_HASH=scrypt$x')
    expect(written).toEqual(['KESTREL_ADMIN_PASSWORD_HASH'])
  })

  it('ignores a commented-out key and appends a real one', () => {
    const { text } = mergeEnv('# KESTREL_SESSION_MAX_AGE=604800\n', { KESTREL_SESSION_MAX_AGE: '60' })
    expect(text).toContain('# KESTREL_SESSION_MAX_AGE=604800')
    expect(text).toContain('\nKESTREL_SESSION_MAX_AGE=60')
  })

  it('writes a usable file from nothing', () => {
    expect(mergeEnv('', { A: '1' }).text).toBe('A=1\n')
  })

  it('is idempotent', () => {
    const once = mergeEnv('', { A: '1', B: '2' }).text
    expect(mergeEnv(once, { A: '9', B: '9' }).text).toBe(once)
  })

  // A dotenv loader takes the LAST assignment, so filling the first would leave the file claiming a value
  // the app never reads.
  it('fills the last occurrence of a duplicated key, the one the loader wins with', () => {
    const { text } = mergeEnv('KESTREL_SESSION_SECRET=\nKESTREL_SESSION_SECRET=\n', { KESTREL_SESSION_SECRET: 'v' })
    expect(text).toBe('KESTREL_SESSION_SECRET=\nKESTREL_SESSION_SECRET=v\n')
  })

  it('leaves a duplicated key alone when the LAST one already has a value', () => {
    const { written } = mergeEnv('A=\nA=set\n', { A: 'new' })
    expect(written).toEqual([])
  })
})

describe('mergePackageJson', () => {
  const template = {
    name: '{{name}}',
    scripts: { dev: 'nuxt dev', generate: 'nuxt generate' },
    dependencies: { [PACKAGE_NAME]: '^1.2.1' },
    devDependencies: { nuxt: '^4.4.8' },
  }

  it('adds what is missing without touching what the project already declared', () => {
    const { merged, added } = mergePackageJson(
      { name: 'my-site', scripts: { dev: 'custom' }, dependencies: { [PACKAGE_NAME]: '1.2.1' } },
      template,
    )
    expect(merged.name).toBe('my-site')
    expect(merged.scripts).toEqual({ dev: 'custom', generate: 'nuxt generate' })
    expect(merged.dependencies).toEqual({ [PACKAGE_NAME]: '1.2.1' })
    expect(merged.devDependencies).toEqual({ nuxt: '^4.4.8' })
    expect(added).toEqual(['scripts.generate', 'devDependencies.nuxt'])
  })

  it('reports nothing added when the project is already complete', () => {
    const { added } = mergePackageJson(
      { name: 'mine', scripts: template.scripts, dependencies: template.dependencies, devDependencies: template.devDependencies },
      template,
    )
    expect(added).toEqual([])
  })

  // `type` decides ESM vs CJS for every .js in the project, so it may never arrive unannounced.
  it('reports a top-level key it introduces, and never overrides one that exists', () => {
    const { merged, added } = mergePackageJson({ name: 'mine', type: 'commonjs' }, { ...template, type: 'module', private: true })
    expect(merged.type).toBe('commonjs')
    expect(merged.private).toBe(true)
    expect(added).toContain('private')
    expect(added).not.toContain('type')
  })

  it('leaves a field it knows nothing about untouched', () => {
    const { merged } = mergePackageJson({ name: 'mine', workspaces: ['a'] }, template)
    expect(merged.workspaces).toEqual(['a'])
  })
})

describe('diagnoseProject', () => {
  const ok = {
    packageJson: JSON.stringify({ scripts: { dev: 'nuxt dev' }, dependencies: { [PACKAGE_NAME]: '^1.2.1' }, devDependencies: { nuxt: '^4.4.8' } }),
    nuxtConfig: `export default defineNuxtConfig({ extends: ['${PACKAGE_NAME}'] })`,
    appVue: '<template><NuxtLayout><NuxtPage /></NuxtLayout></template>',
    env: 'KESTREL_SESSION_SECRET=abc\nKESTREL_ADMIN_PASSWORD_HASH=scrypt$x\n',
  }

  it('passes a correctly set-up project', () => {
    expect(diagnoseProject(ok)).toEqual([])
  })

  it('passes a project with no app.vue at all — the layer supplies one', () => {
    expect(diagnoseProject({ ...ok, appVue: null })).toEqual([])
  })

  // The reported starting point: `pnpm add` alone leaves Nuxt with nothing to extend.
  it('errors when nuxt.config.ts is missing entirely', () => {
    const found = diagnoseProject({ ...ok, nuxtConfig: null })
    expect(found).toHaveLength(1)
    expect(found[0].level).toBe('error')
    expect(found[0].message).toContain('nuxt.config.ts')
  })

  it('errors when nuxt.config.ts does not extend Kestrel', () => {
    const found = diagnoseProject({ ...ok, nuxtConfig: 'export default defineNuxtConfig({})' })
    expect(found.map((d) => d.level)).toEqual(['error'])
  })

  // pathe reports extname('../..') as '.', so c12 resolves the layer as a file and every `./layers/*`
  // sub-extend of the meta-layer misses. A single '..' is unaffected.
  it('warns about a relative extends path of two levels or more', () => {
    const found = diagnoseProject({ ...ok, nuxtConfig: `export default defineNuxtConfig({ extends: ['../../${PACKAGE_NAME}'] })` })
    expect(found.map((d) => d.level)).toEqual(['warn'])
  })

  it('errors when nuxt is not a direct dependency', () => {
    const found = diagnoseProject({
      ...ok,
      packageJson: JSON.stringify({ scripts: { dev: 'nuxt dev' }, dependencies: { [PACKAGE_NAME]: '^1.2.1' } }),
    })
    expect(found.map((d) => d.level)).toEqual(['error'])
    expect(found[0].message).toContain('nuxt')
  })

  it('errors on a missing admin password hash and warns on a missing session secret', () => {
    expect(diagnoseProject({ ...ok, env: '' }).map((d) => d.level)).toEqual(['error', 'warn'])
  })

  it('treats an empty assignment as unset', () => {
    const found = diagnoseProject({ ...ok, env: 'KESTREL_ADMIN_PASSWORD_HASH=\nKESTREL_SESSION_SECRET=abc\n' })
    expect(found.map((d) => d.level)).toEqual(['error'])
  })

  it('reports an unparseable manifest instead of treating it as empty', () => {
    const found = diagnoseProject({ ...ok, packageJson: '{ not json' })
    expect(found.some((d) => d.message.includes('not valid JSON'))).toBe(true)
  })

  it('errors for a directory that is not a project at all', () => {
    const found = diagnoseProject({ packageJson: null, nuxtConfig: null, appVue: null, env: null })
    expect(found.every((d) => d.level === 'error')).toBe(true)
    expect(found.length).toBeGreaterThanOrEqual(3)
  })
})

// The CLI cannot import the engine's TypeScript guard (no build step), so the app.vue rule exists twice.
// Pin them against the same fixtures: a divergence means `kestrel doctor` clears a project the build then
// warns about, or the reverse.
describe('doctor and the build-time guard agree on app.vue', () => {
  const fixtures = [
    ['<template><NuxtLayout><NuxtPage /></NuxtLayout></template>', null],
    ['<template><div><NuxtRouteAnnouncer /><NuxtWelcome /></div></template>', 'error'],
    ['<template><NuxtPage /></template>', 'warn'],
    ['<template><!-- <NuxtPage /> --><NuxtWelcome /></template>', 'error'],
    // kebab-case is idiomatic Vue; flagging it would call a working app broken.
    ['<template><nuxt-layout><nuxt-page /></nuxt-layout></template>', null],
    ['<template><nuxt-page /></template>', 'warn'],
  ] as const

  it.each(fixtures)('%s → %s', (src, expected) => {
    const fromGuard = diagnoseAppShell({ mainComponent: '/site/app/app.vue', pagesEnabled: true, read: () => src })
    const fromDoctor = diagnoseProject({
      packageJson: JSON.stringify({ scripts: { dev: 'nuxt dev' }, dependencies: { [PACKAGE_NAME]: '^1' }, devDependencies: { nuxt: '^4' } }),
      nuxtConfig: `extends: ['${PACKAGE_NAME}']`,
      appVue: src,
      env: 'KESTREL_SESSION_SECRET=a\nKESTREL_ADMIN_PASSWORD_HASH=b\n',
    })
    expect(fromGuard[0]?.level ?? null).toBe(expected)
    expect(fromDoctor[0]?.level ?? null).toBe(expected)
  })
})

describe('templates/starter', () => {
  const files = walk(templateDir).sort()

  it('ships the file set a runnable project needs', () => {
    expect(files).toEqual([
      'README.md',
      '_env.example',
      '_gitignore',
      '_package.json',
      'app/app.vue',
      'app/blocks/Prose.vue',
      'app/layouts/default.vue',
      'nuxt.config.ts',
      'pnpm-workspace.yaml',
      'tsconfig.json',
    ])
  })

  // Three separate ways a template file silently disappears: npm strips dotfiles from the tarball, the
  // package `files` whitelist ends in global `!**/*.test.ts` negations, and this repo's own .gitignore
  // patterns are unanchored so they match at any depth.
  it('contains no file npm or git would strip on the way out', () => {
    for (const f of files) {
      expect(f, `${f} would be stripped from the published tarball`).not.toMatch(/(^|\/)\.[^/]+$/)
      expect(f, `${f} matches the files-whitelist test negations`).not.toMatch(/\.test\.ts$/)
    }
  })

  it('renders an app.vue that satisfies the build-time guard', () => {
    const src = readFileSync(join(templateDir, 'app/app.vue'), 'utf8')
    expect(diagnoseAppShell({ mainComponent: 'app/app.vue', pagesEnabled: true, read: () => src })).toEqual([])
  })

  it('extends the published package name, not a relative path', () => {
    const cfg = readFileSync(join(templateDir, 'nuxt.config.ts'), 'utf8')
    expect(cfg).toContain(`extends: ['${PACKAGE_NAME}']`)
  })

  it('declares nuxt directly so the `nuxt` binary resolves under a strict node_modules layout', () => {
    const manifest = JSON.parse(renderTemplate(readFileSync(join(templateDir, '_package.json'), 'utf8'), VARS))
    expect(manifest.dependencies).toHaveProperty(PACKAGE_NAME)
    expect(manifest.scripts.dev).toBe('nuxt dev')
    // `nuxt typecheck` needs both of these present in the project itself.
    for (const dep of ['nuxt', 'typescript', 'vue-tsc']) expect(manifest.devDependencies).toHaveProperty(dep)
  })

  // Verified against pnpm 11.9: `pnpm.onlyBuiltDependencies` in package.json is IGNORED there
  // (ERR_PNPM_IGNORED_BUILDS), so the native deps never build and the scaffolded app cannot start.
  // `allowBuilds:` in pnpm-workspace.yaml is honoured by both pnpm 10 and 11.
  it('pre-approves the native builds in the form current pnpm actually reads', () => {
    const manifest = JSON.parse(renderTemplate(readFileSync(join(templateDir, '_package.json'), 'utf8'), VARS))
    expect(manifest.pnpm, 'pnpm.onlyBuiltDependencies is dead on pnpm 11').toBeUndefined()
    const workspace = readFileSync(join(templateDir, 'pnpm-workspace.yaml'), 'utf8')
    expect(workspace).toMatch(/^allowBuilds:$/m)
    for (const dep of ['better-sqlite3', 'sharp', 'esbuild', '@parcel/watcher']) {
      expect(workspace).toContain(dep)
    }
  })

  it('leaves no unsubstituted placeholder after rendering', () => {
    for (const f of files) {
      const rendered = renderTemplate(readFileSync(join(templateDir, f), 'utf8'), VARS)
      expect(rendered, `${f} has an unknown placeholder`).not.toMatch(/\{\{\w+\}\}/)
    }
  })

  it('gitignores the generated .env but keeps the committed example', () => {
    const ignore = readFileSync(join(templateDir, '_gitignore'), 'utf8')
    expect(ignore).toMatch(/^\.env$/m)
    expect(ignore).toMatch(/^!\.env\.example$/m)
  })
})

describe('password helpers', () => {
  it('produces a hash in the format the auth layer parses', () => {
    expect(hashPassword('correct horse')).toMatch(/^scrypt\$131072\$8\$1\$[\w-]+\$[\w-]+$/)
  })

  it('salts, so the same password never yields the same string twice', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'))
  })

  it('generates a session secret past the 32-byte production minimum', () => {
    expect(Buffer.byteLength(sessionSecret())).toBeGreaterThanOrEqual(32)
  })
})

describe('the CLI entry point', () => {
  it('exists where the bin field points', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { bin?: Record<string, string> }
    const bin = pkg.bin?.kestrel
    expect(bin, 'package.json must expose the `kestrel` bin').toBeDefined()
    expect(existsSync(resolve(root, bin!))).toBe(true)
  })

  it('starts with a shebang so it runs when npm links it', () => {
    expect(readFileSync(resolve(root, 'scripts/kestrel.mjs'), 'utf8').startsWith('#!/usr/bin/env node')).toBe(true)
  })
})

// Drive the real process: everything above tests decisions, this tests that the CLI wires them to disk.
// Scaffolding goes to a tmpdir, never into the repo.
describe('kestrel CLI', () => {
  const cli = resolve(root, 'scripts/kestrel.mjs')
  let dir: string

  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kestrel-cli-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('scaffolds a project doctor then passes', () => {
    const init = run('init', '--password', 'a-good-password')
    expect(init.status, init.stderr).toBe(0)
    for (const f of ['package.json', 'nuxt.config.ts', '.env', '.gitignore', 'app/app.vue']) {
      expect(existsSync(join(dir, f)), `${f} must be created`).toBe(true)
    }
    expect(run('doctor').status).toBe(0)
  })

  it('names the package after the target directory', () => {
    run('init', 'My Shop', '--password', 'a-good-password')
    expect(JSON.parse(readFileSync(join(dir, 'My Shop/package.json'), 'utf8')).name).toBe('my-shop')
  })

  // The name is interpolated into a JSON manifest, so an explicit --name has to be slugified too.
  it('slugifies an explicit --name rather than trusting it', () => {
    expect(run('init', '--name', 'Bad "Name"', '--password', 'a-good-password').status).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name).toBe('bad-name')
  })

  it('leaves sign-in unconfigured — but says so — when run with --yes', () => {
    const init = run('init', '--yes')
    expect(init.status).toBe(1)
    expect(init.stdout).toContain('KESTREL_ADMIN_PASSWORD_HASH')
    expect(readFileSync(join(dir, '.env'), 'utf8')).toMatch(/^KESTREL_SESSION_SECRET=.+$/m)
  })

  // The reported starting point: `pnpm add` ran, nothing else. Re-running init must complete the project
  // rather than refuse or clobber it.
  it('retrofits a project that only ran `pnpm add`', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'existing', private: true, type: 'module', dependencies: { [PACKAGE_NAME]: '^1.2.1' } }),
    )
    expect(run('init', '--password', 'a-good-password').status).toBe(0)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    expect(manifest.name).toBe('existing')
    expect(manifest.devDependencies).toHaveProperty('nuxt')
    expect(manifest.scripts.dev).toBe('nuxt dev')
  })

  // Keeping an existing file is right, but it must not be reported as success: this app.vue is exactly
  // what leaves /admin blank.
  it('keeps a nuxi-init app.vue, reports it, and exits non-zero', () => {
    mkdirSync(join(dir, 'app'), { recursive: true })
    writeFileSync(join(dir, 'app/app.vue'), '<template><NuxtWelcome /></template>')
    const init = run('init', '--password', 'a-good-password')
    expect(init.status).toBe(1)
    expect(init.stdout).toContain('Still to fix')
    expect(init.stdout).toContain('<NuxtPage')
    expect(readFileSync(join(dir, 'app/app.vue'), 'utf8')).toContain('NuxtWelcome')
    // --force is the documented way out, and it must actually resolve the finding.
    expect(run('init', '--force', '--password', 'a-good-password').status).toBe(0)
  })

  it('does not rotate an existing session secret when re-run', () => {
    run('init', '--password', 'a-good-password')
    const before = readFileSync(join(dir, '.env'), 'utf8')
    run('init', '--yes')
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(before)
  })

  it('reports every problem in a directory that is not a Kestrel project', () => {
    const res = run('doctor')
    expect(res.status).toBe(1)
    expect(res.stdout).toContain('nuxt.config.ts')
  })

  it('prints a hash and a secret non-interactively', () => {
    expect(run('hash-password', 'pw').stdout.trim()).toMatch(/^scrypt\$/)
    expect(Buffer.byteLength(run('secret').stdout.trim())).toBeGreaterThanOrEqual(32)
  })

  // An empty --password (an unset $PW in a script) used to be hashed and written, leaving /admin open to
  // a login with no password at all while doctor reported the project healthy.
  it('refuses an empty or too-short --password instead of provisioning an open admin', () => {
    for (const arg of ['--password=', '--password=short']) {
      const res = run('init', arg)
      expect(res.status, arg).toBe(1)
      expect(res.stderr).toContain('at least')
    }
    expect(existsSync(join(dir, '.env'))).toBe(false)
  })

  it('keeps the target directory after a valueless flag', () => {
    expect(run('init', '--force', 'my-site', '--password', 'a-good-password').status).toBe(0)
    expect(existsSync(join(dir, 'my-site/nuxt.config.ts')), 'the target must not be swallowed by --force').toBe(true)
    expect(existsSync(join(dir, 'nuxt.config.ts')), 'the cwd must be left alone').toBe(false)
  })

  // --force may replace template files, but a manifest carries the user's dependencies and version.
  it('never replaces an existing package.json, even with --force', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'mine', version: '9.9.9', dependencies: { lodash: '^4' } }),
    )
    expect(run('init', '--force', '--password', 'a-good-password').status).toBe(0)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    expect(manifest.version).toBe('9.9.9')
    expect(manifest.dependencies.lodash).toBe('^4')
    expect(manifest.dependencies[PACKAGE_NAME]).toBeDefined()
  })

  it('refuses a broken manifest before writing anything', () => {
    writeFileSync(join(dir, 'package.json'), '{ not json')
    const res = run('init', '--password', 'a-good-password')
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('not valid JSON')
    expect(existsSync(join(dir, 'nuxt.config.ts')), 'nothing may be written before the refusal').toBe(false)
  })

  it('writes the .env holding the secrets owner-only', () => {
    run('init', '--password', 'a-good-password')
    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600)
  })

  it('fails loudly on an unknown command', () => {
    const res = run('frobnicate')
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('unknown command')
  })
})
