import { getResolvedKestrelConfig } from '@kestrel/core'

/**
 * Whether the EU AI Act disclosure feature is switched on for this consumer (`aiDisclosure.enabled`).
 *
 * It gates the ADMIN UI and the upload-time signal scan — never the data: `ResolvedMedia.aiDisclosure` is
 * always resolved from whatever the columns hold, so turning the flag off hides the editor without
 * touching (or hiding) a disclosure already recorded.
 */
export function aiDisclosureEnabled(): boolean {
  return getResolvedKestrelConfig().aiDisclosure?.enabled === true
}
