import { createHash } from "node:crypto";
import { ObjectMissing, PreconditionFailed, type CopyOptions, type ObjectInfo, type ObjectStore } from "./store.ts";

interface StoredObject {
  data: Uint8Array;
  etag: string;
  contentType: string | undefined;
  lastModified: number;
  visibleAfterLists: number;
}

/** One write a {@link MemoryBucket} saw: `existed` is true when the key held an object before. */
export interface RecordedWrite {
  op: "put" | "copy" | "delete";
  key: string;
  existed: boolean;
}

/** Inconsistencies a {@link MemoryBucket} can show, to exercise the paths a real S3-compatible store takes. */
export interface MemoryBucketOptions {
  /** A new key stays out of this many listings after it was written. Default 0. */
  listLag?: number;
  /** Ignore `ifMatch` on a server-side copy, as a store without copy-source-if-match does. Default false. */
  ignoreCopyIfMatch?: boolean;
  /** The server clock; defaults to `Date.now`. */
  clock?: () => number;
  /** Called before a server-side copy reads its source, with the source key. */
  beforeCopy?: (sourceKey: string) => void;
  /** The ETag a write gets; defaults to the MD5 of the bytes, as a single-part upload without KMS encryption has. */
  etag?: (data: Uint8Array, key: string, op: "put" | "copy") => string;
}

/** An in-memory bucket shared by any number of {@link memoryStore} views, with a record of every write. */
export class MemoryBucket {
  readonly objects = new Map<string, StoredObject>();
  readonly writes: RecordedWrite[] = [];
  readonly options: MemoryBucketOptions;

  constructor(readonly name: string, options: MemoryBucketOptions = {}) {
    this.options = options;
  }

  now(): number {
    return (this.options.clock ?? Date.now)();
  }

  write(key: string, data: Uint8Array, op: "put" | "copy", contentType?: string): void {
    this.writes.push({ op, key, existed: this.objects.has(key) });
    const etag = this.options.etag?.(data, key, op) ?? createHash("md5").update(data).digest("hex");
    this.objects.set(key, { data: new Uint8Array(data), etag, contentType, lastModified: this.now(), visibleAfterLists: this.options.listLag ?? 0 });
  }

  remove(key: string): void {
    this.writes.push({ op: "delete", key, existed: this.objects.has(key) });
    this.objects.delete(key);
  }

  /** Replaces the bytes of `key` without recording a write, as another writer outside the tool would. */
  tamper(key: string, data: Uint8Array): void {
    this.objects.set(key, { data: new Uint8Array(data), etag: createHash("md5").update(data).digest("hex"), contentType: this.objects.get(key)?.contentType, lastModified: this.now(), visibleAfterLists: 0 });
  }
}

/** An {@link ObjectStore} over a {@link MemoryBucket}, below `prefix`. */
export function memoryStore(bucket: MemoryBucket, prefix = ""): ObjectStore {
  const info = (key: string, object: StoredObject): ObjectInfo => ({ key, size: object.data.byteLength, etag: object.etag, lastModified: object.lastModified });
  const store: ObjectStore = {
    id: `memory:${bucket.name}`,
    locate: (key) => ({ bucket: bucket.name, key: prefix + key }),
    async list(sub) {
      const out: ObjectInfo[] = [];
      for (const [key, object] of bucket.objects) {
        if (!key.startsWith(prefix + sub)) continue;
        if (object.visibleAfterLists > 0) {
          object.visibleAfterLists -= 1;
          continue;
        }
        out.push(info(key.slice(prefix.length), object));
      }
      return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },
    async head(key) {
      const object = bucket.objects.get(prefix + key);
      return object ? { ...info(key, object), ...(object.contentType === undefined ? {} : { contentType: object.contentType }) } : null;
    },
    async read(key, options = {}) {
      const object = bucket.objects.get(prefix + key);
      if (!object) return null;
      if (options.ifMatch !== undefined && object.etag !== options.ifMatch) throw new PreconditionFailed(`${key} changed since it was listed`);
      return { data: new Uint8Array(object.data), ...(object.contentType === undefined ? {} : { contentType: object.contentType }) };
    },
    async get(key) {
      const object = bucket.objects.get(prefix + key);
      return object ? new Uint8Array(object.data) : null;
    },
    async put(key, data, options = {}) {
      bucket.write(prefix + key, data, "put", options.contentType);
    },
    async copy(sourceKey, key, options: CopyOptions = {}) {
      const source = (options.from ?? store).locate(sourceKey);
      if (source.bucket !== bucket.name) throw new Error(`memory store: cannot copy from bucket ${source.bucket} into ${bucket.name}`);
      bucket.options.beforeCopy?.(sourceKey);
      const object = bucket.objects.get(source.key);
      if (!object) throw new ObjectMissing(`${sourceKey} does not exist`);
      if (options.ifMatch !== undefined && !bucket.options.ignoreCopyIfMatch && object.etag !== options.ifMatch) throw new PreconditionFailed(`${sourceKey} changed since it was listed`);
      bucket.write(prefix + key, object.data, "copy", object.contentType);
    },
    async delete(key) {
      bucket.remove(prefix + key);
    },
  };
  return store;
}
