// The batch operations the bulk endpoint accepts — the single source of truth shared by the server
// handler (`bulk.post.ts`) and any client that builds a bulk request. Pure, so the allow-list is
// unit-testable without a Nitro context.
export const BULK_ACTIONS = ['delete', 'publish', 'unpublish', 'duplicate'] as const
export type BulkAction = typeof BULK_ACTIONS[number]

export function isBulkAction(value: unknown): value is BulkAction {
  return typeof value === 'string' && (BULK_ACTIONS as readonly string[]).includes(value)
}
