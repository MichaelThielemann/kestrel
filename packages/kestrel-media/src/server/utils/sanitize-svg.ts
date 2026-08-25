import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'

const purify = createDOMPurify(new JSDOM('').window as unknown as Parameters<typeof createDOMPurify>[0])

/** Strips scripts/event handlers from an uploaded SVG before it is stored. */
export function sanitizeSvg(svg: string): string {
  return purify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject'],
    FORBID_ATTR: ['onload', 'onerror', 'onclick'],
  })
}
