import { resolveServerKestrel, serverRuntimeConfig } from '../../../core/server/utils/server-config'

/**
 * Whether the EU AI Act disclosure feature is switched on for this consumer (`aiDisclosure.enabled`).
 *
 * It gates the ADMIN UI and the upload-time signal scan — never the data: `ResolvedMedia.aiDisclosure` is
 * always resolved from whatever the columns hold, so turning the flag off hides the editor without
 * touching (or hiding) a disclosure already recorded. Same runtimeConfig-then-own-config fallback as
 * `mediaCollectionEnabled`, so non-Nitro callers (scripts, build) resolve it too.
 */
export function aiDisclosureEnabled(): boolean {
  const cfg = (serverRuntimeConfig()?.kestrel?.aiDisclosure ?? resolveServerKestrel().aiDisclosure) as
    | { enabled?: boolean }
    | undefined
  return cfg?.enabled === true
}
