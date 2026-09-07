import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, it, expect, vi } from "vitest";
import { ok } from "@michaelthielemann/kestrel/result";
import { blobstoreContractTests } from "@michaelthielemann/kestrel-contracts/blobstore.contract.test";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { clientOptions, createBlobstoreS3, DEFAULT_MAX_ATTEMPTS, DEFAULT_TIMEOUT_MS, type S3Like } from "./impl.ts";

function fakeS3(): S3Like & { objects: Map<string, { data: Uint8Array; contentType: string }> } {
  const objects = new Map<string, { data: Uint8Array; contentType: string }>();
  return {
    objects,
    async send(command) {
      if (command instanceof PutObjectCommand) {
        objects.set(command.input.Key ?? "", { data: new Uint8Array(command.input.Body as Uint8Array), contentType: command.input.ContentType ?? "" });
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const obj = objects.get(command.input.Key ?? "");
        if (!obj) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
        return { Body: { transformToByteArray: async () => obj.data }, ContentType: obj.contentType };
      }
      if (command instanceof DeleteObjectCommand) {
        objects.delete(command.input.Key ?? "");
        return {};
      }
      if (command instanceof ListObjectsV2Command) {
        const prefix = command.input.Prefix ?? "";
        return { Contents: [...objects].filter(([k]) => k.startsWith(prefix)).map(([Key, v]) => ({ Key, Size: v.data.byteLength })) };
      }
      if (command instanceof CopyObjectCommand) {
        const [, path = ""] = (command.input.CopySource ?? "").split(/\/(.*)/s);
        const source = path.split("/").map((segment) => decodeURIComponent(segment)).join("/");
        const obj = objects.get(source);
        if (!obj) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
        objects.set(command.input.Key ?? "", { ...obj });
        return {};
      }
      throw new Error("unexpected command");
    },
  };
}

function failingS3(error: unknown): S3Like {
  return { async send() { throw error; } };
}

const withFake = async () => createBlobstoreS3({ bucket: "b", prefix: "site/" }, fakeS3());

blobstoreContractTests(async () => {
  const store = await withFake();
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

describe("blobstore/s3", () => {
  it("prefixes every key", async () => {
    const s3 = fakeS3();
    const store = createBlobstoreS3({ bucket: "b", prefix: "site/" }, s3);
    expectOk(await store.put("img/a.png", { data: new Uint8Array([1]), contentType: "image/png" }));
    expect([...s3.objects.keys()]).toEqual(["site/img/a.png"]);
    expect(expectOk(await store.list("img/")).map((i) => i.key)).toEqual(["img/a.png"]);
  });

  it("builds CopySource as a path, encoding the segments but keeping the slashes", async () => {
    const s3 = fakeS3();
    const store = createBlobstoreS3({ bucket: "b", prefix: "site/" }, s3);
    let copySource = "";
    const original = s3.send.bind(s3);
    s3.send = async (command) => {
      if (command instanceof CopyObjectCommand) copySource = command.input.CopySource ?? "";
      return original(command);
    };
    expectOk(await store.put("media/2026/a b+c.png", { data: new Uint8Array([1]), contentType: "image/png" }));
    expectOk(await store.move("media/2026/a b+c.png", "media/2027/a b+c.png"));
    expect(copySource).toBe("b/site/media/2026/a%20b%2Bc.png");
    expect([...s3.objects.keys()]).toEqual(["site/media/2027/a b+c.png"]);
  });

  it("reports a copy that 404s as NOT_FOUND, however the SDK names it", async () => {
    const missing = createBlobstoreS3({ bucket: "b", prefix: "" }, failingS3(Object.assign(new Error("boom"), { name: "NotFound", $metadata: { httpStatusCode: 404 } })));
    expect(expectErr(await missing.move("a.png", "b.png"), "NOT_FOUND").message).toMatch(/not found/);
  });

  it("lets a config bug like AccessDenied throw", async () => {
    const broken = createBlobstoreS3({ bucket: "b", prefix: "" }, failingS3(Object.assign(new Error("boom"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } })));
    await expect(broken.move("a.png", "b.png")).rejects.toThrow(/boom/);
  });

  it("rejects empty and absolute keys", async () => {
    const store = createBlobstoreS3({ bucket: "b", prefix: "" }, fakeS3());
    await expect(store.get("")).rejects.toThrow(/invalid key/);
    await expect(store.get("/x")).rejects.toThrow(/invalid key/);
  });

  it("sets connect/request timeouts and a retry limit on the client", () => {
    expect(clientOptions({ bucket: "b", prefix: "", timeoutMs: 1234, maxAttempts: 7 })).toMatchObject({ maxAttempts: 7, requestHandler: { connectionTimeout: 1234, requestTimeout: 1234 } });
    expect(clientOptions({ bucket: "b", prefix: "" })).toMatchObject({ maxAttempts: DEFAULT_MAX_ATTEMPTS, requestHandler: { connectionTimeout: DEFAULT_TIMEOUT_MS, requestTimeout: DEFAULT_TIMEOUT_MS } });
  });

  it("close() destroys a real S3Client, and is a no-op for a stub client", () => {
    const destroy = vi.spyOn(S3Client.prototype, "destroy");
    createBlobstoreS3({ bucket: "b", prefix: "" }).close();
    expect(destroy).toHaveBeenCalledTimes(1);
    destroy.mockRestore();
    expect(() => createBlobstoreS3({ bucket: "b", prefix: "" }, fakeS3()).close()).not.toThrow();
  });

  describe("TRANSIENT after the SDK's own retries", () => {
    const cases: Array<[string, unknown]> = [
      ["500 status", { $metadata: { httpStatusCode: 500 } }],
      ["429 status", { $metadata: { httpStatusCode: 429 } }],
      ["$retryable set", { $retryable: true }],
      ["TimeoutError name", { name: "TimeoutError" }],
      ["NetworkingError name", { name: "NetworkingError" }],
      ["AbortError name", { name: "AbortError" }],
      ["ECONNRESET code", { code: "ECONNRESET" }],
      ["ECONNREFUSED code", { code: "ECONNREFUSED" }],
      ["ETIMEDOUT code", { code: "ETIMEDOUT" }],
      ["EPIPE code", { code: "EPIPE" }],
      ["EAI_AGAIN code", { code: "EAI_AGAIN" }],
    ];

    for (const [label, shape] of cases) {
      it(`put/get/remove/list answer TRANSIENT on ${label}`, async () => {
        const store = createBlobstoreS3({ bucket: "b", prefix: "" }, failingS3(Object.assign(new Error("boom"), shape)));
        expectErr(await store.put("k", { data: new Uint8Array(), contentType: "text/plain" }), "TRANSIENT");
        expectErr(await store.get("k"), "TRANSIENT");
        expectErr(await store.remove("k"), "TRANSIENT");
        expectErr(await store.list(""), "TRANSIENT");
      });
    }

    it("move answers TRANSIENT when the copy step fails transiently", async () => {
      const store = createBlobstoreS3({ bucket: "b", prefix: "" }, failingS3(Object.assign(new Error("boom"), { $metadata: { httpStatusCode: 503 } })));
      expectErr(await store.move("a", "b"), "TRANSIENT");
    });

    it("move answers TRANSIENT when the delete step (after a successful copy) fails transiently", async () => {
      const s3 = fakeS3();
      const store = createBlobstoreS3({ bucket: "b", prefix: "" }, s3);
      expectOk(await store.put("a", { data: new Uint8Array([1]), contentType: "text/plain" }));
      const original = s3.send.bind(s3);
      s3.send = async (command) => {
        if (command instanceof DeleteObjectCommand) throw Object.assign(new Error("boom"), { $metadata: { httpStatusCode: 500 } });
        return original(command);
      };
      expectErr(await store.move("a", "b"), "TRANSIENT");
    });
  });

  it("get treats NoSuchKey as Ok(null) rather than TRANSIENT", async () => {
    const store = createBlobstoreS3({ bucket: "b", prefix: "" }, failingS3(Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" })));
    expect(expectOk(await store.get("missing"))).toBeNull();
  });
});
