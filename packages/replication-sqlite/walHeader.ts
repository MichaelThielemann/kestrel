import { WAL_HEADER_SIZE, walChecksum } from "./wal.ts";

const WAL_MAGIC = 0x377f0682;
const WAL_FORMAT = 3007000;

/** A WAL header for a database with `pageSize` byte pages, with a zero checkpoint sequence and zero salts, whose checksum matches its content. */
export function emptyWalHeader(pageSize: number): Uint8Array {
  const header = new Uint8Array(WAL_HEADER_SIZE);
  const view = new DataView(header.buffer);
  view.setUint32(0, WAL_MAGIC);
  view.setUint32(4, WAL_FORMAT);
  view.setUint32(8, pageSize);
  const [first, second] = walChecksum(WAL_MAGIC, header.subarray(0, 24), [0, 0]);
  view.setUint32(24, first);
  view.setUint32(28, second);
  return header;
}
