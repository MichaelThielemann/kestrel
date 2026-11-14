import type { PollOptions } from "./replica.ts";

/** One object as a listing or HEAD reports it. `etag` is unquoted; `lastModified` is the server's clock in epoch milliseconds. */
export interface ObjectInfo {
  key: string;
  size: number;
  etag: string;
  lastModified: number;
  /** The stored Content-Type; only a HEAD reports it. */
  contentType?: string;
}

/** An object's bytes with the Content-Type it was stored with. */
export interface ObjectData {
  data: Uint8Array;
  contentType?: string;
}

/** Options of {@link ObjectStore.copy}. */
export interface CopyOptions {
  /** The store the source key lives in; defaults to the store copied into. */
  from?: ObjectStore;
  /** Copy only while the source still has this ETag; a store that cannot check it server-side is checked by a HEAD before the copy. */
  ifMatch?: string;
  /** The key may hold an object the copy replaces: the copy is one request, a failure never removes the key, and the caller reads the result back. */
  replace?: boolean;
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
  /** Reads bytes and Content-Type; with `ifMatch`, throws {@link PreconditionFailed} unless the object still has that ETag. */
  read(key: string, options?: { ifMatch?: string }): Promise<ObjectData | null>;
  put(key: string, data: Uint8Array, options?: { contentType?: string }): Promise<void>;
  copy(sourceKey: string, key: string, options?: CopyOptions): Promise<void>;
  /** A missing key is not an error. */
  delete(key: string): Promise<void>;
  /** Server-side key of `key` for {@link CopyOptions.from}: the store-level key including the store's prefix. */
  locate(key: string): { bucket: string; key: string };
  /**
   * Measures the store's clock with a probe object below `prefix` that is removed again; `skewMs` is the local
   * clock minus the store's. A store without it is measured by `serverClock` through `put`, `list` and `delete`.
   */
  serverTime?(prefix: string, clock: () => number, poll?: PollOptions): Promise<{ skewMs: number }>;
}

/** The source of a copy no longer has the ETag the copy was asked to match. */
export class PreconditionFailed extends Error {
  override readonly name = "PreconditionFailed";
}

/** The source of a copy does not exist. */
export class ObjectMissing extends Error {
  override readonly name = "ObjectMissing";
}

/**
 * Copies `sourceKey` of `from` to `key` of `to`, server-side when both are the same store, otherwise by reading the
 * bytes (conditional on `ifMatch`) and writing them with the source's Content-Type. Resolves to the bytes when it
 * read them, null after a server-side copy. `options.replace` marks a key that may hold an object already, see
 * {@link CopyOptions.replace}.
 */
export async function transfer(from: ObjectStore, sourceKey: string, to: ObjectStore, key: string, ifMatch?: string, options: { replace?: boolean } = {}): Promise<Uint8Array | null> {
  if (from.id === to.id) {
    await to.copy(sourceKey, key, { from, ...(ifMatch === undefined ? {} : { ifMatch }), ...(options.replace === true ? { replace: true } : {}) });
    return null;
  }
  const object = await from.read(sourceKey, ifMatch === undefined ? {} : { ifMatch });
  if (object === null) throw new ObjectMissing(`${sourceKey} does not exist`);
  await to.put(key, object.data, object.contentType === undefined ? {} : { contentType: object.contentType });
  return object.data;
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
