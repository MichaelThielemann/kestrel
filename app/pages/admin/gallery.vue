<script setup lang="ts">
import { reactive } from 'vue'
import type { FieldDef } from '@kestrel/core'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })

const { t } = useT()

interface Demo { name: string; field: FieldDef; initial: unknown }

const choices = [{ label: 'Draft', value: 'draft' }, { label: 'Published', value: 'published' }, { label: 'Archived', value: 'archived' }]

const demos: Demo[] = [
  { name: 'Text', field: { type: 'text', options: { maxLength: 80 } }, initial: 'Hello world' },
  { name: 'Text (multiline)', field: { type: 'text', options: { multiline: true } }, initial: 'First line\nSecond line' },
  { name: 'Number', field: { type: 'number', options: { min: 0, max: 100 } }, initial: 42 },
  { name: 'Number (decimal)', field: { type: 'number', options: { decimals: 2, min: 0 } }, initial: 19.99 },
  { name: 'Boolean', field: { type: 'boolean' }, initial: true },
  { name: 'JSON', field: { type: 'json' }, initial: { hello: 'world', items: [1, 2, 3] } },
  { name: 'Choice (dropdown)', field: { type: 'choice', options: { choices } }, initial: 'draft' },
  { name: 'Choice (buttons)', field: { type: 'choice', options: { display: 'buttons', choices } }, initial: 'published' },
  { name: 'Choice (multiple)', field: { type: 'choice', options: { multiple: true, choices } }, initial: ['draft', 'archived'] },
  { name: 'Date', field: { type: 'datetime', options: { precision: 'date' } }, initial: '2026-06-06' },
  { name: 'Datetime', field: { type: 'datetime', options: { precision: 'datetime' } }, initial: '2026-06-06T10:30:00' },
  { name: 'Time', field: { type: 'datetime', options: { precision: 'time' } }, initial: '10:30' },
  { name: 'Date range', field: { type: 'datetime', options: { precision: 'date', range: true } }, initial: { start: '2026-06-01', end: '2026-06-30' } },
  { name: 'Richtext', field: { type: 'richtext' }, initial: '<p>Hello <strong>world</strong> — try the toolbar.</p>' },
  { name: 'Relation (single → posts)', field: { type: 'relation', relation: { collection: 'posts', labelField: 'title' } }, initial: null },
  { name: 'Relation (multiple → posts)', field: { type: 'relation', relation: { collection: 'posts', many: true, labelField: 'title' } }, initial: [] },
  { name: 'Media (single)', field: { type: 'media', options: { accept: 'image' } }, initial: null },
  { name: 'Media (multiple)', field: { type: 'media', options: { multiple: true } }, initial: [] },
  { name: 'Link', field: { type: 'link' }, initial: null },
  { name: 'Link (URL only)', field: { type: 'link', options: { types: ['external'] } }, initial: null },
  { name: 'Link (internal → posts)', field: { type: 'link', options: { types: ['internal'], collections: ['posts'] } }, initial: null },
  { name: 'Repeater (label + URL)', field: { type: 'repeater', options: { fields: { label: { type: 'text' }, url: { type: 'link', options: { types: ['external'] } } } } }, initial: [{ label: 'Home', url: { type: 'external', url: 'https://example.com' } }] },
  { name: 'Repeater (nested)', field: { type: 'repeater', options: { fields: { title: { type: 'text' }, items: { type: 'repeater', options: { fields: { name: { type: 'text' } } } } } } }, initial: [] },
]

const models = reactive(demos.map((d) => d.initial))
</script>

<template>
  <section class="gallery">
    <header class="gallery__head">
      <h1 class="gallery__title">{{ t('gallery.title') }}</h1>
      <p class="gallery__lede">{{ t('gallery.lede.before') }}<code>/api/posts/options</code>{{ t('gallery.lede.after') }}</p>
    </header>

    <div class="gallery__grid">
      <article v-for="(d, i) in demos" :key="d.name" class="gallery__row">
        <KestrelFieldRenderer v-model="models[i]" :field="d.field" :name="d.name" locale="en" />
        <pre class="gallery__value">{{ JSON.stringify(models[i]) }}</pre>
      </article>
    </div>
  </section>
</template>

<style lang="scss">
.gallery {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  overflow-y: auto;

  &__title { font-size: var(--text-xl); font-weight: var(--weight-bold); }
  &__lede { color: var(--color-text-muted); margin-top: var(--space-1); }
  &__grid {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }
  &__row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 16rem);
    gap: var(--space-4);
    align-items: start;
    padding-bottom: var(--space-5);
    border-bottom: 1px solid var(--color-border);
  }
  &__value {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
}
</style>
