import type { Edit } from "./report.ts";

export interface ApplyResult {
  text: string;
  applied: Edit[];
  conflicted: Edit[];
}

/**
 * Splices non-overlapping edits into `source`, in one pass, from the end of the file backwards.
 * Two independent rules can both target the same construct — one replacing a value inside it, the
 * other replacing or deleting the whole thing — so an edit that fully contains an already-accepted
 * one takes its place instead of being dropped by it; any other overlap is a real conflict and the
 * later-processed (lower-start) edit is dropped.
 */
export function applyEdits(source: string, edits: readonly Edit[]): ApplyResult {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  const accepted: Edit[] = [];
  const conflicted: Edit[] = [];
  for (const edit of sorted) {
    const prev = accepted.at(-1);
    if (prev === undefined || edit.end <= prev.start) {
      accepted.push(edit);
      continue;
    }
    if (edit.start <= prev.start && edit.end >= prev.end) {
      conflicted.push(accepted.pop()!);
      accepted.push(edit);
      continue;
    }
    conflicted.push(edit);
  }
  let text = source;
  for (const edit of accepted) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return { text, applied: [...accepted].reverse(), conflicted };
}
