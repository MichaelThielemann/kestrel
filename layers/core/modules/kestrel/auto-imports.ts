/**
 * The consumer-facing authoring API, registered as Nuxt/Nitro auto-imports so a site built on Kestrel
 * can write `defineCollection({...})` without importing it. Every name here is also importable
 * explicitly from its package; the auto-import is a convenience, not the only path.
 */
export interface AutoImportEntry {
  name: string
  from: string
}

const CORE = '@michaelthielemann/kestrel-core'
const FIELDS = '@michaelthielemann/kestrel-fields'
const ACCESS = '@michaelthielemann/kestrel-access'

const entries = (from: string, names: string[]): AutoImportEntry[] => names.map((name) => ({ name, from }))

/** Server-only (Nitro) authoring API: collections, pipelines, revisions, field populators, access. */
export const serverAutoImports: AutoImportEntry[] = [
  ...entries(CORE, [
    'defineCollection',
    'buildCollection',
    'definePipeline',
    'registerPipeline',
    'registerAfterStep',
    'syncStep',
    'asyncStep',
    'eventsOf',
    'getFieldPopulator',
    'readRevisions',
    'registerRevisionUpcast',
    'useDb',
  ]),
  ...entries(FIELDS, ['defineFieldType', 'constrain', 'opt']),
  ...entries(ACCESS, ['registerAccessGrant']),
]

/** App-side (Vue) authoring API: block definitions live next to their components. */
export const appAutoImports: AutoImportEntry[] = entries(`${FIELDS}/client`, ['defineBlock'])
