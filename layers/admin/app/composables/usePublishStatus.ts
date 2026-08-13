import { ref, toValue } from 'vue'
import type { MaybeRefOrGetter } from 'vue'

/** The live publish state of a record's static page, as returned by `GET /api/publish-status`. */
export interface PublishStatusData {
  route: string | null
  status: 'success' | 'error' | null
  error?: string | null
  updatedAt?: string | null
  /** Which output the last attempt wrote to — `'local'` dir or `'s3'` bucket; null when no row yet. */
  target?: 'local' | 's3' | null
  /** The record was saved after its page was last published — the live file is an older version of it.
   *  The normal working state while editing, since a save no longer republishes (ADR-0008). */
  pending?: boolean
  /** The consumer opted out of the save/publish split (`output.publishOnSave`): a save republishes on its
   *  own, so the editor offers no Publish button and never reports unpublished changes. */
  publishOnSave?: boolean
  /** Whether the runtime publisher actually produces files in THIS environment (prod + `output.auto`).
   *  `false` in dev / with static output off → a page can never turn "Live" here, so don't poll for it. */
  generates?: boolean
  /** The configured output destination (where the NEXT publish would go), independent of any row. */
  driver?: 'local' | 's3'
}

const EMPTY: PublishStatusData = { route: null, status: null }

/**
 * Fetch (and refetch) the LIVE / generated publish state of the record the editor is on, for the right
 * dot of the editor Ampel. Explicit `refresh()` (no auto-fetch) so it is testable in isolation and the
 * caller controls timing: the editor refreshes on mount and again after each save (a save may (re)publish
 * the page). Skips the request entirely when disabled (non-pageLike collection) or the record is unsaved
 * (`id === 'new'` has no server row, hence no route yet). A failed fetch degrades to an empty status
 * rather than surfacing an error — the ampel is a non-critical signal.
 */
export function usePublishStatus(args: {
  collection: MaybeRefOrGetter<string>
  id: MaybeRefOrGetter<string | number>
  locale?: MaybeRefOrGetter<string | undefined>
  enabled?: MaybeRefOrGetter<boolean>
}) {
  const data = ref<PublishStatusData>({ ...EMPTY })
  // Bumped by every `refresh()` / `refreshUntilSettled()` start; an in-flight poll compares the token it
  // captured and bails the moment a newer call supersedes it (navigation, another save), so stale loops
  // can't keep writing to `data`.
  let pollToken = 0

  async function fetchOnce(): Promise<void> {
    // Guard every write by the token captured at call time: if a newer refresh/poll supersedes this one
    // while its request is in flight, its (possibly stale) response must NOT overwrite the fresher data —
    // two overlapping fetches (a rapid re-save superseding a poll) can otherwise resolve out of order.
    const token = pollToken
    const enabled = args.enabled === undefined ? true : toValue(args.enabled)
    const id = toValue(args.id)
    if (!enabled || id === 'new' || id == null) {
      if (token === pollToken) data.value = { ...EMPTY }
      return
    }
    try {
      const res = await $fetch<PublishStatusData>('/api/publish-status', {
        query: { collection: toValue(args.collection), id, locale: toValue(args.locale) },
      })
      if (token === pollToken) data.value = res
    } catch {
      if (token === pollToken) data.value = { ...EMPTY }
    }
  }

  /** One-shot fetch. Also cancels any running poll (this is the fresh source of truth). */
  async function refresh(): Promise<void> {
    pollToken++
    await fetchOnce()
  }

  /**
   * Poll the live status until it SETTLES, for the right lamp after a save: in prod a save enqueues an
   * async (debounced) republish that finishes a moment later, so a single refresh would only ever catch the
   * pre-republish row. Stops when the record has no route, the environment doesn't generate (`generates ===
   * false` — dev / static output off: nothing will ever be produced, so polling is pointless), or a terminal
   * outcome (`success`/`error`) from the NEW republish lands.
   *
   * `since` is the row's `updatedAt` BEFORE this save. `publish_status` is a latest-state upsert that is NOT
   * cleared first, so a re-saved page keeps its prior success/error row until the fresh render rewrites it —
   * without this baseline the very first poll would read that stale row and settle instantly (e.g. staying
   * green "Live" for a re-save that actually failed to republish). So a terminal outcome only counts as
   * settled once its `updatedAt` differs from `since`. Bounded by `attempts`; superseded-safe via `pollToken`.
   */
  async function refreshUntilSettled(opts?: { attempts?: number; delayMs?: number; since?: string | null }): Promise<void> {
    const token = ++pollToken
    const attempts = opts?.attempts ?? 12
    const delayMs = opts?.delayMs ?? 2000
    const since = opts?.since ?? null
    for (let i = 0; i < attempts; i++) {
      if (token !== pollToken) return
      await fetchOnce()
      if (token !== pollToken) return
      const d = data.value
      const settled = (d.status === 'success' || d.status === 'error') && (d.updatedAt ?? null) !== since
      if (!d.route || d.generates === false || settled) return
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  return { data, refresh, refreshUntilSettled }
}
