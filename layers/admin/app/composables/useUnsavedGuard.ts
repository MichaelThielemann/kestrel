import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'

/**
 * Confirm before navigating away from unsaved editor changes. Registers BOTH route guards on purpose:
 * `onBeforeRouteLeave` fires when the matched route record is dropped (editor → list, rail nav), but
 * Vue Router fires `onBeforeRouteUpdate` instead when a param/query-only change reuses the SAME record —
 * which is exactly what the LocaleBar does (edit a sibling translation `/admin/{coll}/{id}`,
 * create-and-link `/admin/{coll}/new?…`, switch a singleton's `?locale`). Without the update guard those
 * same-record transitions silently discard in-progress edits (the `key: route.fullPath` remount only
 * happens AFTER the router has already committed the navigation, so it can't veto it).
 *
 * `isDirty` / `skip` / `message` are read lazily on each navigation so the guard always sees current
 * state. Returning `false` from a guard cancels the navigation; `skip()` lets a post-save / delete
 * redirect pass straight through.
 */
export function useUnsavedGuard(isDirty: () => boolean, message: () => string, skip: () => boolean = () => false): void {
  const guard = () => {
    if (!skip() && isDirty() && !confirm(message())) return false
  }
  onBeforeRouteLeave(guard)
  onBeforeRouteUpdate(guard)
}
