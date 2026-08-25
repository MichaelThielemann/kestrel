/** Escape LIKE metacharacters so a search for "a_b" / "%" matches them literally (paired with ESCAPE '\').
 * @public
 */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (ch) => `\\${ch}`)
