import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from '#imports'
import { itemKey, computeRange, parentFolder, type LibraryFile, type LibraryFolder, type LibraryItem } from '../utils/library'

interface LibraryResponse { folder: string; exists?: boolean; folders: LibraryFolder[]; files: LibraryFile[]; total: number; page: number; perPage: number }
const PER_PAGE = 60
const VIEW_KEY = 'kestrel-media-view'

export function useMediaLibrary(opts: { urlSync?: boolean; accept?: 'image' | 'any'; initialFolder?: string } = {}) {
  const urlSync = opts.urlSync ?? true
  const accept = opts.accept ?? 'any'

  const route = useRoute()
  const router = useRouter()
  const { t } = useT()

  const folder = ref<string>(urlSync && typeof route.query.folder === 'string' ? route.query.folder : (opts.initialFolder ?? ''))
  const folders = ref<LibraryFolder[]>([])
  const files = ref<LibraryFile[]>([])
  const total = ref(0)
  const page = ref(1)
  const search = ref('')
  const sort = ref<string>('name') // `field` (asc) or `-field` (desc); matches the table headers
  const view = ref<'grid' | 'table'>('grid')
  const loading = ref(false)
  const error = ref<string | null>(null)
  const selected = ref<Set<string>>(new Set())
  let anchorKey: string | null = null
  let token = 0
  let searchTimer: ReturnType<typeof setTimeout> | undefined

  if (import.meta.client) {
    const v = localStorage.getItem(VIEW_KEY)
    if (v === 'grid' || v === 'table') view.value = v
  }

  const items = computed<LibraryItem[]>(() => [
    ...folders.value.map((f) => ({ type: 'folder' as const, folder: f })),
    ...files.value.map((f) => ({ type: 'file' as const, file: f })),
  ])
  // Parent-folder ("..") target for up-navigation: null at the root (no item rendered there). Kept out
  // of `items`/selection so it stays pure navigation chrome, never selectable or draggable.
  const parentPath = computed(() => parentFolder(folder.value))
  const orderedKeys = computed(() => items.value.map(itemKey))
  const hasMore = computed(() => files.value.length < total.value)
  const count = computed(() => selected.value.size)

  async function fetchLibrary(append = false) {
    // A non-append fetch is a full refresh (mount / nav / sort / search / a mutation's re-list): reset to
    // page 1 so it never re-requests a deep page and assigns ONLY that page's slice — which after a
    // "Load more" would silently drop every earlier page from the listing. loadMore() bumps page then appends.
    if (!append) page.value = 1
    const my = ++token
    loading.value = true
    error.value = null
    try {
      const res = await $fetch<LibraryResponse>('/api/media/library', {
        query: { folder: folder.value, search: search.value || undefined, sort: sort.value, page: page.value, perPage: PER_PAGE, type: accept === 'image' ? 'image' : undefined },
      })
      if (my !== token) return
      // A non-root path the server doesn't know is a typo/dead link, not an empty folder: surface an
      // error rather than a blank listing that looks like the folder exists.
      if (folder.value !== '' && res.exists === false) {
        folders.value = []
        files.value = []
        total.value = 0
        error.value = t('media.folderNotFound')
        return
      }
      folders.value = res.folders
      files.value = append ? [...files.value, ...res.files] : res.files
      total.value = res.total
    } catch (e) {
      if (my !== token) return
      error.value = (e as { statusMessage?: string })?.statusMessage ?? t('media.error.load')
    } finally {
      if (my === token) loading.value = false
    }
  }

  function loadMore() {
    if (!hasMore.value || loading.value) return
    page.value += 1
    return fetchLibrary(true)
  }

  // Returns the in-flight work so callers can await navigation: the fetch directly (urlSync:false), or
  // the router push that the route watcher turns into a fetch (urlSync).
  function navigate(path: string) {
    if (path === folder.value) return
    if (urlSync) return router.push({ query: path ? { folder: path } : {} })
    clearTimeout(searchTimer)
    search.value = ''
    folder.value = path
    page.value = 1
    clear()
    return fetchLibrary()
  }

  function setSearch(s: string) {
    search.value = s
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => { page.value = 1; fetchLibrary() }, 250)
  }

  function setView(v: 'grid' | 'table') {
    view.value = v
    if (import.meta.client) localStorage.setItem(VIEW_KEY, v)
  }

  // Clicking a column re-sorts: same field flips direction, a new field starts ascending.
  function setSort(field: string) {
    sort.value = sort.value === field ? `-${field}` : field
    page.value = 1
    return fetchLibrary()
  }

  const isSelected = (item: LibraryItem) => selected.value.has(itemKey(item))
  function select(item: LibraryItem) { const k = itemKey(item); selected.value = new Set([k]); anchorKey = k }
  function toggle(item: LibraryItem) {
    const k = itemKey(item); const s = new Set(selected.value)
    if (s.has(k)) s.delete(k)
    else s.add(k)
    selected.value = s; anchorKey = k
  }
  function range(item: LibraryItem) { selected.value = computeRange(orderedKeys.value, anchorKey ?? itemKey(item), itemKey(item), selected.value) }
  function clear() { selected.value = new Set(); anchorKey = null }
  function selectAll() { selected.value = new Set(orderedKeys.value) }

  if (urlSync) {
    watch(() => route.query.folder, (q) => {
      const next = typeof q === 'string' ? q : ''
      if (next === folder.value) return
      clearTimeout(searchTimer)
      search.value = ''
      folder.value = next
      page.value = 1
      clear()
      fetchLibrary()
    })
  }

  onMounted(() => fetchLibrary())
  onUnmounted(() => clearTimeout(searchTimer))

  return {
    folder, folders, files, total, page, search, sort, view, loading, error,
    items, parentPath, orderedKeys, hasMore, count, selected,
    fetchLibrary, loadMore, navigate, setSearch, setView, setSort,
    isSelected, select, toggle, range, clear, selectAll,
  }
}
