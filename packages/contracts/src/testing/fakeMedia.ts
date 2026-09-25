import { randomUUID } from "node:crypto";
import { ok } from "../errors.ts";
import type { LoadedMediaFile, MediaFile, MediaFiles, MediaFilter, MediaScanOptions } from "../media.ts";
import { canonicalMediaType, mediaTypeAllowed, publicFormOf } from "../mediaType.ts";

/** A file as a test adds it to {@link createFakeMedia}; everything but the type and the bytes has a default. */
export interface FakeMediaInput {
  id?: string;
  contentType: string;
  data: Uint8Array;
  publishedType?: string;
  width?: number | null;
  height?: number | null;
  folder?: string;
  filename?: string;
  createdAt?: number;
}

export type FakeMediaMethod = "file" | "files" | "load" | "scan" | "count";

export interface FakeMedia extends MediaFiles {
  /** Adds a ready file; `contentType` is stored canonical, `publishedType` defaults to `publicFormOf(contentType).contentType`. Throws for a type that is not exactly one media type and for an id used before. */
  add(file: FakeMediaInput): MediaFile;
  /** Adds a file that is not ready yet, as an upload in flight, and returns its id; it stays invisible until {@link FakeMedia.markReady}. Throws like `add`. */
  addPending(file: FakeMediaInput): string;
  /** Makes a file added with `addPending` ready; throws for a file that is not pending, including one removed meanwhile. */
  markReady(id: string): void;
  /** Ends a file's readiness, as the first step of a removal does. */
  remove(id: string): void;
  /** Keeps a file ready but drops its bytes, as a store that lost them. */
  loseBytes(id: string): void;
  /** Every call in order, for tests that assert what a consumer asked. */
  readonly calls: ReadonlyArray<{ method: FakeMediaMethod; args: readonly unknown[] }>;
}

export interface FakeMediaOptions {
  /** The clock a file's default `createdAt` comes from. */
  now?: () => number;
  /** Awaited after a call is recorded and before it is answered, so a test can change the store in between. */
  beforeCall?: (method: FakeMediaMethod, args: readonly unknown[]) => void | Promise<void>;
}

interface Entry {
  file: MediaFile;
  data: Uint8Array | null;
  phase: "pending" | "ready" | "gone";
}

const MAX_LIMIT = 500;

/** In-memory `media@1` for tests of consumers: ready files only, patterns by `mediaTypeAllowed`, no cache between calls. */
export function createFakeMedia(options: FakeMediaOptions = {}): FakeMedia {
  const clock = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const calls: Array<{ method: FakeMediaMethod; args: readonly unknown[] }> = [];

  const enter = async (method: FakeMediaMethod, args: readonly unknown[]): Promise<void> => {
    calls.push({ method, args });
    await options.beforeCall?.(method, args);
  };
  const readyFile = (id: string): MediaFile | null => {
    const entry = entries.get(id);
    return entry?.phase === "ready" ? { ...entry.file } : null;
  };
  const matches = (file: MediaFile, filter: MediaFilter): boolean =>
    mediaTypeAllowed(filter.types ?? ["*"], filter.excludeTypes ?? [], file.contentType) && (filter.createdSince === undefined || file.createdAt >= filter.createdSince);
  const matching = (filter: MediaFilter): MediaFile[] =>
    [...entries.values()]
      .filter((entry) => entry.phase === "ready" && matches(entry.file, filter))
      .map((entry) => ({ ...entry.file }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const store = (input: FakeMediaInput, phase: Entry["phase"]): MediaFile => {
    const contentType = canonicalMediaType(input.contentType);
    if (contentType === null) throw new Error(`fakeMedia: ${JSON.stringify(input.contentType)} is not exactly one media type`);
    const id = input.id ?? randomUUID();
    if (entries.has(id)) throw new Error(`fakeMedia: id ${id} is already used`);
    const file: MediaFile = {
      id,
      contentType,
      publishedType: input.publishedType ?? publicFormOf(contentType).contentType,
      size: input.data.byteLength,
      width: input.width ?? null,
      height: input.height ?? null,
      folder: input.folder ?? "",
      filename: input.filename ?? id,
      createdAt: input.createdAt ?? clock(),
    };
    entries.set(id, { file, data: input.data, phase });
    return { ...file };
  };

  return {
    calls,
    add: (input) => store(input, "ready"),
    addPending: (input) => store(input, "pending").id,
    markReady(id) {
      const entry = entries.get(id);
      if (entry?.phase !== "pending") throw new Error(`fakeMedia: ${id} is not pending`);
      entry.phase = "ready";
    },
    remove(id) {
      const entry = entries.get(id);
      if (entry !== undefined) entry.phase = "gone";
    },
    loseBytes(id) {
      const entry = entries.get(id);
      if (entry !== undefined) entry.data = null;
    },
    async file(id) {
      await enter("file", [id]);
      return ok(readyFile(id));
    },
    async files(ids) {
      await enter("files", [ids]);
      const out: MediaFile[] = [];
      for (const id of new Set(ids)) {
        const file = readyFile(id);
        if (file !== null) out.push(file);
      }
      return ok(out);
    },
    async load(id) {
      await enter("load", [id]);
      const file = readyFile(id);
      const data = entries.get(id)?.data ?? null;
      if (file === null || data === null) return ok(null);
      const loaded: LoadedMediaFile = { file, data };
      return ok(loaded);
    },
    async scan(filter, scanOptions: MediaScanOptions) {
      await enter("scan", [filter, scanOptions]);
      const { limit } = scanOptions;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`fakeMedia: scan limit must be an integer from 1 to ${MAX_LIMIT}, got ${limit}`);
      const after = scanOptions.after ?? null;
      const items = matching(filter)
        .filter((file) => after === null || file.id > after)
        .slice(0, limit);
      return ok({ items, next: items.length === limit ? items[items.length - 1]!.id : null });
    },
    async count(filter) {
      await enter("count", [filter]);
      return ok(matching(filter).length);
    },
  };
}
