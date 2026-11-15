import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { blobstoreContractTests } from "@michaelthielemann/kestrel-contracts/blobstore.contract.test";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { assertKey, createBlobstoreFilesystem } from "./impl.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), readdir: vi.fn(actual.readdir), stat: vi.fn(actual.stat) };
});

const roots: string[] = [];
const fresh = async () => {
  const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-blobs-"));
  roots.push(root);
  return root;
};
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
afterEach(() => {
  vi.mocked(writeFile).mockClear();
  vi.mocked(readdir).mockClear();
  vi.mocked(stat).mockClear();
});

blobstoreContractTests(async () => createBlobstoreFilesystem({ root: await fresh() }));

describe("blobstore/filesystem", () => {
  it("rejects keys that escape the root or look like a legacy sidecar", async () => {
    expect(() => assertKey("../x")).toThrow(/invalid key/);
    expect(() => assertKey("/abs")).toThrow(/invalid key/);
    expect(() => assertKey("a//b")).toThrow(/invalid key/);
    expect(() => assertKey("a/b.meta.json")).toThrow(/invalid key/);
    const store = createBlobstoreFilesystem({ root: await fresh() });
    await expect(store.get("../../etc/passwd")).rejects.toThrow(/invalid key/);
  });

  it("prunes directories emptied by move and remove, but never the root", async () => {
    const root = await fresh();
    const store = createBlobstoreFilesystem({ root });
    const bytes = new Uint8Array([1]);
    expectOk(await store.put("a/b/x.txt", bytes, { contentType: "text/plain" }));
    expectOk(await store.move("a/b/x.txt", "c/x.txt"));
    await expect(readdir(root)).resolves.toEqual(["c"]);

    expectOk(await store.put("c/d/y.txt", bytes));
    expectOk(await store.remove("c/d/y.txt"));
    await expect(readdir(join(root, "c"))).resolves.toEqual(["x.txt"]);
    expectOk(await store.remove("c/x.txt"));
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("ignores legacy content-type sidecars in listings", async () => {
    const root = await fresh();
    for (const [file, content] of [["a/x.txt", "x"], ["a/x.txt.meta.json", '{"contentType":"text/plain"}'], ["plain.meta.json", "{}"]] as const) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), content);
    }
    const store = createBlobstoreFilesystem({ root });
    expect(expectOk(await store.list(""))).toEqual([{ key: "a/x.txt", size: 1 }]);
    expect(new TextDecoder().decode(expectOk(await store.get("a/x.txt")) ?? new Uint8Array())).toBe("x");
    await expect(store.get("a/x.txt.meta.json")).rejects.toThrow(/invalid key/);
  });

  it("maps a transient IO error (EBUSY) to a retryable TRANSIENT Err instead of throwing", async () => {
    const root = await fresh();
    const store = createBlobstoreFilesystem({ root });
    const busy = Object.assign(new Error("resource busy"), { code: "EBUSY" });
    vi.mocked(writeFile).mockRejectedValueOnce(busy);
    const result = await store.put("a.txt", new Uint8Array([1]));
    const error = expectErr(result, "TRANSIENT");
    expect(error.retryable).toBe(true);
    expect(error.cause).toBe(busy);
  });

  it("rethrows a non-transient IO error as a bug", async () => {
    const root = await fresh();
    const store = createBlobstoreFilesystem({ root });
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.mocked(writeFile).mockRejectedValueOnce(denied);
    await expect(store.put("a.txt", new Uint8Array([1]))).rejects.toBe(denied);
  });

  it("rejects a key ending in the temporary-file suffix", () => {
    expect(() => assertKey("a/b.kestrel-tmp")).toThrow(/invalid key/);
  });

  it("list ignores a planted .kestrel-tmp file", async () => {
    const root = await fresh();
    await mkdir(join(root, "a"), { recursive: true });
    await writeFile(join(root, "a", "x.txt"), "x");
    await writeFile(join(root, "a", "x.txt.deadbeef.kestrel-tmp"), "half-written");
    const store = createBlobstoreFilesystem({ root });
    expect(expectOk(await store.list(""))).toEqual([{ key: "a/x.txt", size: 1 }]);
  });

  it("replaces a file atomically: a reader never observes a partial write across repeated overwrites", async () => {
    const root = await fresh();
    const store = createBlobstoreFilesystem({ root });
    const versionA = new Uint8Array(8 * 1024 * 1024).fill(1);
    const versionB = new Uint8Array(8 * 1024 * 1024).fill(2);
    expectOk(await store.put("big.bin", versionA));

    let stop = false;
    const seenSizes = new Set<number>();
    const reader = (async () => {
      while (!stop) {
        const data = expectOk(await store.get("big.bin"));
        if (data) {
          seenSizes.add(data.byteLength);
          expect(data.every((byte) => byte === data[0])).toBe(true);
        }
      }
    })();
    for (let i = 0; i < 20; i++) {
      expectOk(await store.put("big.bin", i % 2 === 0 ? versionB : versionA));
    }
    stop = true;
    await reader;
    expect([...seenSizes].every((size) => size === versionA.byteLength)).toBe(true);
    const entries = await readdir(root);
    expect(entries.filter((name) => name.includes("kestrel-tmp"))).toEqual([]);
  });

  it("writes a key whose last segment is close to the file system's name limit, since the temporary name does not grow with the key", async () => {
    const root = await fresh();
    const store = createBlobstoreFilesystem({ root });
    const key = `a/${"n".repeat(250)}`;
    expectOk(await store.put(key, new Uint8Array([7])));
    expect(Array.from(expectOk(await store.get(key)) ?? [])).toEqual([7]);
    expect(expectOk(await store.list("a/"))).toEqual([{ key, size: 1 }]);
  });

  it("removes the temporary file when the rename fails, leaving the original untouched", async () => {
    const root = await fresh();
    const store = createBlobstoreFilesystem({ root });
    expectOk(await store.put("a.txt", new Uint8Array([1])));
    const failure_ = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const original = await import("node:fs/promises");
    const renameSpy = vi.spyOn(original, "rename").mockRejectedValueOnce(failure_);
    await expect(store.put("a.txt", new Uint8Array([2]))).rejects.toBe(failure_);
    renameSpy.mockRestore();
    expect(Array.from(expectOk(await store.get("a.txt")) ?? [])).toEqual([1]);
    const entries = await readdir(root);
    expect(entries.filter((name) => name.includes("kestrel-tmp"))).toEqual([]);
  });
});

describe("blobstore/filesystem list(prefix)", () => {
  const KEYS = [
    "a/x.txt",
    "a/y.txt",
    "a/b/c.txt",
    "a/b/d/e.txt",
    "a/b2.txt",
    "a/B/upper.txt",
    "ab/z.txt",
    "abc.txt",
    "b/q.txt",
    "top.txt",
    ".dot/f.txt",
  ];

  const populated = async () => {
    const root = await fresh();
    const store = createBlobstoreFilesystem({ root });
    for (const [index, key] of KEYS.entries()) expectOk(await store.put(key, new Uint8Array(index + 1)));
    await writeFile(join(root, "a", "b", "c.txt.meta.json"), "{}");
    await writeFile(join(root, "a", "b", "c.txt.0123456789ab.kestrel-tmp"), "partial");
    await writeFile(join(root, "a", "x.txt.deadbeef.kestrel-tmp"), "partial");
    return { root, store };
  };

  const listed = async (store: ReturnType<typeof createBlobstoreFilesystem>, prefix: string) =>
    expectOk(await store.list(prefix));

  const prefixes = [
    "",
    "a",
    "a/",
    "a/b",
    "a/b/",
    "a/b/d",
    "a/b/d/",
    "a/b/d/e.txt",
    "a/b/d/e.txt/",
    "a/b/c",
    "a/b/c.txt.",
    "a/x.txt.dead",
    "a/B",
    "a/b2",
    "a/b2.txt/",
    "ab",
    "abc",
    "abc.txt",
    "abcd",
    "b",
    "b/",
    "b/q",
    "top",
    "top.txt/",
    ".",
    ".d",
    ".dot/",
    "missing",
    "missing/",
    "a/missing/",
    "a/b/missing",
    "/",
    "/a",
    "a//",
    "a//b",
    "a/./",
    "a/../",
    "../",
    "a/.",
  ];

  it.each(prefixes)("returns exactly the keys that start with %j, sorted by key", async (prefix) => {
    const { store } = await populated();
    const everything = await listed(store, "");
    const expected = everything.filter((info) => info.key.startsWith(prefix));
    expect(await listed(store, prefix)).toEqual(expected);
  });

  it("lists every key under the empty prefix and hides sidecars and temporary files", async () => {
    const { store } = await populated();
    const keys = (await listed(store, "")).map((info) => info.key);
    expect(keys).toEqual([...KEYS].sort((a, b) => a.localeCompare(b)));
  });

  it("returns sizes and ordering for nested and partial prefixes", async () => {
    const { store } = await populated();
    expect(await listed(store, "a/b/")).toEqual([
      { key: "a/b/c.txt", size: 3 },
      { key: "a/b/d/e.txt", size: 4 },
    ]);
    expect(await listed(store, "a/b")).toEqual([
      { key: "a/b/c.txt", size: 3 },
      { key: "a/b/d/e.txt", size: 4 },
      { key: "a/b2.txt", size: 5 },
    ]);
    expect(await listed(store, "ab")).toEqual([
      { key: "ab/z.txt", size: 7 },
      { key: "abc.txt", size: 8 },
    ]);
  });

  it("returns nothing when the directory part of the prefix is a file", async () => {
    const { store } = await populated();
    expect(await listed(store, "a/x.txt/")).toEqual([]);
    expect(await listed(store, "a/x.txt/y")).toEqual([]);
  });

  it("returns nothing for a prefix whose directory does not exist", async () => {
    const { store } = await populated();
    expect(await listed(store, "nope/deeper/")).toEqual([]);
  });

  it("returns nothing for a prefix that cannot match any key, without touching the disk", async () => {
    const { store } = await populated();
    vi.mocked(readdir).mockClear();
    vi.mocked(stat).mockClear();
    for (const prefix of ["/", "/a", "a//", "../", "a/../", "a/./b", "../x"]) {
      expect(await listed(store, prefix)).toEqual([]);
    }
    expect(vi.mocked(readdir)).not.toHaveBeenCalled();
    expect(vi.mocked(stat)).not.toHaveBeenCalled();
  });

  it("reads only the directory named by the prefix and stats only the files below it", async () => {
    const { root, store } = await populated();
    vi.mocked(readdir).mockClear();
    vi.mocked(stat).mockClear();
    expect((await listed(store, "a/b/")).map((info) => info.key)).toEqual(["a/b/c.txt", "a/b/d/e.txt"]);
    const read = vi.mocked(readdir).mock.calls.map(([path]) => String(path)).sort();
    expect(read).toEqual([join(root, "a", "b"), join(root, "a", "b", "d")]);
    const statted = vi.mocked(stat).mock.calls.map(([path]) => String(path)).sort();
    expect(statted).toEqual([join(root, "a", "b", "c.txt"), join(root, "a", "b", "d", "e.txt")]);
  });

  it("descends only into entries that match the partial last segment", async () => {
    const { root, store } = await populated();
    vi.mocked(readdir).mockClear();
    vi.mocked(stat).mockClear();
    expect((await listed(store, "a/b")).map((info) => info.key)).toEqual(["a/b/c.txt", "a/b/d/e.txt", "a/b2.txt"]);
    const read = vi.mocked(readdir).mock.calls.map(([path]) => String(path)).sort();
    expect(read).toEqual([join(root, "a"), join(root, "a", "b"), join(root, "a", "b", "d")].sort());
    const statted = vi.mocked(stat).mock.calls.map(([path]) => String(path)).sort();
    expect(statted).toEqual([join(root, "a", "b", "c.txt"), join(root, "a", "b", "d", "e.txt"), join(root, "a", "b2.txt")].sort());
  });

  it("never reads or stats anything outside the subtree that can hold the prefix", async () => {
    const { root, store } = await populated();
    for (const prefix of ["a/", "a/x", "ab/", "b/q", "a/b/d/"]) {
      vi.mocked(readdir).mockClear();
      vi.mocked(stat).mockClear();
      await listed(store, prefix);
      const dir = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "";
      const base = join(root, ...dir.split("/").filter(Boolean));
      const touched = [...vi.mocked(readdir).mock.calls, ...vi.mocked(stat).mock.calls].map(([path]) => String(path));
      expect(touched.length).toBeGreaterThan(0);
      for (const path of touched) expect(path === base || path.startsWith(base + sep)).toBe(true);
    }
  });

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "lists a prefix while a sibling directory is unreadable",
    async () => {
      const { root, store } = await populated();
      const sibling = join(root, "b");
      await chmod(sibling, 0o000);
      try {
        expect(await listed(store, "a/b/")).toEqual([
          { key: "a/b/c.txt", size: 3 },
          { key: "a/b/d/e.txt", size: 4 },
        ]);
        expect((await listed(store, "ab")).map((info) => info.key)).toEqual(["ab/z.txt", "abc.txt"]);
      } finally {
        await chmod(sibling, 0o755);
      }
    },
  );
});
