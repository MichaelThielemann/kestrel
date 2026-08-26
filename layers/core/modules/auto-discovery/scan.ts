import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blockNameFromFile } from './extract-block'

type Lister = (dir: string) => string[]

/**
 * Resolves a bare `@michaelthielemann/kestrel-*` package specifier to its real entry FILE PATH, via Node's
 * own ESM resolution from THIS module's own location — not the bare specifier itself, which a Nitro
 * virtual module (no real file path of its own) cannot resolve reliably: Rollup falls back to resolving a
 * virtual's imports from the project root, and under pnpm's isolated `node_modules` a package the
 * CONSUMER never declared a direct dependency on (only the engine did, transitively) is invisible there —
 * observed as `Cannot find package` at runtime, npm's flat hoisting having accidentally masked it in
 * testing. This module's own file, once installed, sits inside the engine's package tree, so resolving
 * from here walks the engine's OWN nested `node_modules`, where pnpm DID link the real dependency.
 */
export function resolvePackageEntry(spec: string): string {
  return fileURLToPath(import.meta.resolve(spec))
}

const isDefinition = (name: string) =>
  name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')

export function listDefinitionFiles(dir: string, list: Lister = readdirSync): string[] {
  let entries: string[]
  try {
    entries = list(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return entries
    .filter(isDefinition)
    .sort()
    .map((name) => join(dir, name))
}

/**
 * Definition files across every layer's `subdir`, deduped by BASENAME with LAYER PRIORITY: `layerRoots` is
 * Nuxt's `_layers` order (consumer/highest-priority first), so a consumer's `collections/pages.ts` (or
 * `field-types/color.ts`) SHADOWS the same-named lower-layer file — a deterministic override, instead of
 * importing both and relying on the registry's last-write-wins under an alphabetical path sort (which made
 * "who wins" a coincidence of the node_modules path). Mirrors `collectBlockSfcs`'s name-first dedup.
 */
export function collectDefinitions(layerRoots: string[], subdir: string, list?: Lister): string[] {
  const byBasename = new Map<string, string>()
  for (const root of layerRoots) {
    for (const file of listDefinitionFiles(join(root, subdir), list)) {
      const name = basename(file)
      if (!byBasename.has(name)) byBasename.set(name, file) // first (highest-priority layer) wins
    }
  }
  return [...byBasename.values()].sort()
}

const isVue = (name: string) => name.endsWith('.vue') && !name.endsWith('.test.vue')

/** `.vue` files in `dir`, sorted; `[]` when the dir is absent. Mirrors `listDefinitionFiles` for blocks. */
export function listVueFiles(dir: string, list: Lister = readdirSync): string[] {
  let entries: string[]
  try {
    entries = list(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return entries.filter(isVue).sort().map((name) => join(dir, name))
}

/** Block SFCs across every layer's `app/blocks/` dir, deduped by BLOCK NAME with LAYER PRIORITY: `layerRoots`
 *  is Nuxt's `_layers` order (consumer/highest-priority first), so the first file seen for a given block name
 *  wins. This matches how the display component is resolved (project-first), so a same-named override takes
 *  its schema AND its template from the same layer — a plain alphabetical path sort handed the schema to
 *  whichever path sorted last (typically the node_modules layer), silently splitting the two. */
export function collectBlockSfcs(layerRoots: string[], subdir = 'app/blocks', list?: Lister): string[] {
  const byName = new Map<string, string>()
  for (const root of layerRoots) {
    for (const file of listVueFiles(join(root, subdir), list)) {
      const name = blockNameFromFile(basename(file))
      if (!byName.has(name)) byName.set(name, file) // first (highest-priority layer) wins
    }
  }
  // Name-unique now, so the final sort is only for a deterministic, stable import order.
  return [...byName.values()].sort()
}

/**
 * Each layer's OWN `server/db/manifest.ts` (ADR-0012 ownership manifest), one per layer that has one.
 * Unlike `collectDefinitions`, this does NOT dedupe by basename: every layer's manifest is a distinct
 * module contribution (no shadow/override semantics — `media`'s manifest and `public`'s manifest both
 * happen to be named `manifest.ts`, and both must survive). Layer order is whatever `layerRoots` is.
 */
export function collectManifestFiles(layerRoots: string[], list?: Lister): string[] {
  const files: string[] = []
  for (const root of layerRoots) {
    for (const file of listDefinitionFiles(join(root, 'server/db'), list)) {
      if (basename(file) === 'manifest.ts') files.push(file)
    }
  }
  return files
}

export function renderRegistry(absPaths: string[]): string {
  if (!absPaths.length) return 'export default []'
  const imports = absPaths.map((p, i) => `import _${i} from ${JSON.stringify(p)}`)
  const arr = absPaths.map((_, i) => `_${i}`).join(', ')
  return `${imports.join('\n')}\nexport default [${arr}]`
}

/**
 * A registry combining package-provided items (each package's `kestrelDiscovery.<property>`, read via a
 * bare specifier — no filesystem/`node_modules` guessing) with consumer/layer-scanned files, with a
 * SAME-NAME layer item overriding a package's (via `mergeKestrelDiscovered`, evaluated at virtual-load
 * time — package names aren't knowable at codegen time without loading the package, which this
 * deliberately avoids doing at build time). `nameOfExpr` is a JS arrow-function source string the
 * generated module evaluates per item (e.g. `'(x) => x.name'` for collections,
 * `'(x) => __kestrelTableName(x)'` for schema-tables, paired with `extraImports` supplying
 * `__kestrelTableName`).
 */
export function renderPackageMergedRegistry(opts: {
  packages: string[]
  property: 'collections' | 'schemaTables'
  consumerFiles: string[]
  nameOfExpr: string
  extraImports?: string
  preamble?: string
}): string {
  const pkgImports = opts.packages.map((spec, i) => `import { kestrelDiscovery as __pkg${i} } from ${JSON.stringify(spec)}`)
  const pkgSpread = opts.packages.map((_, i) => `...(__pkg${i}.${opts.property} ?? [])`).join(', ')
  const consumerImports = opts.consumerFiles.map((p, i) => `import _c${i} from ${JSON.stringify(p)}`)
  const consumerArr = opts.consumerFiles.map((_, i) => `_c${i}`).join(', ')
  return [
    opts.preamble ?? '',
    opts.extraImports ?? '',
    `import { mergeKestrelDiscovered } from ${JSON.stringify(resolvePackageEntry('@michaelthielemann/kestrel-core'))}`,
    ...pkgImports,
    ...consumerImports,
    `export default mergeKestrelDiscovered([${pkgSpread}], [${consumerArr}], ${opts.nameOfExpr})`,
  ].filter(Boolean).join('\n')
}

/**
 * A registry concatenating package-provided items (`kestrelDiscovery.<property>`) with consumer/layer-
 * scanned files — NO dedup (mirrors `collectManifestFiles`'s own "every contribution is distinct, no
 * shadow semantics" contract; unlike collections/schema-tables, two manifests sharing a name is not a
 * schema conflict, so there is nothing to override).
 */
export function renderPackageConcatRegistry(opts: {
  packages: string[]
  property: 'manifest'
  consumerFiles: string[]
  preamble?: string
}): string {
  const pkgImports = opts.packages.map((spec, i) => `import { kestrelDiscovery as __pkg${i} } from ${JSON.stringify(spec)}`)
  // `opts.packages` is expected to be pre-filtered to packages that actually contribute this property (the
  // caller's per-category list), so every `.manifest` read here SHOULD be defined — but the spread stays
  // conditional (`...(x ? [x] : [])`, not a bare `x`) as a defense-in-depth guard: a package mis-listed in
  // the wrong `PACKAGE_*` category contributes nothing instead of polluting the array with `undefined`.
  const pkgItems = opts.packages.map((_, i) => `...(__pkg${i}.${opts.property} ? [__pkg${i}.${opts.property}] : [])`)
  const consumerImports = opts.consumerFiles.map((p, i) => `import _c${i} from ${JSON.stringify(p)}`)
  const consumerArr = opts.consumerFiles.map((_, i) => `_c${i}`)
  const all = [...pkgItems, ...consumerArr].join(', ')
  return [
    opts.preamble ?? '',
    ...pkgImports,
    ...consumerImports,
    `export default [${all}]`,
  ].filter(Boolean).join('\n')
}
