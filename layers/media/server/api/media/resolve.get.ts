import { resolveManyByIds } from '../../utils/resolve'
import { useStorageDriver } from '../../../../core/server/utils/storage'
import { primaryLocale } from '../../../../core/server/utils/locale'
import { requireMediaCollection } from '../../utils/media-enabled'

export default defineEventHandler((event) => {
  requireMediaCollection()
  const q = getQuery(event)
  const ids = String(q.ids ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0)
  const locale = typeof q.locale === 'string' ? q.locale : primaryLocale()
  const driver = useStorageDriver()
  return { data: resolveManyByIds(useDb(), ids, locale, (k) => driver.publicUrl(k)) }
})
