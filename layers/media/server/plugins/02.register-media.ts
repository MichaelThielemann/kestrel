import { eq, getTableColumns } from 'drizzle-orm'
import { media as mediaTable } from '../collections/media'
import { registerFieldPopulator } from '../../../core/server/utils/populate'
import { buildMediaFieldPopulator } from '../utils/populate'
import { resolveMedia } from '../utils/resolve'
import { useStorageDriver } from '../../../core/server/utils/storage'
import { mediaCollectionEnabled } from '../utils/media-enabled'

export default defineNitroPlugin(() => {
  // A consumer who turned the built-in off has no `media` table, so a row that still carries a media id
  // must stay unpopulated rather than blow up the read path.
  if (!mediaCollectionEnabled()) return
  const cols = getTableColumns(mediaTable) as Record<string, never>
  registerFieldPopulator('media', buildMediaFieldPopulator((id, locale) => {
    const driver = useStorageDriver()
    const row = useDb().select().from(mediaTable).where(eq(cols.id, id)).get()
    return row ? resolveMedia(row as never, locale, (k) => driver.publicUrl(k)) : null
  }))
})
