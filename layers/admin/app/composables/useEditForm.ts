import type { SerializedField } from '../../../core/server/utils/serialize-collection'
import type { LayoutNode } from '../../../core/server/utils/field-layout'
import type { BlockErrorMap } from '../utils/edit-form'
import type { DeadRef } from '../utils/dead-refs'
import { asFieldDef, initialValues, mapServerErrors, parseBlockErrors, reconcileBlockErrors, readFetchError } from '../utils/edit-form'

export interface UseEditFormOptions {
  collection: string
  id: string
  /** Requested content locale (from the `?locale` route query). Defaults to the primary locale. */
  locale?: string
  /** translationGroup to link a NEW multi translation to its siblings (from the `?group` query). */
  group?: string
}

export type SubmitResult = { ok: true; record: unknown } | { ok: false }

function snapshot(values: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(values))
}

export function useEditForm(opts: UseEditFormOptions) {
  const { collection, id } = opts
  const { t } = useT()
  const { primary } = useContentLocales()
  // The locale the editor *requests* (single GET/PUT + a new multi translation). For an existing multi
  // row the active locale comes from the row itself (set in init); it can't be switched via a query.
  const requestedLocale = opts.locale?.trim() || primary
  const activeLocale = ref(requestedLocale)
  const translations = ref<Record<string, number | null>>({})
  // Stale references this record currently holds (derived on read) — drives the editor's dead-ref warnings.
  const deadRefs = ref<DeadRef[]>([])
  // The translation group the LocaleBar links new siblings to: the requested group for a new
  // translation, or the loaded row's own group for an existing multi record.
  const translationGroup = ref<string | undefined>(opts.group?.trim() || undefined)

  const fields = ref<Record<string, SerializedField>>({})
  // The collection's normalized admin editor layout (resolved server-side), or undefined → one field per row.
  const fieldLayout = ref<LayoutNode[] | undefined>(undefined)
  const mode = ref<'multi' | 'single'>('multi')
  const translatable = ref(false)
  const blocksEnabled = ref(false)
  const blocksAllowed = ref<string[] | undefined>(undefined)
  // pageLike collections carry a routable `path` (the slug) as a system column, edited in the page editor.
  const pageLike = ref(false)
  // seo-enabled collections carry a `seo` JSON system column ({ title, description, noindex }).
  const hasSeo = ref(false)
  // status-enabled collections carry a `status` system column ('draft' | 'published') — the publish gate.
  const hasStatus = ref(false)
  // Which editor body renders (the `editor` type on the serialized collection). The server resolves it,
  // but fall back defensively (blocks → 'blocks', else 'fields') so an older/partial schema still works.
  const editorType = ref('fields')

  const values = reactive<Record<string, unknown>>({})
  const errors = reactive<Record<string, string>>({})
  const formError = ref('')
  const blockErrors = ref<BlockErrorMap>({})
  const saving = ref(false)
  const baseline = ref<Record<string, unknown>>({})
  const baseUpdatedAt = ref<number | undefined>(undefined)

  const dirty = computed(() => !valuesEqual(values, baseline.value))
  // The LAST SAVED publish status (from the baseline snapshot, not the live edited value). The editor's
  // right "live" lamp keys its draft/published decision off this — an UNSAVED dropdown switch must not flip
  // the generated-state indicator (nothing is generated until the change is saved). '' when statusless.
  const savedStatus = computed(() => (hasStatus.value ? ((baseline.value.status as string | undefined) ?? '') : ''))
  // The LAST SAVED page path (baseline, not the live edited slug). The preview iframe + the header's
  // open-in-new-tab must target a URL that actually EXISTS — an unsaved slug edit would 404 until saved;
  // on save the baseline moves and both follow to the new URL. '' when non-pageLike or never saved.
  const savedPath = computed(() => (pageLike.value ? ((baseline.value.path as string | undefined) ?? '') : ''))

  // Undo/redo: snapshot history of the whole form state. Every edit funnels through setField (block-tree
  // ops route through setField('content', …)), so that's the single capture point. A rapid burst of edits
  // to the same field coalesces into one step; the stacks reset on load/save (no undo across a save).
  const past = ref<Record<string, unknown>[]>([])
  const future = ref<Record<string, unknown>[]>([])
  const canUndo = computed(() => past.value.length > 0)
  const canRedo = computed(() => future.value.length > 0)
  let coalesceKey = ''
  let coalesceAt = 0
  const COALESCE_MS = 600
  const HISTORY_LIMIT = 100

  function recordHistory(name: string) {
    const now = Date.now()
    const coalesce = name === coalesceKey && now - coalesceAt < COALESCE_MS
    coalesceKey = name
    coalesceAt = now
    if (coalesce) return
    past.value.push(snapshot(values))
    if (past.value.length > HISTORY_LIMIT) past.value.shift()
    future.value = []
  }

  function restore(snap: Record<string, unknown>) {
    const fresh = snapshot(snap)
    for (const k of Object.keys(fresh)) values[k] = fresh[k]
    for (const k of Object.keys(values)) if (!(k in fresh)) Reflect.deleteProperty(values, k)
    for (const k of Object.keys(errors)) Reflect.deleteProperty(errors, k)
    blockErrors.value = {}
    formError.value = ''
    coalesceKey = ''
  }

  function undo() {
    if (!past.value.length) return
    future.value.push(snapshot(values))
    restore(past.value.pop()!)
  }
  function redo() {
    if (!future.value.length) return
    past.value.push(snapshot(values))
    restore(future.value.pop()!)
  }

  const renderableFields = computed<Record<string, SerializedField>>(() => {
    if (!blocksEnabled.value) return fields.value
    const { content: _content, ...rest } = fields.value
    return rest
  })

  function fieldKeys() {
    return Object.keys(fields.value)
  }

  function rebaseline(source: Record<string, unknown> | null) {
    const next = initialValues(fields.value)
    if (source) {
      for (const k of fieldKeys()) {
        const col = jsKey(k, fields.value[k]!)
        if (col in source) next[k] = source[col]
      }
    }
    // `content` is a synthesized blocks column, not a def.field — round-trip it explicitly.
    if (blocksEnabled.value) next.content = (source?.content as unknown[]) ?? []
    // `path` (the page slug) is a pageLike system column, likewise round-tripped explicitly.
    if (pageLike.value) next.path = (source?.path as string | null | undefined) ?? ''
    // '' is the "no override" form the select binds to.
    if (pageLike.value) next.layout = (source?.layout as string | null | undefined) ?? ''
    // `seo` is a JSON system column; default to an empty object so the editor can fill it in.
    if (hasSeo.value) next.seo = (source?.seo as Record<string, unknown> | undefined) ?? {}
    // `status` is a system column; a new record defaults to 'draft' (unpublished) — matches the DB default.
    if (hasStatus.value) next.status = (source?.status as string | undefined) ?? 'draft'
    for (const k of Object.keys(next)) values[k] = next[k]
    baseline.value = snapshot(values)
    // The optimistic-concurrency baseline: the `updatedAt` this load/save established, sent back on the
    // next save so a stale tab (loaded before someone else saved) is refused with 409 instead of
    // silently reverting their change. undefined for a never-saved new record.
    const stamp = source?.updatedAt
    baseUpdatedAt.value = stamp != null ? new Date(stamp as string | number).getTime() : undefined
    // A fresh load or a save establishes a new baseline — history does not span it.
    past.value = []
    future.value = []
    coalesceKey = ''
  }

  async function init() {
    const all = await useCollections().load()
    const schema = all.find((c) => c.name === collection)
    if (!schema) throw createError({ statusCode: 404, statusMessage: `Unknown collection: ${collection}` })
    fields.value = schema.fields
    fieldLayout.value = schema.fieldLayout
    mode.value = schema.mode
    translatable.value = schema.translatable
    blocksEnabled.value = schema.blocks?.enabled ?? false
    blocksAllowed.value = schema.blocks?.allowed
    pageLike.value = schema.pageLike ?? false
    hasSeo.value = schema.seo ?? false
    hasStatus.value = schema.status ?? false
    editorType.value = (schema as { editor?: string }).editor ?? (schema.blocks?.enabled ? 'blocks' : 'fields')

    let row: Record<string, unknown> | null = null
    if (mode.value === 'single') {
      row = await $fetch<Record<string, unknown> | null>(`/api/${collection}`, translatable.value ? { query: { locale: requestedLocale } } : {})
      activeLocale.value = requestedLocale
    } else if (id !== 'new') {
      row = await $fetch<Record<string, unknown>>(`/api/${collection}/${id}`)
      if (translatable.value) {
        if (typeof row?.locale === 'string') activeLocale.value = row.locale
        if (typeof row?.translationGroup === 'string') translationGroup.value = row.translationGroup
        // Supplementary (drives the LocaleBar) — never block editing if it fails.
        try {
          translations.value = await $fetch<Record<string, number | null>>(`/api/${collection}/${id}/translations`)
        } catch {
          translations.value = {}
        }
      }
    } else {
      activeLocale.value = requestedLocale
      // A new sibling translation has no id yet, so its locale→id map is resolved by GROUP. Without it the
      // LocaleBar shows every already-translated locale as a "+" create link: the copy-from source is
      // unreachable, and following that link saves a second row for an occupied locale — a duplicate-locale
      // 409 the user can't resolve. Supplementary (drives the LocaleBar) — never block editing if it fails.
      if (translatable.value && translationGroup.value) {
        try {
          translations.value = await $fetch<Record<string, number | null>>(`/api/${collection}/translations`, { query: { group: translationGroup.value } })
        } catch {
          translations.value = {}
        }
      }
    }
    rebaseline(row)

    // Supplementary dead-reference map (the editor warnings) — for any saved record, never blocks editing.
    const recordId = typeof row?.id === 'number' ? row.id : null
    if (recordId != null) {
      try {
        deadRefs.value = await $fetch<DeadRef[]>(`/api/${collection}/${recordId}/dead-refs`)
      } catch {
        deadRefs.value = []
      }
    } else {
      deadRefs.value = [] // a new (unsaved) record has no references — keep it explicit, never stale
    }
  }

  // `coalesceAs` lets a caller opt out of the default same-name coalescing: block-tree structural ops
  // (remove/move/duplicate/add) all round-trip through setField('content', …) like a text edit does, so
  // without a distinct key a delete landing inside another edit's 600ms burst would merge into it and
  // become impossible to undo on its own.
  function setField(name: string, value: unknown, coalesceAs: string = name) {
    // Capture the pre-edit state for undo (coalesced for a same-field typing burst).
    recordHistory(coalesceAs)
    // Reconcile before overwriting: keep block errors through a reorder, drop them on an edit.
    if (name === 'content') {
      blockErrors.value = reconcileBlockErrors(blockErrors.value, values.content as unknown[], value as unknown[])
    }
    values[name] = value
    formError.value = ''
    const field = fields.value[name]
    if (field) errors[name] = isFieldVisible(field, values) ? (validateField(asFieldDef(field), value) ?? '') : ''
    // A controller edit can hide sibling fields — drop their now-irrelevant advisory errors so a
    // hidden required field never shows a phantom error or blocks the save.
    for (const [n, f] of Object.entries(fields.value)) if (!isFieldVisible(f, values)) errors[n] = ''
  }

  /** Copy another locale's field/content values into this form (the LocaleBar "copy" action). Goes
   *  through setField so validation, block-error reconcile, and dirty-tracking all apply. */
  function applyFrom(source: Record<string, unknown>) {
    for (const k of fieldKeys()) {
      const col = jsKey(k, fields.value[k]!)
      if (col in source) setField(k, source[col])
    }
    if (blocksEnabled.value && 'content' in source) setField('content', source.content)
  }

  function validateAll(): boolean {
    let ok = true
    for (const [name, field] of Object.entries(fields.value)) {
      // A hidden field is exempt from validation (its `required` only applies when shown) — mirrors
      // the server's required-when-visible enforcement, so the client never blocks a valid save.
      if (!isFieldVisible(field, values)) { errors[name] = ''; continue }
      const msg = validateField(asFieldDef(field), values[name])
      errors[name] = msg ?? ''
      if (msg) ok = false
    }
    return ok
  }

  function buildBody(): Record<string, unknown> {
    const body: Record<string, unknown> = {}
    for (const k of fieldKeys()) body[jsKey(k, fields.value[k]!)] = values[k]
    if (blocksEnabled.value) body.content = values.content
    // Send the slug as the routable path; a blank slug clears the route (stored as null, not "").
    if (pageLike.value) body.path = (values.path as string) ? values.path : null
    // An unset layout is stored as NULL, never '': the render coalesces NULL to `default`, and a stored ''
    // would be indistinguishable from a name that failed to save.
    if (pageLike.value) body.layout = (values.layout as string) || null
    if (hasSeo.value) body.seo = values.seo ?? {}
    if (hasStatus.value) body.status = (values.status as string) ?? 'draft'
    // A new translatable multi record carries its locale, and links to a translation group when it is
    // a sibling translation. Existing rows keep their locale; the singleton uses the ?locale query.
    if (translatable.value && mode.value === 'multi' && id === 'new') {
      body.locale = activeLocale.value
      if (translationGroup.value) body.translationGroup = translationGroup.value
    }
    return body
  }

  function handleError(e: unknown) {
    const { statusCode, statusMessage, issues } = readFetchError(e)
    if (statusCode === 400) {
      const mapped = mapServerErrors(issues)
      for (const [k, msg] of Object.entries(mapped.fields)) errors[k] = msg
      // `content` errors are nested (content[i].props.x) and have no flat field to render them,
      // so surface a form-level banner instead of failing silently.
      blockErrors.value = parseBlockErrors(issues, values.content as unknown[])
      // A field error (e.g. the page slug) renders inline in PageFields, but that pane is unmounted while a
      // block is selected — so also raise a banner whenever there are field errors, never a silent failure.
      formError.value = mapped.form
        ?? (mapped.fields.content
          ? t('editor.fixBlockContent')
          : Object.keys(mapped.fields).length ? t('editor.fixPageFields') : '')
    } else if (statusCode === 409) {
      formError.value = statusMessage ?? t('editor.saveConflict')
    } else {
      formError.value = statusMessage ?? t('editor.saveFailed')
    }
  }

  async function submit(): Promise<SubmitResult> {
    formError.value = ''
    blockErrors.value = {}
    // Clear the whole map, not just declared-field errors: `path`/`seo`/`status` are system columns
    // (never in `fields.value`), so a stale server error on one of them would otherwise survive a
    // later successful save. `validateAll` below repopulates every declared-field error fresh.
    for (const k of Object.keys(errors)) Reflect.deleteProperty(errors, k)
    // Client-side validation failed: surface the same banner the server path raises, so the failure is
    // never silent — the offending field's inline error can sit in an unmounted pane (blocks editor).
    if (!validateAll()) {
      formError.value = t('editor.fixPageFields')
      return { ok: false }
    }
    saving.value = true
    try {
      const body = buildBody()
      // The optimistic-concurrency precondition: send the baseline `updatedAt` so a stale overwrite 409s
      // instead of silently reverting a concurrent save. Omitted for a brand-new record (no baseline).
      const ifUnmodified: Record<string, string> = baseUpdatedAt.value !== undefined ? { 'x-kestrel-if-unmodified-since': String(baseUpdatedAt.value) } : {}
      // `method` cast: Nuxt's typed `$fetch` over-constrains the method for this dynamic (template-literal)
      // admin route to GET; the runtime value is correct, only the static route type can't express it.
      const row = mode.value === 'single'
        ? await $fetch(`/api/${collection}`, { method: 'PUT' as never, body, headers: ifUnmodified, ...(translatable.value ? { query: { locale: activeLocale.value } } : {}) })
        : id === 'new'
          ? await $fetch(`/api/${collection}`, { method: 'POST' as never, body })
          : await $fetch(`/api/${collection}/${id}`, { method: 'PATCH', body, headers: ifUnmodified })
      rebaseline(row as Record<string, unknown>)
      // `record` is the saved entity at the editor's public boundary; `row` stays the DB-layer term.
      return { ok: true, record: row }
    } catch (e) {
      handleError(e)
      return { ok: false }
    } finally {
      saving.value = false
    }
  }

  const ready = init()

  return {
    collection,
    locale: activeLocale,
    translations,
    deadRefs,
    translationGroup,
    applyFrom,
    mode,
    fields,
    fieldLayout,
    renderableFields,
    translatable,
    blocksEnabled,
    blocksAllowed,
    editorType,
    pageLike,
    hasSeo,
    hasStatus,
    values,
    errors,
    formError,
    blockErrors,
    dirty,
    savedStatus,
    savedPath,
    saving,
    ready,
    setField,
    validateAll,
    // The wire body a save would send — also what a preview ticket carries, so an external tab renders
    // exactly what a save would have stored (ADR-0008).
    buildBody,
    submit,
    undo,
    redo,
    canUndo,
    canRedo,
  }
}
