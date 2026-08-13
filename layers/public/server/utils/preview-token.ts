import { randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'

/**
 * Short-lived tickets carrying the editor's UNSAVED form state to a real page render. The editor's own
 * iframe gets unsaved content over postMessage, but an external tab has no parent window to talk to — so
 * instead of saving (which would publish intent the user never expressed) it mints a ticket and opens
 * `<url>?kestrel-preview-token=…`. Nothing is written to the DB; the ticket lives in this process only.
 *
 * The admin session is the actual gate (both endpoints are admin-only under the default-deny API guard);
 * the owner binding on top means one admin's ticket is not usable from another session. Tickets stay
 * readable until they expire — a preview tab may be reloaded — and the store bounds itself in both
 * directions: a sweep on every mint, and a hard cap that evicts the oldest ticket.
 *
 * In-memory by design: previewing is a per-editor, per-minute affair, and a second server instance would
 * simply re-mint. Nothing durable depends on it.
 */
export interface PreviewPayload {
  collection: string
  /** The record being previewed, or null for one that has never been saved. */
  id: number | null
  locale?: string
  /** The editor's populated values — the same tree the live-preview bridge posts into the iframe. */
  values: Record<string, unknown>
}

export interface PreviewTicket {
  token: string
  expiresAt: number
}

export interface PreviewStore {
  mint: (owner: string, payload: PreviewPayload) => PreviewTicket
  read: (token: string, owner: string) => PreviewPayload | null
  size: () => number
}

export interface PreviewStoreOptions {
  ttlMs?: number
  max?: number
  now?: () => number
  randomToken?: () => string
}

const TTL_MS = 10 * 60 * 1000
const MAX_TICKETS = 32

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
      // A ticket is bound to the session that minted it — a leaked URL is not a second way in.
      return t.owner === owner ? t.payload : null
    },
    size: () => tickets.size,
  }
}

/**
 * Who a ticket belongs to. Kestrel's admin session has no per-user identity of its own (one admin,
 * one password hash), so the role stands in when `userId` is null — the binding narrows a leaked URL to
 * an authenticated admin session, it is not an authorization tier of its own.
 */
export function previewOwner(event: H3Event): string {
  const principal = event.context.principal as { userId?: string | null; role?: string } | undefined
  return principal?.userId ?? principal?.role ?? 'anonymous'
}

/** The process-wide store the two `/api/preview` handlers share. */
let shared: PreviewStore | null = null
export function usePreviewStore(): PreviewStore {
  shared ??= createPreviewStore()
  return shared
}
