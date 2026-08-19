<script setup lang="ts">
// The editor "Ampel": TWO lamps side by side in the action bar, each a dot + ONE word + a details tooltip.
//   LEFT  — the SAVE / draft lifecycle of THIS record (its local vs. stored state):
//             amber  — work in flight: saving, or unsaved local changes not yet in the DB
//             blue   — saved but a Draft, so it is intentionally NOT on the live/static site
//             green  — saved and (for status collections) published, or just saved (no status field)
//   RIGHT — the GENERATED state of this record's static page (pageLike collections only), read from
//           `publish_status` via `/api/publish-status`:
//             green   — the route's last publish succeeded (the file is live; the tooltip names local vs S3)
//             amber   — published but no success row yet — a republish is in flight ("Generating…")
//             neutral — this environment never produces the file (dev / static output off) → "Not built"
//             red     — the last publish for the route errored (render / write / S3) — details in the tooltip
//             blue    — a Draft: intentionally not generated, so there is no live file
import type { PublishStatusData } from '../composables/usePublishStatus'

const props = defineProps<{
  dirty: boolean
  saving?: boolean
  hasStatus?: boolean
  /** The LIVE (possibly unsaved) form status — drives the left lamp's word. */
  status?: string
  /** The last SAVED publish status — drives the RIGHT lamp's draft/published decision, so an unsaved
   *  dropdown switch never flips the generated-state indicator. Falls back to `status` when absent. */
  savedStatus?: string
  /** Only pageLike collections produce a static page → only they get the right (live) lamp. */
  pageLike?: boolean
  /** The record's last publish outcome (from `/api/publish-status`); null/absent while unknown. */
  live?: PublishStatusData | null
}>()
const { t, lang } = useT()

// LEFT lamp — save + publish state. `word` is the single label shown; `detail` is the tooltip sentence.
const save = computed<{ tone: 'amber' | 'green' | 'blue'; word: string; detail: string }>(() => {
  if (props.saving) return { tone: 'amber', word: t('editorStatus.word.saving'), detail: t('editorStatus.detail.saving') }
  if (props.dirty) return { tone: 'amber', word: t('editorStatus.word.unsaved'), detail: t('editorStatus.detail.unsaved') }
  if (props.hasStatus && props.status === 'draft') return { tone: 'blue', word: t('editorStatus.word.draft'), detail: t('editorStatus.detail.draft') }
  if (props.hasStatus) return { tone: 'green', word: t('editorStatus.word.published'), detail: t('editorStatus.detail.published') }
  return { tone: 'green', word: t('editorStatus.word.saved'), detail: t('editorStatus.detail.saved') }
})

const updatedAtLabel = computed(() => {
  const at = props.live?.updatedAt
  if (!at) return ''
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  return t('editorStatus.live.updatedAt', { time: d.toLocaleString(lang.value) })
})

// RIGHT lamp — the live / generated state of this record's static page. Only a SAVED pageLike record with a
// resolved route has one (a non-pageLike collection produces no static page; an unsaved `new` record leaves
// `live.route` null → no right lamp until the record actually has a page).
const live = computed<{ tone: 'green' | 'red' | 'amber' | 'blue' | 'neutral'; word: string; detail: string; when?: string; error?: string } | null>(() => {
  if (props.pageLike !== true || !props.live?.route) return null
  // Key the draft/published decision off the SAVED status, not the live form value: an unsaved dropdown
  // switch must not move the generated-state indicator. Switching a live page → Draft keeps it "Live" (the
  // file stays on the server until the save prunes it); switching a saved Draft → Published keeps it "Not
  // live" (nothing is generated until the publish is actually saved). A DISTINCT word from the left lamp's
  // "Draft" so the two lamps read as two signals (save-state vs generated-state), not a repeat.
  const saved = props.savedStatus ?? props.status
  if (props.hasStatus && saved === 'draft')
    return { tone: 'blue', word: t('editorStatus.word.notLive'), detail: t('editorStatus.live.draft') }
  const s = props.live?.status ?? null
  if (s === 'error')
    return { tone: 'red', word: t('editorStatus.word.error'), detail: t('editorStatus.live.error'), when: updatedAtLabel.value, error: props.live?.error ?? '' }
  if (s === 'success') {
    // Saved after the last publish: the file IS live, but it is an older version of this record. Saving no
    // longer republishes (ADR-0008), so this is the normal state of a page being worked on — amber, not red.
    if (props.live?.pending) {
      return { tone: 'amber', word: t('editorStatus.word.outdated'), detail: t('editorStatus.live.outdated'), when: updatedAtLabel.value }
    }
    // Where the file actually landed — surface local vs S3 in the tooltip ("stored on S3").
    const onS3 = (props.live?.target ?? props.live?.driver) === 's3'
    return { tone: 'green', word: t('editorStatus.word.live'), detail: t(onS3 ? 'editorStatus.live.liveS3' : 'editorStatus.live.liveLocal'), when: updatedAtLabel.value }
  }
  // No success row yet. Only an explicit generates:false means "this environment produces nothing" (dev /
  // static output off) → a calm neutral "Not built". Unknown (undefined) → assume a publish is in flight.
  if (props.live?.generates === false)
    return { tone: 'neutral', word: t('editorStatus.word.notBuilt'), detail: t('editorStatus.live.notBuilt') }
  // Never published, and a save no longer enqueues anything (ADR-0008) — so nothing is in flight and
  // nothing will be until someone presses Publish. Reporting progress here would point the user at a
  // spinner instead of at the one action that changes it. With `publishOnSave` a save DOES republish, so
  // there the in-flight reading is the right one.
  if (props.live?.neverPublished && !props.live?.publishOnSave)
    return { tone: 'blue', word: t('editorStatus.word.notPublished'), detail: t('editorStatus.live.notPublished') }
  return { tone: 'amber', word: t('editorStatus.word.generating'), detail: t('editorStatus.live.pending') }
})
</script>

<template>
  <span class="editor-status-group">
    <!-- Polite live region: announces save-state transitions (Saved → Unsaved → Saving…) to screen readers.
         Visually hidden; not a tooltip. -->
    <span class="editor-status-sr" role="status" aria-live="polite">{{ save.detail }}</span>

    <KestrelUiTooltip side="bottom">
      <!-- A focusable status indicator, NOT a <button>: it has no action, and a button whose accessible
           name contains "Saved"/"Unsaved" would collide with `getByRole('button', {name:'Save'})`. aria-label
           leads with the visible word so it stays part of the accessible name, then adds the detail for AT. -->
      <span class="editor-status" tabindex="0" :data-tone="save.tone" :aria-label="`${save.word} — ${save.detail}`">
        <span class="editor-status__dot" aria-hidden="true" />
        <span class="editor-status__word">{{ save.word }}</span>
      </span>
      <template #content>
        <span class="editor-status-tip">
          <strong class="editor-status-tip__detail">{{ save.detail }}</strong>
        </span>
      </template>
    </KestrelUiTooltip>

    <KestrelUiTooltip v-if="live" side="bottom">
      <span class="editor-status-live" tabindex="0" :data-tone="live.tone" :aria-label="`${live.word} — ${live.detail}`">
        <span class="editor-status-live__dot" aria-hidden="true" />
        <span class="editor-status-live__word">{{ live.word }}</span>
      </span>
      <template #content>
        <span class="editor-status-tip">
          <strong class="editor-status-tip__detail">{{ live.detail }}</strong>
          <span v-if="live.when" class="editor-status-tip__when">{{ live.when }}</span>
          <span v-if="live.tone === 'red' && live.error" class="editor-status-tip__err">{{ live.error }}</span>
        </span>
      </template>
    </KestrelUiTooltip>
  </span>
</template>

<style scoped lang="scss">
.editor-status-group {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
}

// Visually-hidden polite status region (mirrors the ui sr-only mixin; admin can't @use a ui-layer scss).
.editor-status-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

// Both lamps are focusable status indicators (tabindex spans, not buttons) so the tooltip opens on hover
// AND keyboard focus, without adding a "Save"-named button that would clash with Save-button selectors.
.editor-status,
.editor-status-live {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  cursor: help;

  &__dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: var(--radius-full);
    background: var(--_tone, var(--color-text-subtle));
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--_tone, transparent) 22%, transparent);
    flex: none;
  }
  &__word {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    white-space: nowrap;
  }

  &[data-tone='amber'] {
    --_tone: var(--color-warning);
  }
  &[data-tone='green'] {
    --_tone: var(--color-success);
  }
  &[data-tone='blue'] {
    --_tone: var(--color-primary);
  }
  &[data-tone='red'] {
    --_tone: var(--color-danger);
  }
  &[data-tone='neutral'] {
    --_tone: var(--color-text-subtle);
  }
  &:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }
}
</style>

<!-- Not scoped: the tooltip content is teleported to <body> by Reka, where a scoped data-v selector no
     longer matches (same reason UiTooltip itself keeps global styles). -->
<style lang="scss">
.editor-status-tip {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);

  &__when {
    color: var(--color-text-muted);
    font-size: var(--text-xs);
  }
  &__err {
    color: var(--color-danger);
    font-size: var(--text-xs);
    word-break: break-word;
  }
}
</style>
