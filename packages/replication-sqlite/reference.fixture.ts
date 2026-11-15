import { existsSync, readFileSync } from "node:fs";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { isErr } from "@michaelthielemann/kestrel/result";
import { listReplica } from "./impl.ts";
import { FRAME_HEADER_SIZE, FrameScanner, frameSize, parseFrameHeader, parseWalHeader, WAL_HEADER_SIZE, walHeaderChecksum } from "./wal.ts";

/**
 * Applies the committed frames of a WAL segment to a database image in the plainest way the replica format
 * allows: a commit that changes the size copies the image into a new one of that size, then writes the
 * transaction's pages. The tests compare the module's own code against it.
 */
export function referenceApplySegment(image: Uint8Array, segment: Uint8Array): Uint8Array {
  const header = parseWalHeader(segment);
  if (!header) throw new Error("reference: segment has no WAL header");
  const size = frameSize(header.pageSize);
  let out = image;
  let pending: Array<{ pageNumber: number; data: Uint8Array }> = [];
  for (let offset = WAL_HEADER_SIZE; offset + size <= segment.byteLength; offset += size) {
    const frame = parseFrameHeader(segment, offset);
    if (frame.salt1 !== header.salt1 || frame.salt2 !== header.salt2) break;
    pending.push({ pageNumber: frame.pageNumber, data: segment.subarray(offset + FRAME_HEADER_SIZE, offset + size) });
    if (frame.commitSize > 0) {
      const needed = frame.commitSize * header.pageSize;
      if (out.byteLength !== needed) {
        const grown = new Uint8Array(needed);
        grown.set(out.subarray(0, Math.min(out.byteLength, needed)));
        out = grown;
      }
      for (const p of pending) out.set(p.data, (p.pageNumber - 1) * header.pageSize);
      pending = [];
    }
  }
  return out;
}

/** The committed frames of the WAL next to `file`, read synchronously from its start, as one segment. */
export function referenceCommittedWal(file: string): Uint8Array | null {
  if (!existsSync(`${file}-wal`)) return null;
  const wal = new Uint8Array(readFileSync(`${file}-wal`));
  const header = parseWalHeader(wal);
  const checksum = walHeaderChecksum(wal);
  if (!header || !checksum) return null;
  const scanner = new FrameScanner(header, checksum);
  const size = frameSize(header.pageSize);
  scanner.push(wal.subarray(WAL_HEADER_SIZE, WAL_HEADER_SIZE + Math.floor((wal.byteLength - WAL_HEADER_SIZE) / size) * size));
  return scanner.takeSegment(wal).segment;
}

/** The snapshot of `file` as a plain read gives it: the whole database file with every committed WAL frame applied. */
export function referenceSnapshot(file: string): Uint8Array {
  const image = new Uint8Array(readFileSync(file));
  const wal = referenceCommittedWal(file);
  return wal ? referenceApplySegment(image, wal) : image;
}

/** Rebuilds a generation of the replica under `prefix` (the newest one with a snapshot unless named) with {@link referenceApplySegment}. */
export async function referenceRestore(blobs: Blobstore, prefix: string, generation?: string): Promise<{ generation: string; image: Uint8Array }> {
  const listed = await listReplica(blobs, prefix);
  if (isErr(listed)) throw new Error(listed.error.message);
  const points = listed.value.points;
  const chosen = generation ?? points.filter((p) => p.kind === "snapshot").map((p) => p.generation).sort().at(-1);
  const snapshot = points.find((p) => p.generation === chosen && p.kind === "snapshot");
  if (chosen === undefined || !snapshot) throw new Error("reference: no snapshot");
  const read = async (key: string): Promise<Uint8Array> => {
    const blob = await blobs.get(key);
    if (isErr(blob) || blob.value === null) throw new Error(`reference: ${key} is missing`);
    return new Uint8Array(blob.value);
  };
  let image = await read(snapshot.key);
  for (const point of points.filter((p) => p.generation === chosen && p.kind === "wal")) image = referenceApplySegment(image, await read(point.key));
  return { generation: chosen, image };
}
