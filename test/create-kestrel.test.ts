import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const pkgDir = resolve(root, 'packages/create-kestrel')
const enginePkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  version: string
  files: string[]
}

const walk = (dir: string, base = dir): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full, base) : [full.slice(base.length + 1).split('\\').join('/')]
  })

describe('create-kestrel manifest', () => {
  const meta = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as Record<string, never> & {
    name?: string
    version?: string
    bin?: Record<string, string> | string
    files?: string[]
    dependencies?: Record<string, string>
    scripts?: Record<string, string>
    license?: string
    private?: boolean
  }

  it('is the unscoped name `pnpm create kestrel` resolves to', () => {
    expect(meta.name).toBe('create-kestrel')
  })

  it('is publishable under the same licence as the engine', () => {
    expect(meta.private).toBeUndefined()
    expect(meta.license).toBe('Apache-2.0')
  })

  // The tag guard in release.yml only compares the tag against the ROOT manifest, so a separately
  // versioned package would publish unchecked.
  it('is versioned in lockstep with the engine', () => {
    expect(meta.version).toBe(enginePkg.version)
  })

  // The whole point is that it is instant: a dependency on the engine would pull the tree it exists to avoid.
  it('has no dependencies at all', () => {
    expect(meta.dependencies).toBeUndefined()
  })

  it('exposes the `create-kestrel` bin', () => {
    const bin = typeof meta.bin === 'string' ? meta.bin : meta.bin?.['create-kestrel']
    expect(bin).toBeDefined()
    expect(existsSync(join(pkgDir, bin!))).toBe(true)
  })

  it('copies its payload in prepack and cleans up after', () => {
    expect(meta.scripts?.prepack).toBeDefined()
    expect(meta.scripts?.postpack).toBeDefined()
  })

  it('whitelists the copied payload so it reaches the tarball', () => {
    for (const entry of ['templates', 'lib']) expect(meta.files).toContain(entry)
  })
})

describe('the payload copy', () => {
  const copy = resolve(root, 'scripts/copy-create-payload.mjs')

  it('exists and is what prepack runs', () => {
    expect(existsSync(copy)).toBe(true)
  })

  // Committed copies would drift; gitignored ones cannot. This asserts the repo has no stale copy.
  it('leaves nothing committed under the package', () => {
    for (const dir of ['templates', 'lib']) {
      if (!existsSync(join(pkgDir, dir))) continue
      const tracked = spawnSync('git', ['ls-files', `packages/create-kestrel/${dir}`], { cwd: root, encoding: 'utf8' })
      expect(tracked.stdout.trim(), `${dir} must not be committed — prepack generates it`).toBe('')
    }
  })

  it('reproduces the engine payload byte for byte', () => {
    const res = spawnSync(process.execPath, [copy], { cwd: root, encoding: 'utf8' })
    expect(res.status, res.stderr).toBe(0)
    try {
      for (const rel of walk(resolve(root, 'templates'))) {
        expect(readFileSync(join(pkgDir, 'templates', rel), 'utf8')).toBe(
          readFileSync(resolve(root, 'templates', rel), 'utf8'),
        )
      }
      for (const rel of ['scaffold.mjs', 'password.mjs', 'cli.mjs']) {
        expect(readFileSync(join(pkgDir, 'lib', rel), 'utf8')).toBe(
          readFileSync(resolve(root, 'scripts/lib', rel), 'utf8'),
        )
      }
    } finally {
      for (const dir of ['templates', 'lib']) rmSync(join(pkgDir, dir), { recursive: true, force: true })
    }
  })

  // postpack is not guaranteed to run (a failed publish skips it), so anything prepack writes must be a
  // generated file that `--clean` deletes — never a key in the committed manifest, which would be
  // committed and then silently pin stale ranges.
  it('stamps the engine ranges into a generated file, leaving the manifest untouched', () => {
    const before = readFileSync(join(pkgDir, 'package.json'), 'utf8')
    expect(spawnSync(process.execPath, [copy], { cwd: root, encoding: 'utf8' }).status).toBe(0)
    try {
      expect(readFileSync(join(pkgDir, 'package.json'), 'utf8'), 'prepack must not touch the manifest').toBe(before)
      const meta = readFileSync(join(pkgDir, 'lib/engine-meta.mjs'), 'utf8')
      const engine = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
      expect(meta).toContain(engine.dependencies.nuxt)
    } finally {
      spawnSync(process.execPath, [copy, '--clean'], { cwd: root })
    }
  })

  it('keeps no generated stamp in the committed manifest', () => {
    expect(JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))).not.toHaveProperty('//engine')
  })

  // npm reads a manifest BEFORE running prepack, so a version rewrite there reaches the tarball contents
  // but not the registry metadata (verified: the tarball is named from the pre-prepack version). Refusing
  // is the only honest option; the lockstep assertion above is what keeps it from ever firing.
  it('refuses to pack when the two manifests disagree on the version', () => {
    const manifestPath = join(pkgDir, 'package.json')
    const original = readFileSync(manifestPath, 'utf8')
    writeFileSync(manifestPath, original.replace(`"version": "${enginePkg.version}"`, '"version": "0.0.0-stale"'))
    try {
      const res = spawnSync(process.execPath, [copy], { cwd: root, encoding: 'utf8' })
      expect(res.status).toBe(1)
      expect(res.stderr).toContain('0.0.0-stale')
      expect(existsSync(join(pkgDir, 'templates')), 'a refused pack must leave no partial payload').toBe(false)
    } finally {
      writeFileSync(manifestPath, original)
      for (const dir of ['templates', 'lib']) rmSync(join(pkgDir, dir), { recursive: true, force: true })
    }
  })
})

describe('create-kestrel CLI', () => {
  const bin = join(pkgDir, 'index.mjs')
  let dir: string

  beforeAll(() => {
    // The bin resolves its payload from the copy when present and from the repo otherwise, so a checkout
    // runs without packing. Exercise the checkout path here; the copy path is covered above.
    for (const d of ['templates', 'lib']) rmSync(join(pkgDir, d), { recursive: true, force: true })
  })

  const run = (...args: string[]) =>
    spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'create-kestrel-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('scaffolds into a named directory', () => {
    const res = run('my-site', '--password', 'a-good-password')
    expect(res.status, res.stderr).toBe(0)
    for (const f of ['package.json', 'nuxt.config.ts', '.env', '.gitignore', 'app/app.vue']) {
      expect(existsSync(join(dir, 'my-site', f)), `${f} must be created`).toBe(true)
    }
    const manifest = JSON.parse(readFileSync(join(dir, 'my-site/package.json'), 'utf8'))
    expect(manifest.name).toBe('my-site')
    expect(manifest.dependencies['@michaelthielemann/kestrel']).toBe(`^${enginePkg.version}`)
  })

  it('slugifies an explicit --name rather than trusting it', () => {
    expect(run('site', '--name', 'Bad "Name"', '--password', 'a-good-password').status).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, 'site/package.json'), 'utf8')).name).toBe('bad-name')
  })

  it('scaffolds into the current directory when no name is given', () => {
    expect(run('--password', 'a-good-password').status).toBe(0)
    expect(existsSync(join(dir, 'nuxt.config.ts'))).toBe(true)
  })

  it('writes a usable .env from the entered password', () => {
    run('my-site', '--password', 'a-good-password')
    const env = readFileSync(join(dir, 'my-site/.env'), 'utf8')
    expect(env).toMatch(/^KESTREL_ADMIN_PASSWORD_HASH=scrypt\$/m)
    expect(env).toMatch(/^KESTREL_SESSION_SECRET=.+$/m)
  })

  // A create-* tool that silently merges into someone else's project would be a footgun; refuse instead.
  it('refuses a target that already holds a project', () => {
    writeFileSync(join(dir, 'package.json'), '{}')
    const res = run('--password', 'a-good-password')
    expect(res.status).toBe(1)
    expect(res.stderr).toMatch(/not empty|already/i)
    expect(res.stderr).toContain('kestrel init')
  })

  it('proceeds into a non-empty directory when forced', () => {
    writeFileSync(join(dir, 'package.json'), '{}')
    expect(run('--force', '--password', 'a-good-password').status).toBe(0)
  })

  it('ignores dotfiles when deciding whether the target is empty', () => {
    writeFileSync(join(dir, '.DS_Store'), '')
    expect(run('--password', 'a-good-password').status).toBe(0)
  })

  it('refuses an empty or too-short --password', () => {
    const res = run('site', '--password=')
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('at least')
  })

  it('keeps the target directory after a valueless flag', () => {
    expect(run('--force', 'my-site', '--password', 'a-good-password').status).toBe(0)
    expect(existsSync(join(dir, 'my-site/nuxt.config.ts'))).toBe(true)
    expect(existsSync(join(dir, 'nuxt.config.ts'))).toBe(false)
  })

  // A stray `.env` is a project, not editor litter — overwriting it would destroy a live secret.
  it('treats an existing .env as an occupied directory', () => {
    writeFileSync(join(dir, '.env'), 'KESTREL_SESSION_SECRET=precious\n')
    const res = run('--password', 'a-good-password')
    expect(res.status).toBe(1)
    expect(readFileSync(join(dir, '.env'), 'utf8')).toContain('precious')
  })

  it('writes the .env owner-only', () => {
    run('site', '--password', 'a-good-password')
    expect(statSync(join(dir, 'site/.env')).mode & 0o777).toBe(0o600)
  })

  it('rejects an unknown short option rather than making a directory called -x', () => {
    const res = run('-x')
    expect(res.status).toBe(1)
    expect(existsSync(join(dir, '-x'))).toBe(false)
  })

  it('prints the next steps a user has to run', () => {
    const res = run('my-site', '--password', 'a-good-password')
    expect(res.stdout).toContain('cd my-site')
    expect(res.stdout).toContain('install')
    expect(res.stdout).toContain('/admin')
  })

  it('reports a still-broken project rather than claiming success', () => {
    const res = run('--yes')
    expect(res.status).toBe(1)
    expect(res.stdout).toContain('KESTREL_ADMIN_PASSWORD_HASH')
  })
})
