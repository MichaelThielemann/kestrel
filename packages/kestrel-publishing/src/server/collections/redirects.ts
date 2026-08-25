import { buildCollection, defineCollection  } from '@kestrel/core'
import { compileRedirects } from '../utils/publish/redirect-rules.js'

/**
 * Editorial SEO redirects, kept in the DB rather than in config because they outlive a deployment and are
 * the editors' to change. Saving compiles them into the `redirects.json` artifact the edge serves —
 * Kestrel itself never redirects at runtime (there is no live public SSR to redirect in).
 * @public
 */
const built = buildCollection(defineCollection({
  name: 'redirects',
  mode: 'single',
  builtin: true,
  label: { singular: { en: 'Redirects', de: 'Weiterleitungen' }, plural: { en: 'Redirects', de: 'Weiterleitungen' } },
  icon: 'external-link',
  fields: {
    rules: {
      type: 'repeater',
      // Row order is priority and there is no per-field help text in the editor, so the rule and the
      // wildcard syntax have to ride along in the labels — this is the only place an editor sees them.
      label: {
        en: 'Rules — the first matching rule wins, so put the most specific one first',
        de: 'Regeln — die erste passende Regel gewinnt, spezifische zuerst',
      },
      options: {
        fields: {
          from: {
            type: 'text',
            required: true,
            label: {
              en: 'From — old path, * = one segment, ** = several',
              de: 'Von — alter Pfad, * = ein Segment, ** = mehrere',
            },
          },
          to: {
            type: 'text',
            required: true,
            label: {
              en: 'To — new path or full URL, $1/$2 = the wildcards',
              de: 'Nach — neuer Pfad oder vollständige URL, $1/$2 = die Platzhalter',
            },
          },
          status: {
            type: 'choice',
            label: { en: 'Status', de: 'Status' },
            options: {
              choices: [
                { label: { en: '301 — permanent', de: '301 — dauerhaft' }, value: '301' },
                { label: { en: '302 — temporary', de: '302 — vorübergehend' }, value: '302' },
                { label: { en: '307 — temporary, keeps the method', de: '307 — vorübergehend, Methode bleibt' }, value: '307' },
                { label: { en: '308 — permanent, keeps the method', de: '308 — dauerhaft, Methode bleibt' }, value: '308' },
              ],
              display: 'select',
            },
            default: '301',
          },
        },
        fieldLayout: [['from|2', 'to|2', 'status|1']],
      },
    },
  },
  // A row that cannot compile must never reach the DB: it would leave the artifact stale on every
  // subsequent save and fail the prerender of `/redirects.json`. Zod validates one field at a time and
  // cannot see that `to: '/x/$2'` needs a second wildcard in `from`, so the check lands here — before the
  // write, as a field-scoped 400 the editor renders on the repeater.
  validate: (record) => {
    try {
      compileRedirects(record.rules)
      return []
    } catch (error) {
      return [{ path: ['rules'], message: (error as Error).message }]
    }
  },
}))

/** The `redirects` Drizzle table.
 * @public
 */
export const redirects = built.table
export default built
