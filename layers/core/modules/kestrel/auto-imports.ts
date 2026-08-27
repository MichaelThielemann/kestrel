/**
 * Kestrel's authoring API, registered as Nuxt/Nitro auto-imports so a site built on Kestrel can write
 * `defineCollection({...})` or `getCollection('pages')` without importing — the same surface a 3.x site
 * had when this code still lived in the layers' `server/utils`. The names are read off the packages'
 * real exports at build time, so a new public function is auto-importable the moment it is exported;
 * every name stays importable explicitly from its package as well.
 */
export interface AutoImportEntry {
  name: string
  from: string
}

const PKG = '@michaelthielemann/kestrel-'

/** Order matters: a name exported by several packages (re-exports) is registered from the first one. */
const SERVER_PACKAGES = ['core', 'fields', 'contracts', 'auth', 'access', 'media', 'collections', 'publishing', 'delivery-live', 'delivery-static']
const APP_PACKAGES = ['core/client', 'fields/client']

/** `kestrelDiscovery`: module manifests for the discovery module, never something a site calls.
 *  `renderRouteLive`: the public layer's own `server/utils` wrapper of the same name is the wired one, and
 *  Nitro's directory scan already auto-imports it — registering the package export too only draws a
 *  "duplicated imports" warning on every build. */
const EXCLUDED = new Set(['default', 'kestrelDiscovery', 'renderRouteLive'])

async function collect(packages: string[]): Promise<AutoImportEntry[]> {
  const seen = new Set<string>()
  const entries: AutoImportEntry[] = []
  for (const pkg of packages) {
    const from = PKG + pkg
    const mod = (await import(from)) as Record<string, unknown>
    for (const name of Object.keys(mod)) {
      if (EXCLUDED.has(name) || seen.has(name)) continue
      seen.add(name)
      entries.push({ name, from })
    }
  }
  return entries
}

/** Server-only (Nitro) authoring API: every runtime export of the server packages. */
export const serverAutoImports = (): Promise<AutoImportEntry[]> => collect(SERVER_PACKAGES)

/** App-side (Vue) authoring API: every runtime export of the client entry points. */
export const appAutoImports = (): Promise<AutoImportEntry[]> => collect(APP_PACKAGES)
