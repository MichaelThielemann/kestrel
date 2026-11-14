import type { PollOptions } from "./replica.ts";

/** One object as a listing or HEAD reports it. `etag` is unquoted; `lastModified` is the server's clock in epoch milliseconds. */
export interface ObjectInfo {
  key: string;
  size: number;
  etag: string;
  lastModified: number;
}

/** Options of {@link ObjectStore.copy}. */
export interface CopyOptions {
  /** The store the source key lives in; defaults to the store copied into. */
  from?: ObjectStore;
  /** Copy only while the source still has this ETag; a store that cannot check it server-side is checked by a HEAD before the copy. */
  ifMatch?: string;
}

/**
 * The object operations backup and restore need from a bucket, relative to the store's own key prefix. Every method
 * throws on a failure it cannot report as a value: {@link PreconditionFailed} when `ifMatch` no longer holds,
 * {@link ObjectMissing} when a copy source is gone.
 */
export interface ObjectStore {
  /** Identifies the physical store and credentials; two stores with the same `id` can copy server-side. */
  readonly id: string;
  list(prefix: string): Promise<ObjectInfo[]>;
  head(key: string): Promise<ObjectInfo | null>;
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, data: Uint8Array, options?: { contentType?: string }): Promise<void>;
  copy(sourceKey: string, key: string, options?: CopyOptions): Promise<void>;
  /** A missing key is not an error. */
  delete(key: string): Promise<void>;
  /** Server-side key of `key` for {@link CopyOptions.from}: the store-level key including the store's prefix. */
  locate(key: string): { bucket: string; key: string };
}

/** The source of a copy no longer has the ETag the copy was asked to match. */
export class PreconditionFailed extends Error {
  override readonly name = "PreconditionFailed";
}

/** The source of a copy does not exist. */
export class ObjectMissing extends Error {
  override readonly name = "ObjectMissing";
}

/** Copies `sourceKey` of `from` to `key` of `to`, server-side when both are the same store, otherwise by reading and writing the bytes. */
export async function transfer(from: ObjectStore, sourceKey: string, to: ObjectStore, key: string, ifMatch?: string): Promise<void> {
  if (from.id === to.id) {
    await to.copy(sourceKey, key, ifMatch === undefined ? { from } : { from, ifMatch });
    return;
  }
  if (ifMatch !== undefined) {
    const head = await from.head(sourceKey);
    if (head === null) throw new ObjectMissing(`${sourceKey} does not exist`);
    if (head.etag !== ifMatch) throw new PreconditionFailed(`${sourceKey} changed since it was listed`);
  }
  const data = await from.get(sourceKey);
  if (data === null) throw new ObjectMissing(`${sourceKey} does not exist`);
  await to.put(key, data);
}

/** Lists `prefix` and returns the entries keyed by their key. */
export async function listMap(store: ObjectStore, prefix: string): Promise<Map<string, ObjectInfo>> {
  return new Map((await store.list(prefix)).map((info) => [info.key, info]));
}

/** Strips the quotes S3 puts around an ETag. */
export function unquote(etag: string | undefined): string {
  return (etag ?? "").replace(/^W\//, "").replace(/^"|"$/g, "");
}

/** Lists `prefix` until `agree` consecutive listings show the same keys and ETags, for a store whose listings may lag behind writes. */
export async function stableList(store: ObjectStore, prefix: string, poll: PollOptions = {}): Promise<ObjectInfo[]> {
  const agree = poll.agree ?? 2;
  const sleep = poll.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let last = "";
  let same = 0;
  let listed: ObjectInfo[] = [];
  for (let i = 0; i < (poll.attempts ?? 30); i++) {
    listed = await store.list(prefix);
    const now = listed.map((info) => `${info.key}:${info.etag}`).join(",");
    same = now === last ? same + 1 : 1;
    last = now;
    if (same >= agree) return listed;
    await sleep(poll.delayMs ?? 1000);
  }
  return listed;
}
