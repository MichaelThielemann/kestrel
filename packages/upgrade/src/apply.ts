import type { Edit } from "./report.ts";

export interface ApplyResult {
  text: string;
  applied: Edit[];
  conflicted: Edit[];
}

/** Splices non-overlapping edits into `source`, in one pass, from the end of the file backwards. Overlapping edits are dropped so an earlier, already-applied one is never corrupted; the caller re-runs the dropped rule on the result. */
export function applyEdits(source: string, edits: readonly Edit[]): ApplyResult {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  const applied: Edit[] = [];
  const conflicted: Edit[] = [];
  let text = source;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of sorted) {
    if (edit.end > lastStart) {
      conflicted.push(edit);
      continue;
    }
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    applied.push(edit);
    lastStart = edit.start;
  }
  return { text, applied: applied.reverse(), conflicted };
}
