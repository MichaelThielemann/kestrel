import { ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { describe, it, expect } from "vitest";
import { blobstoreContractTests } from "@michaelthielemann/kestrel-contracts/blobstore.contract.test";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createS3Admin } from "./admin.ts";
import { createBlobstoreS3, createClient, type Config } from "./impl.ts";

const endpoint = process.env.KESTREL_S3_ENDPOINT;

describe.skipIf(!endpoint)("blobstore/s3 against MinIO", () => {
  const bucket = process.env.KESTREL_S3_BUCKET ?? "kestrel-test";
  const baseConfig: Config = {
    bucket,
    prefix: "",
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    accessKeyId: process.env.KESTREL_S3_ACCESS_KEY,
    secretAccessKey: process.env.KESTREL_S3_SECRET_KEY,
  };
  const client = createClient(baseConfig);

  async function clearPrefix(prefix: string): Promise<void> {
    let token: string | undefined;
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
      for (const item of page.Contents ?? []) {
        if (item.Key === undefined) continue;
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: item.Key }));
      }
      token = page.NextContinuationToken;
    } while (token);
  }

  function makeWith(prefix: string) {
    return async () => {
      await clearPrefix(prefix);
      return createBlobstoreS3({ ...baseConfig, prefix }, client);
    };
  }

  async function contentTypeOf(prefix: string, key: string): Promise<string | undefined> {
    const out = boundaryCast<{ ContentType?: string }>(await client.send(new GetObjectCommand({ Bucket: bucket, Key: prefix + key })), "host");
    return out.ContentType;
  }

  const runPrefix = `minio-test/${Date.now()}-${Math.random().toString(36).slice(2)}/`;

  blobstoreContractTests(makeWith(runPrefix));

  describe("extra cases", () => {
    const bytes = new TextEncoder().encode("hello minio");

    it("works under a nested prefix", async () => {
      const prefix = `${runPrefix}a/b/`;
      const store = await makeWith(prefix)();
      expectOk(await store.put("x.txt", bytes, { contentType: "text/plain" }));
      expect(await contentTypeOf(prefix, "x.txt")).toBe("text/plain");
      expect(expectOk(await store.list("")).map((i) => i.key)).toEqual(["x.txt"]);
    });

    it("round-trips keys with space, +, umlaut and percent", async () => {
      const store = await makeWith(`${runPrefix}odd-keys/`)();
      const keys = ["a b.txt", "a+b.txt", "ä.txt", "100%.txt"];
      for (const key of keys) {
        expectOk(await store.put(key, bytes, { contentType: "text/plain" }));
      }
      for (const key of keys) {
        const data = expectOk(await store.get(key));
        expect(Array.from(data ?? [])).toEqual(Array.from(bytes));
      }
      expect(expectOk(await store.list("")).map((i) => i.key).sort()).toEqual([...keys].sort());
    });

    it("move onto an existing key overwrites it", async () => {
      const prefix = `${runPrefix}move-overwrite/`;
      const store = await makeWith(prefix)();
      expectOk(await store.put("src.txt", bytes, { contentType: "text/plain" }));
      expectOk(await store.put("dst.txt", new Uint8Array([9]), { contentType: "application/octet-stream" }));
      expectOk(await store.move("src.txt", "dst.txt"));
      expect(expectOk(await store.get("src.txt"))).toBeNull();
      const dst = expectOk(await store.get("dst.txt"));
      expect(await contentTypeOf(prefix, "dst.txt")).toBe("text/plain");
      expect(Array.from(dst ?? [])).toEqual(Array.from(bytes));
    });

    it("move of a missing key answers NOT_FOUND", async () => {
      const store = await makeWith(`${runPrefix}move-missing/`)();
      expect(expectErr(await store.move("nope.txt", "also-nope.txt"), "NOT_FOUND").message).toMatch(/not found/);
    });

    it("move across directories", async () => {
      const prefix = `${runPrefix}move-dirs/`;
      const store = await makeWith(prefix)();
      expectOk(await store.put("a/x.txt", bytes, { contentType: "text/plain" }));
      expectOk(await store.move("a/x.txt", "b/c/x.txt"));
      expect(expectOk(await store.get("a/x.txt"))).toBeNull();
      expect(expectOk(await store.get("b/c/x.txt"))).not.toBeNull();
      expect(await contentTypeOf(prefix, "b/c/x.txt")).toBe("text/plain");
      expect(expectOk(await store.list("")).map((i) => i.key)).toEqual(["b/c/x.txt"]);
    });
  });
  describe("admin", () => {
    const bytes = new TextEncoder().encode("hello admin");

    async function adminWith(prefix: string) {
      await clearPrefix(prefix);
      return createS3Admin({ ...baseConfig, prefix }, client);
    }

    it("lists with size, ETag and server time, and heads the same object", async () => {
      const prefix = `${runPrefix}admin-list/`;
      const store = createBlobstoreS3({ ...baseConfig, prefix }, client);
      const admin = await adminWith(prefix);
      expectOk(await store.put("a/x.txt", bytes, { contentType: "text/plain" }));
      expectOk(await store.put("b.txt", new Uint8Array([1, 2]), { contentType: "text/plain" }));
      const listed = expectOk(await admin.listDetailed(""));
      expect(listed.map((item) => [item.key, item.size])).toEqual([["a/x.txt", bytes.byteLength], ["b.txt", 2]]);
      expect(listed[0]?.etag).toMatch(/^[0-9a-f]{32}$/);
      expect(listed[0]?.lastModified).toBeGreaterThan(Date.now() - 60_000);
      const head = expectOk(await admin.head("a/x.txt"));
      expect(head).toMatchObject({ key: "a/x.txt", size: bytes.byteLength, etag: listed[0]?.etag });
      expect(expectOk(await admin.head("missing.txt"))).toBeNull();
    });

    it("copies on the server, verifies the size and refuses a stale source ETag without writing", async () => {
      const prefix = `${runPrefix}admin-copy/`;
      const store = createBlobstoreS3({ ...baseConfig, prefix }, client);
      const admin = await adminWith(prefix);
      expectOk(await store.put("src.txt", bytes, { contentType: "text/plain" }));
      const etag = expectOk(await admin.head("src.txt"))?.etag ?? "";
      const copied = expectOk(await admin.copy("src.txt", "objects/dst.txt", { ifMatch: etag }));
      expect(copied.size).toBe(bytes.byteLength);
      expect(Array.from(expectOk(await store.get("objects/dst.txt")) ?? [])).toEqual(Array.from(bytes));
      expect(await contentTypeOf(prefix, "objects/dst.txt")).toBe("text/plain");
      expectOk(await store.put("src.txt", new TextEncoder().encode("changed source"), { contentType: "text/plain" }));
      expectErr(await admin.copy("src.txt", "objects/stale.txt", { ifMatch: etag }), "PRECONDITION_FAILED");
      expect(expectOk(await store.get("objects/stale.txt"))).toBeNull();
      expectErr(await admin.copy("absent.txt", "objects/x.txt"), "NOT_FOUND");
    });

    it("reads a server time close to the local clock and leaves no probe object", async () => {
      const prefix = `${runPrefix}admin-clock/`;
      const admin = await adminWith(prefix);
      const clock = expectOk(await admin.serverTime());
      expect(Math.abs(clock.skewMs)).toBeLessThan(30_000);
      expect(expectOk(await admin.listDetailed(""))).toEqual([]);
    });

    it("probes the write conditions and leaves no scratch keys", async () => {
      const prefix = `${runPrefix}admin-probe/`;
      const admin = await adminWith(prefix);
      const probed = expectOk(await admin.probeCapabilities());
      expect(probed.copySourceIfMatch).toMatchObject({ supported: true, outcome: "enforced" });
      for (const capability of [probed.conditionalCreate, probed.conditionalOverwrite]) {
        expect(typeof capability.supported).toBe("boolean");
        expect(capability.supported).toBe(capability.outcome === "enforced");
      }
      expect(expectOk(await admin.listDetailed(""))).toEqual([]);
    });
  });
});
