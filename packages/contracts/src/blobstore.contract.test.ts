import { describe, it, expect, beforeEach } from "vitest";
import type { Blobstore } from "./blobstore.ts";
import { expectErr, expectOk } from "./testing/result.ts";

export function blobstoreContractTests(make: () => Promise<Blobstore>) {
  describe("blobstore@1", () => {
    let store: Blobstore;
    const bytes = new TextEncoder().encode("hello");
    beforeEach(async () => {
      store = await make();
    });

    it("put then get returns the same bytes and content type", async () => {
      expectOk(await store.put("a/b.txt", { data: bytes, contentType: "text/plain" }));
      const blob = expectOk(await store.get("a/b.txt"));
      expect(blob?.contentType).toBe("text/plain");
      expect(Array.from(blob?.data ?? [])).toEqual(Array.from(bytes));
    });

    it("get of an unknown key returns null", async () => {
      expect(expectOk(await store.get("missing"))).toBeNull();
    });

    it("put overwrites", async () => {
      expectOk(await store.put("k", { data: bytes, contentType: "text/plain" }));
      expectOk(await store.put("k", { data: new Uint8Array([1, 2]), contentType: "application/octet-stream" }));
      const blob = expectOk(await store.get("k"));
      expect(blob?.contentType).toBe("application/octet-stream");
      expect(Array.from(blob?.data ?? [])).toEqual([1, 2]);
    });

    it("remove then get returns null", async () => {
      expectOk(await store.put("k", { data: bytes, contentType: "text/plain" }));
      expectOk(await store.remove("k"));
      expect(expectOk(await store.get("k"))).toBeNull();
    });

    it("list returns infos for keys with the prefix, sorted by key", async () => {
      expectOk(await store.put("img/b.png", { data: bytes, contentType: "image/png" }));
      expectOk(await store.put("img/a.png", { data: new Uint8Array([1, 2, 3]), contentType: "image/png" }));
      expectOk(await store.put("doc/x.txt", { data: bytes, contentType: "text/plain" }));
      expect(expectOk(await store.list("img/"))).toEqual([
        { key: "img/a.png", size: 3, contentType: "image/png" },
        { key: "img/b.png", size: bytes.length, contentType: "image/png" },
      ]);
      expect(expectOk(await store.list(""))).toHaveLength(3);
      expect(expectOk(await store.list("nope/"))).toEqual([]);
    });

    it("remove of an unknown key is ok", async () => {
      expect(expectOk(await store.remove("missing"))).toBeUndefined();
    });

    it("move renames a blob keeping its content type, overwrites the target, reports unknown keys as NOT_FOUND", async () => {
      expectOk(await store.put("a/x.txt", { data: bytes, contentType: "text/plain" }));
      expectOk(await store.put("b/y.txt", { data: new Uint8Array([9]), contentType: "application/octet-stream" }));
      expectOk(await store.move("a/x.txt", "b/y.txt"));
      expect(expectOk(await store.get("a/x.txt"))).toBeNull();
      const moved = expectOk(await store.get("b/y.txt"));
      expect(moved?.contentType).toBe("text/plain");
      expect(Array.from(moved?.data ?? [])).toEqual(Array.from(bytes));
      expect(expectErr(await store.move("nope", "b/z.txt"), "NOT_FOUND").message).toMatch(/not found/);
      expect(expectOk(await store.list("")).map((i) => i.key)).toEqual(["b/y.txt"]);
    });
  });
}
