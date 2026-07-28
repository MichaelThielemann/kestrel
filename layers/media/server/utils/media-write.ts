import { emitWrite } from '../../../core/server/utils/write-events'
import mediaCollection from '../collections/media'

/**
 * Notify the publish runtime that a media row changed. The media-library write paths (relocate / duplicate
 * / delete / alt-edit) bypass core CRUD, so — unlike a normal content write — they emit no write event on
 * their own. Without this, a page that embeds the media (dep-tagged `media:<id>`) is never re-rendered, so
 * the static output keeps the old (now 404) URL or stale alt text. `before`/`after` need only carry `id`
 * for the media classification (non-pageLike, no status column).
 */
export function emitMediaWrite(before: Record<string, unknown> | null, after: Record<string, unknown> | null): void {
  emitWrite(mediaCollection.def, before, after)
}
