import { getResolvedKestrelConfig } from './kestrel-config-provider.js'

/**
 * Whether the running instance serves rendered pages live at request time (vs. static-only output).
 * @public
 */
export function isDeliveryLive(): boolean {
  return getResolvedKestrelConfig().delivery === 'live'
}

/**
 * Path prefixes reserved for the consumer's own runtime route under `delivery: 'live'`.
 * @public
 */
export function deliveryExemptPrefixes(): string[] {
  return getResolvedKestrelConfig().deliveryExempt
}

/**
 * Is `path` under one of the exempt prefixes — reserved for the consumer's own route, never a page-like record.
 * @public
 */
export function isDeliveryExemptPath(path: string): boolean {
  return deliveryExemptPrefixes().some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix))
}
