import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { blockNameFromFile } from './extract-block'

type Lister = (dir: string) => string[]

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

export function renderRegistry(absPaths: string[]): string {
  if (!absPaths.length) return 'export default []'
  const imports = absPaths.map((p, i) => `import _${i} from ${JSON.stringify(p)}`)
  const arr = absPaths.map((_, i) => `_${i}`).join(', ')
  return `${imports.join('\n')}\nexport default [${arr}]`
}
