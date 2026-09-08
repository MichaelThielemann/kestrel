import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { blobstoreContractTests } from "@michaelthielemann/kestrel-contracts/blobstore.contract.test";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { assertKey, createBlobstoreFilesystem } from "./impl.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
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
});
