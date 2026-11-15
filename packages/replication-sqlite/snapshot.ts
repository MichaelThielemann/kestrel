import { open, type FileHandle } from "node:fs/promises";
import { FRAME_HEADER_SIZE, frameSize, parseFrameHeader, parseWalHeader, WAL_HEADER_SIZE, walChecksum, walHeaderChecksum, type WalChecksum, type WalHeader } from "./wal.ts";

/** A place in the WAL: the header of its lineage, how many frames from its start, and the checksum after the last of them. */
export interface WalPosition {
  /** The 32 bytes of the WAL header. */
  headerBytes: Uint8Array;
  /** The parsed WAL header. */
  header: WalHeader;
  /** How many frames, counted from the start of the WAL. */
  frame: number;
  /** The running checksum after the last of those frames. */
  checksum: WalChecksum;
}

/** The answer of `PRAGMA wal_checkpoint(PASSIVE)`. */
export interface WalState {
  /** 1 when another connection held the checkpoint lock, or, for a blocking checkpoint, when it could not finish. */
  busy: number;
  /** How many frames the WAL holds, -1 when unknown. */
  log: number;
  /** How many of them are copied back into the database file, -1 when unknown. */
  checkpointed: number;
}

/** What {@link readSnapshot} reads from and reports to. */
export interface SnapshotSource {
  /** The database file. */
  file: string;
  /** Its WAL file. */
  walFile: string;
  /** Runs a passive checkpoint on a connection without a transaction, while the module's read transaction holds the WAL. */
  probe(): WalState;
  /** The current time; read right after the probe the snapshot is taken at. */
  now(): number;
  /** True once the snapshot is to end without an image. */
  stopped(): boolean;
}

/** A snapshot image, the WAL position it holds every frame up to, and when it was taken. */
export interface SnapshotRead {
  /** The database file with every committed WAL frame up to `position` applied. */
  image: Uint8Array;
  /** The WAL position the image holds every frame up to; null when there is no valid WAL header. */
  position: WalPosition | null;
  /** When the WAL was probed, in epoch milliseconds. */
  at: number;
}

const CHUNK_BYTES = 1024 * 1024;
const ATTEMPTS = 10;
const BUSY_ATTEMPTS = 3;
const RETRY_MS = 20;

const u32 = (d: Uint8Array, at: number): number => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(at);

function headOf(bytes: Uint8Array | null): Omit<WalPosition, "frame"> | null {
  if (bytes === null) return null;
  const header = parseWalHeader(bytes);
  const checksum = walHeaderChecksum(bytes);
  return header && checksum ? { headerBytes: bytes.slice(0, WAL_HEADER_SIZE), header, checksum } : null;
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  return a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Uint8Array | null> {
  const bytes = new Uint8Array(length);
  const { bytesRead } = await handle.read(bytes, 0, length, position);
  return bytesRead === length ? bytes : null;
}

async function openExisting(path: string): Promise<FileHandle | null> {
  try {
    return await open(path, "r");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
    throw cause;
  }
}

async function frameAt(wal: FileHandle, head: Omit<WalPosition, "frame">, frame: number): Promise<{ commitSize: number; checksum: WalChecksum } | null> {
  const bytes = await readAt(wal, WAL_HEADER_SIZE + (frame - 1) * frameSize(head.header.pageSize), FRAME_HEADER_SIZE);
  if (bytes === null) return null;
  const info = parseFrameHeader(bytes, 0);
  if (info.salt1 !== head.header.salt1 || info.salt2 !== head.header.salt2) return null;
  return { commitSize: info.commitSize, checksum: [u32(bytes, 16), u32(bytes, 20)] };
}

async function copyFile(db: FileHandle, image: Uint8Array, bytes: number, source: SnapshotSource): Promise<"done" | "stopped" | "moved"> {
  for (let offset = 0; offset < bytes; offset += CHUNK_BYTES) {
    const length = Math.min(CHUNK_BYTES, bytes - offset);
    const { bytesRead } = await db.read(image, offset, length, offset);
    if (bytesRead < length) return "moved";
    if (source.stopped()) return "stopped";
  }
  return "done";
}

async function lastCommitted(wal: FileHandle, head: Omit<WalPosition, "frame">, source: SnapshotSource): Promise<{ frames: number; commitSize: number; checksum: WalChecksum } | "stopped"> {
  const { pageSize, magic, salt1, salt2 } = head.header;
  const size = frameSize(pageSize);
  const perChunk = Math.max(1, Math.floor(CHUNK_BYTES / size));
  const chunk = new Uint8Array(perChunk * size);
  const view = new DataView(chunk.buffer);
  let running: WalChecksum = head.checksum;
  let last = { frames: 0, commitSize: 0, checksum: head.checksum };
  for (let frame = 0; ; ) {
    const { bytesRead } = await wal.read(chunk, 0, chunk.byteLength, WAL_HEADER_SIZE + frame * size);
    const whole = Math.floor(bytesRead / size);
    for (let i = 0; i < whole; i++) {
      const offset = i * size;
      const info = parseFrameHeader(chunk, offset);
      running = walChecksum(magic, chunk.subarray(offset + FRAME_HEADER_SIZE, offset + size), walChecksum(magic, chunk.subarray(offset, offset + 8), running));
      if (info.salt1 !== salt1 || info.salt2 !== salt2 || running[0] !== view.getUint32(offset + 16) || running[1] !== view.getUint32(offset + 20)) return last;
      if (info.commitSize > 0) last = { frames: frame + i + 1, commitSize: info.commitSize, checksum: running };
    }
    frame += whole;
    if (whole < perChunk) return last;
    if (source.stopped()) return "stopped";
  }
}

async function readImage(source: SnapshotSource, db: FileHandle, wal: FileHandle | null, attempt: number): Promise<SnapshotRead | "stopped" | "moved"> {
  const before = wal ? await readAt(wal, 0, WAL_HEADER_SIZE) : null;
  const state = source.probe();
  let at = source.now();
  const head = headOf(before);
  const probed = state.busy === 0 && state.log >= 0;
  if (!probed && attempt < BUSY_ATTEMPTS) return "moved";
  let frames = probed ? state.log : 0;
  let scanned: { commitSize: number; checksum: WalChecksum } | null = null;
  if (!probed && wal !== null && head !== null) {
    const end = await lastCommitted(wal, head, source);
    if (end === "stopped") return "stopped";
    frames = end.frames;
    scanned = end;
    at = source.now();
  }
  if (frames === 0) {
    if (!sameBytes(before, wal ? await readAt(wal, 0, WAL_HEADER_SIZE) : null)) return "moved";
    const size = (await db.stat()).size;
    const image = new Uint8Array(size);
    const copied = await copyFile(db, image, size, source);
    if (copied !== "done") return copied;
    return { image, position: head ? { ...head, frame: 0 } : null, at };
  }
  if (wal === null || head === null) return "moved";
  const { pageSize, magic } = head.header;
  const size = frameSize(pageSize);
  const last = scanned ?? (await frameAt(wal, head, frames));
  if (last === null || last.commitSize === 0) return "moved";
  let from = probed ? Math.min(Math.max(state.checkpointed, 0), frames) : 0;
  let base = from > 0 ? await frameAt(wal, head, from) : null;
  if (base === null || base.commitSize === 0) {
    from = 0;
    base = null;
  }
  if (!sameBytes(before, await readAt(wal, 0, WAL_HEADER_SIZE))) return "moved";
  const fileSize = (await db.stat()).size;
  if (base !== null && fileSize < base.commitSize * pageSize) {
    from = 0;
    base = null;
  }
  const finalLength = last.commitSize * pageSize;
  const image = new Uint8Array(finalLength);
  let length = base === null ? fileSize : base.commitSize * pageSize;
  const copied = await copyFile(db, image, Math.min(fileSize, length, finalLength), source);
  if (copied !== "done") return copied;
  let running: WalChecksum = base === null ? head.checksum : base.checksum;
  const perChunk = Math.max(1, Math.floor(CHUNK_BYTES / size));
  const chunk = new Uint8Array(perChunk * size);
  const view = new DataView(chunk.buffer);
  for (let frame = from; frame < frames; ) {
    const count = Math.min(perChunk, frames - frame);
    const bytes = count * size;
    const { bytesRead } = await wal.read(chunk, 0, bytes, WAL_HEADER_SIZE + frame * size);
    if (bytesRead < bytes) return "moved";
    for (let offset = 0; offset < bytes; offset += size) {
      const info = parseFrameHeader(chunk, offset);
      running = walChecksum(magic, chunk.subarray(offset + FRAME_HEADER_SIZE, offset + size), walChecksum(magic, chunk.subarray(offset, offset + 8), running));
      if (info.salt1 !== head.header.salt1 || info.salt2 !== head.header.salt2 || running[0] !== view.getUint32(offset + 16) || running[1] !== view.getUint32(offset + 20)) return "moved";
      const to = (info.pageNumber - 1) * pageSize;
      if (info.pageNumber >= 1 && to + pageSize <= finalLength) image.set(chunk.subarray(offset + FRAME_HEADER_SIZE, offset + size), to);
      if (info.commitSize > 0) {
        const committed = info.commitSize * pageSize;
        if (committed < length) image.fill(0, committed, Math.min(length, finalLength));
        length = committed;
      }
    }
    frame += count;
    if (source.stopped()) return "stopped";
  }
  if (running[0] !== last.checksum[0] || running[1] !== last.checksum[1]) return "moved";
  if (from < frames && !sameBytes(before, await readAt(wal, 0, WAL_HEADER_SIZE))) return "moved";
  return { image, position: { ...head, frame: frames, checksum: last.checksum }, at };
}

/**
 * Reads a snapshot of the database while the caller's read transaction holds the WAL, without blocking the event
 * loop on more than one chunk of 1 MiB at a time and with one buffer of the image's size. A passive checkpoint
 * tells how many frames the WAL holds and how many of them are copied back into the database file; the image is
 * the database file up to the size after the last copied frame, with the frames after it applied, which is what
 * the whole file with every committed frame applied holds. When another connection still holds the checkpoint lock
 * at the fourth try, the WAL is read twice instead: once to find its last committed frame along the checksum chain,
 * then to apply every frame up to it, from the first, to the whole database file. Answers `"stopped"` once `source.stopped()` is true,
 * and `"unsettled"` when the WAL kept starting over while it was read.
 */
export async function readSnapshot(source: SnapshotSource): Promise<SnapshotRead | "stopped" | "unsettled"> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (source.stopped()) return "stopped";
    const db = await open(source.file, "r");
    let read: SnapshotRead | "stopped" | "moved";
    try {
      const wal = await openExisting(source.walFile);
      try {
        read = await readImage(source, db, wal, attempt);
      } finally {
        await wal?.close();
      }
    } finally {
      await db.close();
    }
    if (read !== "moved") return read;
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
  return "unsettled";
}
