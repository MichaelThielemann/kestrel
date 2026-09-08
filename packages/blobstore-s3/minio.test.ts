import { ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { describe, it, expect } from "vitest";
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

  async function contentTypeOf(prefix: string, key: string): Promise<string | undefined> {
    const out = (await client.send(new GetObjectCommand({ Bucket: bucket, Key: prefix + key }))) as { ContentType?: string };
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
});
