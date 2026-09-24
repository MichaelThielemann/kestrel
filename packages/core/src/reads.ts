import { AsyncLocalStorage } from "node:async_hooks";
import { boundaryCast } from "./cast.ts";

/**
 * One answer a provider gave while a read scope was open.
 *
 * - `document`: one document of `type` was read by id, whatever the answer (also `null`).
 * - `type`: a read whose answer depends on any document of `type` (a single type, or a list the provider cannot
 *   narrow further).
 * - `query`: a list of `type` filtered by `filter` at `locale`; which documents belong to it is decided by the
 *   store that answered it.
 * - `path`: the public path of `type`/`id` at `locale` under the site rules `rules`, as it was answered (`null`
 *   when the link was broken).
 */
export type ObservedRead =
  | { kind: "document"; type: string; id: string; locale?: string }
  | { kind: "type"; type: string }
  | { kind: "query"; type: string; filter: Record<string, unknown>; locale?: string }
  | { kind: "path"; type: string; id: string; locale: string; rules: Record<string, unknown>; path: string | null };

interface Frame {
  reads: ObservedRead[];
  open: boolean;
}

const STORE_KEY = Symbol.for("kestrel.reads");

function sharedStorage(): AsyncLocalStorage<Frame | null> {
  const existing: unknown = Reflect.get(globalThis, STORE_KEY);
  if (existing instanceof AsyncLocalStorage) return boundaryCast<AsyncLocalStorage<Frame | null>>(existing, "host");
  const created = new AsyncLocalStorage<Frame | null>();
  Reflect.set(globalThis, STORE_KEY, created);
  return created;
}

const storage = sharedStorage();

/**
 * Runs `fn` in a fresh read scope and returns its outcome together with every read a provider noted inside it,
 * also when `fn` rejects or throws.
 *
 * The scope is sealed when `fn` settles: a `noteRead` from work `fn` started but did not await changes nothing.
 * A nested scope collects its own reads only. The scope lives in one `AsyncLocalStorage` per process, kept on
 * `globalThis`, so a second copy of this package shares it.
 *
 * Reads made in another process, over a socket, or answered from a cache kept across requests are not observed.
 * Providers must therefore keep no process-wide in-flight dedupe or memo of reads: such a cache would attribute one
 * scope's reads to another scope, or to none.
 */
export async function observeReads<T>(fn: () => Promise<T>): Promise<{ result: PromiseSettledResult<T>; reads: ObservedRead[] }> {
  const frame: Frame = { reads: [], open: true };
  let result: PromiseSettledResult<T>;
  try {
    result = { status: "fulfilled", value: await storage.run(frame, fn) };
  } catch (reason) {
    result = { status: "rejected", reason };
  } finally {
    frame.open = false;
  }
  return { result, reads: frame.reads };
}

/**
 * Records a plain JSON copy of `read` in the innermost open read scope, so a later change to the caller's objects never
 * reaches it; a no-op, with no copy made, outside a scope, inside {@link unobserved}, or after the scope sealed.
 */
export function noteRead(read: ObservedRead): void {
  const frame = storage.getStore();
  if (frame?.open === true) frame.reads.push(boundaryCast<ObservedRead>(JSON.parse(JSON.stringify(read)), "json"));
}

/** Runs `fn` so that nothing it reads is noted in the enclosing scope: for lookups a provider makes on its own behalf before it notes the answer it gives. */
export function unobserved<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run(null, fn);
}
