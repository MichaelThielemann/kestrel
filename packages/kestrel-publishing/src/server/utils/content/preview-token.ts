import { randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'

/**
 * Short-lived tickets carrying the editor's UNSAVED form state to a real page render. The editor's own
 * iframe gets unsaved content over postMessage, but an external tab has no parent window to talk to — so
 * instead of saving (which would publish intent the user never expressed) it mints a ticket and opens
 * `<url>?kestrel-preview-token=…`. Nothing is written to the DB; the ticket lives in this process only.
 *
 * The admin session is the actual gate (both pipelines declare `access: { role: 'admin' }`).
 * The owner binding on top is NOT per-session isolation today: Kestrel has one shared admin credential and
 * `derivePrincipal` (access layer) never mints more than one admin identity, so every caller that reaches
 * this store has already been narrowed by the access gate to the same principal, and `previewOwner()`
 * resolves to the literal string `'admin'` every time — `t.owner === owner` cannot currently be false for
 * an admin caller. The binding is kept because it is the seam that makes the check meaningful the moment
 * (if ever) a per-user identity is added upstream; until then it costs nothing and documents the intent.
 * Tickets stay readable until they expire — a preview tab may be reloaded — and the store bounds itself in
 * both directions: a sweep on every mint, and a hard cap that evicts the oldest ticket.
 *
 * In-memory by design: previewing is a per-editor, per-minute affair, and a second server instance would
 * simply re-mint. Nothing durable depends on it.
 * @public
 */
export interface PreviewPayload {
  collection: string
  /** The record being previewed, or null for one that has never been saved. */
  id: number | null
  locale?: string
  /** The editor's populated values — the same tree the live-preview bridge posts into the iframe. */
  values: Record<string, unknown>
}

/** @public */
export interface PreviewTicket {
  token: string
  expiresAt: number
}

/** @public */
export interface PreviewStore {
  mint: (owner: string, payload: PreviewPayload) => PreviewTicket
  read: (token: string, owner: string) => PreviewPayload | null
  size: () => number
}

/** @public */
export interface PreviewStoreOptions {
  ttlMs?: number
  max?: number
  now?: () => number
  randomToken?: () => string
}

const TTL_MS = 10 * 60 * 1000
const MAX_TICKETS = 32

/** @public */
export function createPreviewStore(opts: PreviewStoreOptions = {}): PreviewStore {
  const ttlMs = opts.ttlMs ?? TTL_MS
  const max = opts.max ?? MAX_TICKETS
  const now = opts.now ?? Date.now
  const randomToken = opts.randomToken ?? (() => randomBytes(24).toString('base64url'))
  // Insertion-ordered, which is what makes "evict the oldest" a single `keys().next()`.
  const tickets = new Map<string, { owner: string; payload: PreviewPayload; expiresAt: number }>()

  function sweep(at: number): void {
    for (const [token, t] of tickets) if (t.expiresAt <= at) tickets.delete(token)
  }

  return {
    mint(owner, payload) {
      const at = now()
      sweep(at)
      while (tickets.size >= max) tickets.delete(tickets.keys().next().value as string)
      const token = randomToken()
      const expiresAt = at + ttlMs
      tickets.set(token, { owner, payload, expiresAt })
      return { token, expiresAt }
    },
    read(token, owner) {
      const t = tickets.get(token)
      if (!t) return null
      if (t.expiresAt <= now()) {
        tickets.delete(token)
        return null
      }
      // Bound to the minting owner rather than trusted on token possession alone — inert while every admin
      // caller resolves to the same owner (see the module docstring), but the check a future per-user
      // identity would need is already the one being run, not one that would need to be added later.
      return t.owner === owner ? t.payload : null
    },
    size: () => tickets.size,
  }
}

/**
 * Who a ticket belongs to. In production this only ever runs after the pipeline's access gate has already
 * refused anyone but the admin principal, and `derivePrincipal` (access layer) always gives that
 * principal a fixed `userId: 'admin'` — so the first branch always wins and this always returns the
 * literal `'admin'`. The `role` / `'anonymous'` fallbacks are unreached by any principal shape
 * `derivePrincipal` produces today; kept as a defensive default rather than a non-null assertion, since
 * this function has no way to enforce that invariant itself.
 * @public
 */
export function previewOwner(event: H3Event): string {
  const principal = event.context.principal as { userId?: string | null; role?: string } | undefined
  return principal?.userId ?? principal?.role ?? 'anonymous'
}

/** The process-wide store the preview pipelines share. */
let shared: PreviewStore | null = null
/** @public */
export function usePreviewStore(): PreviewStore {
  shared ??= createPreviewStore()
  return shared
}
