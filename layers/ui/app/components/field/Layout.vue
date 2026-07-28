<script setup lang="ts">
import { computed } from 'vue'
import FieldRenderer from './Renderer.vue'
import FieldDeadRefNote from './DeadRefNote.vue'
import { isFieldVisible } from '../../../../fields/app/utils/condition'
import { resolveLocalized } from '../../utils/localized'
import type { FieldDef, Localized } from '../../../../core/server/utils/defineCollection'
import type { LayoutNode, LayoutTrack } from '../../../../core/server/utils/field-layout'

// The ONE shared field-list renderer, reused by every field-list surface (collection page fields, block
// fields, repeater sub-fields). A FRAGMENT (no wrapper root) so its rows/groups drop straight into the
// caller's existing gapped flex column — the per-context vertical rhythm is preserved. Imports are
// explicit (not auto-imported) because this component also renders inside Repeater, which is exercised
// by the auto-import-free `dom` test runner.
const props = defineProps<{
  layout?: LayoutNode[]
  fields: Record<string, FieldDef>
  values: Record<string, unknown>
  errors?: Record<string, string>
  /** Field keys holding a stale reference — shown as a non-blocking note under the field. Omit to disable. */
  deadFields?: Set<string>
  locale: string
  disabled?: boolean
}>()
const emit = defineEmits<{ update: [name: string, value: unknown] }>()
const { lang } = useT()

// No author layout → the historical one-field-per-row flow, expressed as single-field full-width rows, so
// both cases flow through a single render path.
const nodes = computed<LayoutNode[]>(() =>
  props.layout ?? Object.keys(props.fields).map((f) => ({ kind: 'row', fields: [f], tracks: [1] })),
)

// A render-ready row: only the cells that are present + visible, with the grid columns rebuilt from just
// their tracks. A field hidden by its `condition` must collapse its grid TRACK — otherwise the resolved
// row would still reserve it and the surviving cells auto-place into the wrong columns. This is the ONE
// place that turns the engine's neutral tracks (weight numbers / length strings) into CSS-grid columns.
interface RenderRow { fields: string[]; cols: string }
type RenderNode = { kind: 'row'; row: RenderRow } | { kind: 'group'; label: Localized; rows: RenderRow[] }

const isVisible = (name: string) => !!props.fields[name] && isFieldVisible(props.fields[name]!, props.values)
const trackToCss = (t: LayoutTrack): string => (typeof t === 'number' ? `${t}fr` : t)

function pruneRow(fields: string[], tracks: LayoutTrack[] = []): RenderRow {
  const kept: string[] = []
  const cols: string[] = []
  fields.forEach((name, i) => {
    if (isVisible(name)) { kept.push(name); cols.push(trackToCss(tracks[i] ?? 1)) }
  })
  return { fields: kept, cols: cols.join(' ') || '1fr' }
}

const renderNodes = computed<RenderNode[]>(() =>
  nodes.value.map((node) =>
    node.kind === 'group'
      ? { kind: 'group', label: node.label, rows: node.rows.map((r) => pruneRow(r.fields, r.tracks)) }
      : { kind: 'row', row: pruneRow(node.fields, node.tracks) },
  ),
)
</script>

<template>
  <template v-for="(node, i) in renderNodes" :key="i">
    <!-- Named group: a labelled fieldset wrapping its stacked rows (one level deep). -->
    <fieldset v-if="node.kind === 'group'" class="ui-field-group">
      <legend class="ui-field-group__legend">{{ resolveLocalized(node.label, lang) }}</legend>
      <div
        v-for="(row, r) in node.rows"
        :key="r"
        class="ui-field-row"
        :style="{ '--ui-field-cols': row.cols }"
      >
        <div v-for="fname in row.fields" :key="fname" class="ui-field-cell">
          <FieldRenderer
            :field="fields[fname]!"
            :name="fname"
            :locale="locale"
            :disabled="disabled"
            :error="errors?.[fname] || null"
            :model-value="values[fname]"
            @update:model-value="(v) => emit('update', fname, v)"
          />
          <FieldDeadRefNote v-if="deadFields" :show="deadFields.has(fname)" />
        </div>
      </div>
    </fieldset>

    <!-- Plain row: the same grid + cell markup as a group's row, just without the fieldset wrapper. -->
    <div v-else class="ui-field-row" :style="{ '--ui-field-cols': node.row.cols }">
      <div v-for="fname in node.row.fields" :key="fname" class="ui-field-cell">
        <FieldRenderer
          :field="fields[fname]!"
          :name="fname"
          :locale="locale"
          :disabled="disabled"
          :error="errors?.[fname] || null"
          :model-value="values[fname]"
          @update:model-value="(v) => emit('update', fname, v)"
        />
        <FieldDeadRefNote v-if="deadFields" :show="deadFields.has(fname)" />
      </div>
    </div>
  </template>
</template>

<style lang="scss">
// Grid track set from the CUSTOM PROPERTY (not grid-template-columns directly) so the responsive collapse
// below — a plain stylesheet rule — wins over the inline value.
.ui-field-row {
  display: grid;
  grid-template-columns: var(--ui-field-cols, 1fr);
  gap: var(--space-3);
  align-items: start;
  min-inline-size: 0;
}
.ui-field-cell {
  display: flex;
  flex-direction: column;
  gap: var(--space-1); // separates a field from its stale-reference note; inert for a single-child cell
  min-inline-size: 0; // let inputs shrink inside a grid track (the repeater idiom)
}
.ui-field-group {
  margin: 0;
  padding: 0;
  border: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.ui-field-group__legend {
  padding: 0;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text-muted);
}
// Responsive collapse to a single column (the repo's existing breakpoint). Container queries are a follow-up.
@media (max-width: 48rem) {
  .ui-field-row { grid-template-columns: 1fr; }
}
</style>
