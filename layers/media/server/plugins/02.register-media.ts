import { eq, getTableColumns } from 'drizzle-orm'
import { registerFieldPopulator } from '@michaelthielemann/kestrel-core'
import {
  media as mediaTable,
  buildMediaFieldPopulator,
  resolveMedia,
  useStorageDriver,
  mediaCollectionEnabled,
  useMediaDb,
} from '@michaelthielemann/kestrel-media'

export default defineNitroPlugin(() => {
  // A consumer who turned the built-in off has no `media` table, so a row that still carries a media id
  // must stay unpopulated rather than blow up the read path.
  if (!mediaCollectionEnabled()) return
  const cols = getTableColumns(mediaTable) as Record<string, never>
  registerFieldPopulator('media', buildMediaFieldPopulator((id, locale) => {
    const driver = useStorageDriver()
    const row = useMediaDb().db.select().from(mediaTable).where(eq(cols.id, id)).get()
    return row ? resolveMedia(row as never, locale, (k) => driver.publicUrl(k)) : null
  }))
})
