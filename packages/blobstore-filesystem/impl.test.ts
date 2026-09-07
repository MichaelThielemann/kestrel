import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
  it("rejects keys that escape the root or collide with metadata", async () => {
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
    const blob = { data: new Uint8Array([1]), contentType: "text/plain" };
    expectOk(await store.put("a/b/x.txt", blob));
    expectOk(await store.move("a/b/x.txt", "c/x.txt"));
    await expect(readdir(root)).resolves.toEqual(["c"]);

    expectOk(await store.put("c/d/y.txt", blob));
    expectOk(await store.remove("c/d/y.txt"));
    await expect(readdir(join(root, "c"))).resolves.toEqual(["x.txt", "x.txt.meta.json"]);
    expectOk(await store.remove("c/x.txt"));
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("move reports a blob whose meta file is missing as NOT_FOUND, leaving the data file in place", async () => {
    const root = await fresh();
    const store = createBlobstoreFilesystem({ root });
    const path = join(root, "a/x.txt");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "orphan");
    expect(expectErr(await store.move("a/x.txt", "b/y.txt"), "NOT_FOUND").message).toMatch(/not found/);
    await expect(readFile(path, "utf8")).resolves.toBe("orphan");
    expect(expectOk(await store.get("a/x.txt"))).toBeNull();
    expect(expectOk(await store.get("b/y.txt"))).toBeNull();
  });

  it("maps a transient IO error (EBUSY) to a retryable TRANSIENT Err instead of throwing", async () => {
    const root = await fresh();
    const store = createBlobstoreFilesystem({ root });
    const busy = Object.assign(new Error("resource busy"), { code: "EBUSY" });
    vi.mocked(writeFile).mockRejectedValueOnce(busy);
    const result = await store.put("a.txt", { data: new Uint8Array([1]), contentType: "text/plain" });
    const error = expectErr(result, "TRANSIENT");
    expect(error.retryable).toBe(true);
    expect(error.cause).toBe(busy);
  });

  it("rethrows a non-transient IO error as a bug", async () => {
    const root = await fresh();
    const store = createBlobstoreFilesystem({ root });
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.mocked(writeFile).mockRejectedValueOnce(denied);
    await expect(store.put("a.txt", { data: new Uint8Array([1]), contentType: "text/plain" })).rejects.toBe(denied);
  });
});
