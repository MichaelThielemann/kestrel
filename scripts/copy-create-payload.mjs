import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// create-kestrel ships copies of the engine's templates + scaffold lib. Generating them at pack time
// keeps one source of truth; committing them would let the two drift. See ADR-0005.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = join(ROOT, 'packages/create-kestrel')
const LIB_FILES = ['scaffold.mjs', 'password.mjs', 'cli.mjs']
const GENERATED = ['templates', 'lib', 'LICENSE', 'NOTICE']

const manifestPath = join(PKG, 'package.json')

const clean = () => {
  for (const entry of GENERATED) rmSync(join(PKG, entry), { recursive: true, force: true })
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest['//engine']) {
    delete manifest['//engine']
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }
}

if (process.argv.includes('--clean')) {
  clean()
} else {
  clean()
  const engine = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  // The version cannot be corrected here: npm derives the tarball name from the manifest as it stood
  // BEFORE prepack, so a rewrite yields a tarball whose name and contents disagree. Refuse instead —
  // test/create-kestrel.test.ts keeps the two manifests in lockstep so this never fires in practice.
  if (manifest.version !== engine.version) {
    console.error(`create-kestrel is at ${manifest.version} but the engine is at ${engine.version} — bump both.`)
    process.exit(1)
  }

  cpSync(join(ROOT, 'templates'), join(PKG, 'templates'), { recursive: true })
  mkdirSync(join(PKG, 'lib'), { recursive: true })
  for (const file of LIB_FILES) cpSync(join(ROOT, 'scripts/lib', file), join(PKG, 'lib', file))
  for (const file of ['LICENSE', 'NOTICE']) {
    if (existsSync(join(ROOT, file))) cpSync(join(ROOT, file), join(PKG, file))
  }

  // Stamped so the scaffolded manifest pins the ranges the engine actually resolves.
  manifest['//engine'] = {
    nuxt: engine.dependencies?.nuxt,
    typescript: engine.dependencies?.typescript,
    'vue-tsc': engine.devDependencies?.['vue-tsc'],
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}
