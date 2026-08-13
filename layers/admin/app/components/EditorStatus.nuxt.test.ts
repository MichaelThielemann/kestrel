import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import EditorStatus from './EditorStatus.vue'

type W = Awaited<ReturnType<typeof mountSuspended>>
const tone = (w: W) => w.find('.editor-status').attributes('data-tone')
const word = (w: W) => w.find('.editor-status__word').text()
const liveTone = (w: W) => w.find('.editor-status-live').attributes('data-tone')
const liveWord = (w: W) => w.find('.editor-status-live__word').text()
const hasLive = (w: W) => w.find('.editor-status-live').exists()

describe('EditorStatus — left dot (change/draft lifecycle, unchanged)', () => {
  it('amber while there are unsaved changes', async () => {
    const w = await mountSuspended(EditorStatus, { props: { dirty: true } })
    expect(tone(w)).toBe('amber')
  })

  it('amber while saving, even over a draft status', async () => {
    const w = await mountSuspended(EditorStatus, { props: { dirty: false, saving: true, hasStatus: true, status: 'draft' } })
    expect(tone(w)).toBe('amber')
  })

  it('blue for a saved draft (not on the live site)', async () => {
    const w = await mountSuspended(EditorStatus, { props: { dirty: false, hasStatus: true, status: 'draft' } })
    expect(tone(w)).toBe('blue')
  })

  it('green for a saved, published page', async () => {
    const w = await mountSuspended(EditorStatus, { props: { dirty: false, hasStatus: true, status: 'published' } })
    expect(tone(w)).toBe('green')
  })

  it('green (saved) for a clean collection without a status field', async () => {
    const w = await mountSuspended(EditorStatus, { props: { dirty: false, hasStatus: false } })
    expect(tone(w)).toBe('green')
  })

  it('renders a single WORD (not a phrase) per state', async () => {
    const unsaved = await mountSuspended(EditorStatus, { props: { dirty: true } })
    expect(word(unsaved)).toBe('Unsaved')
    const saving = await mountSuspended(EditorStatus, { props: { dirty: false, saving: true } })
    expect(word(saving)).toBe('Saving…')
    const draft = await mountSuspended(EditorStatus, { props: { dirty: false, hasStatus: true, status: 'draft' } })
    expect(word(draft)).toBe('Draft')
    const published = await mountSuspended(EditorStatus, { props: { dirty: false, hasStatus: true, status: 'published' } })
    expect(word(published)).toBe('Published')
    const saved = await mountSuspended(EditorStatus, { props: { dirty: false, hasStatus: false } })
    expect(word(saved)).toBe('Saved')
  })

  it('shows no right dot for a non-pageLike record (default / pageLike:false)', async () => {
    const a = await mountSuspended(EditorStatus, { props: { dirty: false, hasStatus: true, status: 'published' } })
    expect(hasLive(a)).toBe(false)
    const b = await mountSuspended(EditorStatus, { props: { dirty: false, pageLike: false, hasStatus: true, status: 'published', live: { route: '/x', status: 'success' } } })
    expect(hasLive(b)).toBe(false)
  })

  it('shows no right dot for an unsaved (new) pageLike record — no resolved route yet', async () => {
    const w = await mountSuspended(EditorStatus, {
      props: { dirty: false, pageLike: true, hasStatus: true, status: 'published', live: { route: null, status: null } },
    })
    expect(hasLive(w)).toBe(false)
  })
})

describe('EditorStatus — right dot (live / generated state, pageLike only)', () => {
  it('green when a published page was last published successfully', async () => {
    const w = await mountSuspended(EditorStatus, {
      props: { dirty: false, pageLike: true, hasStatus: true, status: 'published', live: { route: '/about', status: 'success' } },
    })
    expect(liveTone(w)).toBe('green')
  })

  it('red when the last publish for the route errored', async () => {
    const w = await mountSuspended(EditorStatus, {
      props: { dirty: false, pageLike: true, hasStatus: true, status: 'published', live: { route: '/about', status: 'error', error: 'S3 403' } },
    })
    expect(liveTone(w)).toBe('red')
  })

  it('amber when published in the DB but no success row yet (e.g. dev / in flight)', async () => {
    const w = await mountSuspended(EditorStatus, {
      props: { dirty: false, pageLike: true, hasStatus: true, status: 'published', live: { route: '/about', status: null } },
    })
    expect(liveTone(w)).toBe('amber')
  })

  // Saving no longer republishes, so "published page, newer saved content" is the normal working state.
  it('amber "Outdated" when the record was saved after its page was last published', async () => {
    const w = await mountSuspended(EditorStatus, {
      props: { dirty: false, pageLike: true, hasStatus: true, status: 'published', live: { route: '/about', status: 'success', pending: true } },
    })
    expect(liveTone(w)).toBe('amber')
    expect(liveWord(w)).toBe('Outdated')
  })

  it('goes back to green once the page is published again', async () => {
    const w = await mountSuspended(EditorStatus, {
      props: { dirty: false, pageLike: true, hasStatus: true, status: 'published', live: { route: '/about', status: 'success', pending: false } },
    })
    expect(liveTone(w)).toBe('green')
  })

  it('a failed publish stays red even with newer saved changes — the error is the bigger signal', async () => {
    const w = await mountSuspended(EditorStatus, {
      props: { dirty: false, pageLike: true, hasStatus: true, status: 'published', live: { route: '/about', status: 'error', error: 'S3 403', pending: true } },
    })
    expect(liveTone(w)).toBe('red')
  })

  it('blue for a draft (intentionally not generated), regardless of any stale status row', async () => {
    const w = await mountSuspended(EditorStatus, {
      props: { dirty: false, pageLike: true, hasStatus: true, status: 'draft', live: { route: '/about', status: 'success' } },
    })
    expect(liveTone(w)).toBe('blue')
  })

  it('green for a pageLike collection without a status field once a success row exists', async () => {
    const w = await mountSuspended(EditorStatus, {
      props: { dirty: false, pageLike: true, hasStatus: false, live: { route: '/about', status: 'success' } },
    })
    expect(liveTone(w)).toBe('green')
  })

  it('is independent of the left dot: dirty (amber left) over a successfully published page (green right)', async () => {
    const w = await mountSuspended(EditorStatus, {
      props: { dirty: true, pageLike: true, hasStatus: true, status: 'published', live: { route: '/about', status: 'success' } },
    })
    expect(tone(w)).toBe('amber')
    expect(liveTone(w)).toBe('green')
  })

  it('shows a single WORD next to the right dot too', async () => {
    const live = await mountSuspended(EditorStatus, {
      props: { dirty: false, pageLike: true, hasStatus: true, status: 'published', live: { route: '/about', status: 'success', target: 's3', generates: true } },
    })
    expect(liveWord(live)).toBe('Live')

    const generating = await mountSuspended(EditorStatus, {
      props: { dirty: false, pageLike: true, hasStatus: true, status: 'published', live: { route: '/about', status: null, generates: true } },
    })
    expect(liveTone(generating)).toBe('amber')
    expect(liveWord(generating)).toBe('Generating…')

    const err = await mountSuspended(EditorStatus, {
      props: { dirty: false, pageLike: true, hasStatus: true, status: 'published', live: { route: '/about', status: 'error', error: 'S3 403', generates: true } },
    })
    expect(liveWord(err)).toBe('Error')
  })

  it('neutral "Not built" when this environment does not generate (dev / static output off)', async () => {
    const w = await mountSuspended(EditorStatus, {
      props: { dirty: false, pageLike: true, hasStatus: true, status: 'published', live: { route: '/about', status: null, generates: false } },
    })
    expect(liveTone(w)).toBe('neutral')
    expect(liveWord(w)).toBe('Not built')
  })

  it('still amber (generating) when the generate-flag is unknown (undefined), never neutral', async () => {
    // only an explicit generates:false means "this env produces nothing"; unknown → assume a publish is in flight
    const w = await mountSuspended(EditorStatus, {
      props: { dirty: false, pageLike: true, hasStatus: true, status: 'published', live: { route: '/about', status: null } },
    })
    expect(liveTone(w)).toBe('amber')
  })

  it('a saved draft shows DISTINCT words on the two lamps (left "Draft", right "Not live") — not "Draft Draft"', async () => {
    const w = await mountSuspended(EditorStatus, {
      props: { dirty: false, pageLike: true, hasStatus: true, status: 'draft', live: { route: '/about', status: 'success', generates: true } },
    })
    expect(word(w)).toBe('Draft') // left = save state
    expect(liveTone(w)).toBe('blue')
    expect(liveWord(w)).toBe('Not live') // right = generated state, a different word
  })

  it('switching a still-live page to Draft but NOT saving keeps the right lamp green (the file is still live)', async () => {
    // Saved status is 'published' (the file is live); the dropdown is switched to draft but not saved yet.
    // The right lamp keys off the SAVED status, so it stays green "Live" until the save prunes the file.
    const w = await mountSuspended(EditorStatus, {
      props: { dirty: true, pageLike: true, hasStatus: true, status: 'draft', savedStatus: 'published', live: { route: '/about', status: 'success', generates: true } },
    })
    expect(word(w)).toBe('Unsaved') // left reflects the unsaved change
    expect(liveTone(w)).toBe('green')
    expect(liveWord(w)).toBe('Live') // right still reflects the live file
  })

  it('switching a saved DRAFT to Published but NOT saving does NOT claim "Live" (nothing generated yet)', async () => {
    // The mirror bug: saved status is 'draft' (never generated), the dropdown is switched to published but
    // not saved. The right lamp must key off the SAVED status and stay "Not live", not read the new intent
    // against a stale/old row and jump to green "Live".
    const w = await mountSuspended(EditorStatus, {
      props: { dirty: true, pageLike: true, hasStatus: true, status: 'published', savedStatus: 'draft', live: { route: '/about', status: 'success', generates: true } },
    })
    expect(word(w)).toBe('Unsaved') // left reflects the unsaved change
    expect(liveTone(w)).toBe('blue')
    expect(liveWord(w)).toBe('Not live') // right stays "Not live" until the publish is actually saved+generated
  })
})

describe('EditorStatus — accessibility', () => {
  it('the visible word is contained in each lamp\'s accessible name (WCAG 2.5.3 Label-in-Name)', async () => {
    const w = await mountSuspended(EditorStatus, {
      props: { dirty: false, pageLike: true, hasStatus: true, status: 'published', live: { route: '/about', status: null, generates: true } },
    })
    // right lamp visible word "Generating…" must appear in its aria-label, even though the detail sentence differs
    const rightLabel = w.find('.editor-status-live').attributes('aria-label') ?? ''
    expect(rightLabel).toContain('Generating…')
    const leftLabel = w.find('.editor-status').attributes('aria-label') ?? ''
    expect(leftLabel).toContain('Published')
  })

  it('renders the lamps as focusable status indicators, NOT buttons (a "Saved"-named button would clash with Save-button selectors)', async () => {
    const w = await mountSuspended(EditorStatus, {
      props: { dirty: false, pageLike: true, hasStatus: true, status: 'published', live: { route: '/about', status: 'success', generates: true } },
    })
    expect(w.find('button').exists()).toBe(false)
    expect(w.find('.editor-status').element.tagName).toBe('SPAN')
    expect(w.find('.editor-status').attributes('tabindex')).toBe('0') // still keyboard-focusable for the tooltip
    expect(w.find('.editor-status-live').element.tagName).toBe('SPAN')
  })

  it('announces save-state changes via a polite live region', async () => {
    const w = await mountSuspended(EditorStatus, { props: { dirty: true } })
    const live = w.find('[role="status"]')
    expect(live.exists()).toBe(true)
    expect(live.attributes('aria-live')).toBe('polite')
    expect(live.text()).toContain('unsaved') // mirrors the save-state detail
  })
})
