import { ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { describe, it, expect } from "vitest";
import { ok } from "@michaelthielemann/kestrel/result";
import { blobstoreContractTests } from "@michaelthielemann/kestrel-contracts/blobstore.contract.test";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createBlobstoreS3, createClient, type Config } from "./impl.ts";

const endpoint = process.env.KESTREL_S3_ENDPOINT;

// Only runs against a real S3-compatible target (see scripts/s3-minio.mjs); a fake proves
// nothing about CopySource encoding or NoSuchKey/404 detection on CopyObject.
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

  const runPrefix = `minio-test/${Date.now()}-${Math.random().toString(36).slice(2)}/`;

  // S3 listings carry no content-type metadata (README); the contract test expects list() to
  // report it, so backfill it from get() the way the fake-backed impl.test.ts does.
  blobstoreContractTests(async () => {
    const store = await makeWith(runPrefix)();
    return {
      ...store,
      async list(prefix) {
        const infos = await store.list(prefix);
        if (!infos.ok) return infos;
        const fake = await Promise.all(
          infos.value.map(async (i) => {
            const blob = await store.get(i.key);
            return { ...i, contentType: blob.ok && blob.value ? blob.value.contentType : i.contentType };
          }),
        );
        return ok(fake);
      },
    };
  });

  describe("extra cases", () => {
    const bytes = new TextEncoder().encode("hello minio");

    it("works under a nested prefix", async () => {
      const store = await makeWith(`${runPrefix}a/b/`)();
      expectOk(await store.put("x.txt", { data: bytes, contentType: "text/plain" }));
      expect(expectOk(await store.get("x.txt"))?.contentType).toBe("text/plain");
      expect(expectOk(await store.list("")).map((i) => i.key)).toEqual(["x.txt"]);
    });

    it("round-trips keys with space, +, umlaut and percent", async () => {
      const store = await makeWith(`${runPrefix}odd-keys/`)();
      const keys = ["a b.txt", "a+b.txt", "ä.txt", "100%.txt"];
      for (const key of keys) {
        expectOk(await store.put(key, { data: bytes, contentType: "text/plain" }));
      }
      for (const key of keys) {
        const blob = expectOk(await store.get(key));
        expect(Array.from(blob?.data ?? [])).toEqual(Array.from(bytes));
      }
      expect(expectOk(await store.list("")).map((i) => i.key).sort()).toEqual([...keys].sort());
    });

    it("move onto an existing key overwrites it", async () => {
      const store = await makeWith(`${runPrefix}move-overwrite/`)();
      expectOk(await store.put("src.txt", { data: bytes, contentType: "text/plain" }));
      expectOk(await store.put("dst.txt", { data: new Uint8Array([9]), contentType: "application/octet-stream" }));
      expectOk(await store.move("src.txt", "dst.txt"));
      expect(expectOk(await store.get("src.txt"))).toBeNull();
      const dst = expectOk(await store.get("dst.txt"));
      expect(dst?.contentType).toBe("text/plain");
      expect(Array.from(dst?.data ?? [])).toEqual(Array.from(bytes));
    });

    it("move of a missing key answers NOT_FOUND", async () => {
      const store = await makeWith(`${runPrefix}move-missing/`)();
      expect(expectErr(await store.move("nope.txt", "also-nope.txt"), "NOT_FOUND").message).toMatch(/not found/);
    });

    it("move across directories", async () => {
      const store = await makeWith(`${runPrefix}move-dirs/`)();
      expectOk(await store.put("a/x.txt", { data: bytes, contentType: "text/plain" }));
      expectOk(await store.move("a/x.txt", "b/c/x.txt"));
      expect(expectOk(await store.get("a/x.txt"))).toBeNull();
      expect(expectOk(await store.get("b/c/x.txt"))?.contentType).toBe("text/plain");
      expect(expectOk(await store.list("")).map((i) => i.key)).toEqual(["b/c/x.txt"]);
    });
  });
});
