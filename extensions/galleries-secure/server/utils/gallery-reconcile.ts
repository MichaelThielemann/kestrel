// Server-side reconcile of a gallery namespace against its index: which stored `.bin` blobs are no longer
// referenced (abandoned/partial uploads) and can be pruned. The blobIds are PLAINTEXT in the index (only the
// names/folders are sealed), so the server can compute this without the gallery key — pruning strays reveals
// nothing about content, so it's zero-knowledge-safe. Pure → node-tested; `tree.put` does the listing + delete.

/** Namespace keys (from `listPrefix`) whose filename is a `.bin` blob NOT in `liveBlobIds`. Never returns
 *  `index.json` or any non-`.bin` key, so only stray image ciphertext is ever pruned. */
export function orphanBlobKeys(existingKeys: readonly string[], liveBlobIds: Iterable<string>): string[] {
  const live = new Set(liveBlobIds)
  return existingKeys.filter((key) => {
    const name = key.slice(key.lastIndexOf('/') + 1)
    return name.endsWith('.bin') && !live.has(name)
  })
}

/**
 * Of the orphan candidates, the keys actually safe to prune: only those older than the grace window. A blob
 * uploaded but not yet added to the index (an upload racing a concurrent index write from another tab / the
 * lightbox alt-save) is younger than the grace period, so it is spared — its plaintext bytes exist ONLY
 * client-side, so a mistaken delete is unrecoverable. A candidate whose age is unknown (`mtimeMs: null`, or a
 * driver without `stat`) is kept, not pruned. Pure → node-tested; `tree.put` supplies the mtimes + now.
 */
export function stalePruneKeys(candidates: readonly { key: string; mtimeMs: number | null }[], nowMs: number, graceMs: number): string[] {
  return candidates.filter((c) => c.mtimeMs != null && nowMs - c.mtimeMs > graceMs).map((c) => c.key)
}
