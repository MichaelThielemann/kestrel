import type { AiSourceType } from '@kestrel/media'

/**
 * Default human-readable label for an EU AI Act source type — the badge text when no editor note was
 * entered. English-only on purpose: it is a fallback, not a translation layer, and a consumer who wants
 * their own wording (or locale) writes the `aiNote`, styles `.kestrel-img__ai-badge`, or reads
 * `ResolvedMedia.aiDisclosure` and renders their own element. Kept pure so it stays unit-testable.
 *
 * An unrecognised value is returned VERBATIM rather than mapped to a generic label: the column is plain
 * text at the DB level, and quietly relabelling an unknown value would state a disclosure nobody made.
 */
export function aiSourceTypeLabel(sourceType: AiSourceType | string): string {
  switch (sourceType) {
    case 'trainedAlgorithmicMedia': return 'AI-generated'
    case 'compositeWithTrainedAlgorithmicMedia': return 'Contains AI-generated content'
    case 'algorithmicallyEnhanced': return 'AI-edited'
    default: return sourceType
  }
}
