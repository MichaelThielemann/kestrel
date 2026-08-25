/** Parses `text` as JSON without throwing — the `json` field widget's raw-text edit path.
 * @public
 */
export function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}
