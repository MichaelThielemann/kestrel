import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createS3Admin, normalizeEtag, type S3AdminLike } from "./admin.ts";

interface StoredObject {
  data: Uint8Array;
  etag: string;
  lastModified: Date;
  visibleFromListing: number;
  previous?: { size: number; etag: string; remainingStaleHeads: number };
}

interface FakeBehaviour {
  ignoreConditions?: boolean;
  notImplementedConditions?: boolean;
  listingLag?: number;
  staleHeadsAfterOverwrite?: number;
  truncateCopyTo?: number;
  pageSize?: number;
  clockOffsetMs?: number;
}

function httpError(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

function fakeS3(behaviour: FakeBehaviour = {}) {
  const objects = new Map<string, StoredObject>();
  const sent: unknown[] = [];
  let listCalls = 0;
  let sequence = 0;
  const etagOf = (): string => `"etag-${++sequence}"`;

  function store(key: string, data: Uint8Array): void {
    const existing = objects.get(key);
    const object: StoredObject = {
      data,
      etag: etagOf(),
      lastModified: new Date(Date.now() + (behaviour.clockOffsetMs ?? 0)),
      visibleFromListing: listCalls + (behaviour.listingLag ?? 0) + 1,
    };
    if (existing !== undefined && (behaviour.staleHeadsAfterOverwrite ?? 0) > 0) {
      object.previous = { size: existing.data.byteLength, etag: existing.etag, remainingStaleHeads: behaviour.staleHeadsAfterOverwrite ?? 0 };
    }
    objects.set(key, object);
  }

  function conditional(headers: Array<string | undefined>): boolean {
    if (!headers.some((header) => header !== undefined)) return false;
    if (behaviour.notImplementedConditions === true) throw httpError("NotImplemented", 501);
    return behaviour.ignoreConditions !== true;
  }

  const client: S3AdminLike = {
    async send(command) {
      sent.push(command);
      if (command instanceof PutObjectCommand) {
        const key = command.input.Key ?? "";
        const { IfNoneMatch, IfMatch } = command.input;
        if (conditional([IfNoneMatch, IfMatch])) {
          const existing = objects.get(key);
          if (IfNoneMatch === "*" && existing !== undefined) throw httpError("PreconditionFailed", 412);
          if (IfMatch !== undefined && existing?.etag !== IfMatch) throw httpError("PreconditionFailed", 412);
        }
        store(key, new Uint8Array(boundaryCast<Uint8Array>(command.input.Body, "host")));
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const object = objects.get(command.input.Key ?? "");
        if (object === undefined) throw httpError("NoSuchKey", 404);
        return { Body: { transformToByteArray: async () => object.data } };
      }
      if (command instanceof DeleteObjectCommand) {
        objects.delete(command.input.Key ?? "");
        return {};
      }
      if (command instanceof HeadObjectCommand) {
        const object = objects.get(command.input.Key ?? "");
        if (object === undefined) throw httpError("NotFound", 404);
        if (object.previous !== undefined && object.previous.remainingStaleHeads > 0) {
          object.previous.remainingStaleHeads -= 1;
          return { ContentLength: object.previous.size, ETag: object.previous.etag, LastModified: new Date(Math.floor(object.lastModified.getTime() / 1000) * 1000) };
        }
        return { ContentLength: object.data.byteLength, ETag: object.etag, LastModified: new Date(Math.floor(object.lastModified.getTime() / 1000) * 1000) };
      }
      if (command instanceof ListObjectsV2Command) {
        listCalls += 1;
        const prefix = command.input.Prefix ?? "";
        const matching = [...objects]
          .filter(([key, object]) => key.startsWith(prefix) && object.visibleFromListing <= listCalls)
          .sort(([a], [b]) => (a < b ? -1 : 1));
        const start = command.input.ContinuationToken === undefined ? 0 : Number(command.input.ContinuationToken);
        const size = behaviour.pageSize ?? matching.length;
        const page = matching.slice(start, start + Math.max(size, 1));
        return {
          Contents: page.map(([Key, object]) => ({ Key, Size: object.data.byteLength, ETag: object.etag, LastModified: object.lastModified })),
          ...(start + size < matching.length ? { NextContinuationToken: String(start + size) } : {}),
        };
      }
      if (command instanceof CopyObjectCommand) {
        const [, path = ""] = (command.input.CopySource ?? "").split(/\/(.*)/s);
        const source = path.split("/").map((segment) => decodeURIComponent(segment)).join("/");
        const object = objects.get(source);
        if (object === undefined) throw httpError("NoSuchKey", 404);
        const { CopySourceIfMatch } = command.input;
        if (conditional([CopySourceIfMatch]) && CopySourceIfMatch !== undefined && CopySourceIfMatch !== object.etag) throw httpError("PreconditionFailed", 412);
        const data = behaviour.truncateCopyTo === undefined ? object.data : object.data.slice(0, behaviour.truncateCopyTo);
        store(command.input.Key ?? "", data);
        return {};
      }
      throw new Error("unexpected command");
    },
  };

  return {
    client,
    objects,
    sent,
    put: (key: string, bytes: number | string): void => store(key, typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes)),
    etagOf: (key: string): string => objects.get(key)?.etag ?? "",
  };
}

const failingS3 = (error: unknown): S3AdminLike => ({
  async send() {
    throw error;
  },
});

describe("blobstore/s3 admin: listDetailed", () => {
  it("reports key, size, unquoted ETag and server modification time, ordered by key", async () => {
    const s3 = fakeS3();
    s3.put("media/b.png", 3);
    s3.put("media/a.png", 5);
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client);
    const listed = expectOk(await admin.listDetailed("media/"));
    expect(listed.map((item) => [item.key, item.size])).toEqual([["media/a.png", 5], ["media/b.png", 3]]);
    expect(listed[0]?.etag).toBe(normalizeEtag(s3.etagOf("media/a.png")));
    expect(listed[0]?.etag).not.toContain('"');
    expect(listed[0]?.lastModified).toBe(s3.objects.get("media/a.png")?.lastModified.getTime());
  });

  it("follows continuation tokens across pages", async () => {
    const s3 = fakeS3({ pageSize: 2 });
    for (let i = 0; i < 5; i += 1) s3.put(`k/${i}`, i + 1);
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client);
    expect(expectOk(await admin.listDetailed("k/")).map((item) => item.key)).toEqual(["k/0", "k/1", "k/2", "k/3", "k/4"]);
  });

  it("scopes to the configured prefix and returns keys relative to it", async () => {
    const s3 = fakeS3();
    s3.put("site/a.html", 1);
    s3.put("other/b.html", 1);
    const admin = createS3Admin({ bucket: "b", prefix: "site/" }, s3.client);
    expect(expectOk(await admin.listDetailed("")).map((item) => item.key)).toEqual(["a.html"]);
  });

  it("answers TRANSIENT after the SDK's retries and lets a denied request throw", async () => {
    const transient = createS3Admin({ bucket: "b", prefix: "" }, failingS3(httpError("ServiceUnavailable", 503)));
    expectErr(await transient.listDetailed(""), "TRANSIENT");
    const denied = createS3Admin({ bucket: "b", prefix: "" }, failingS3(httpError("AccessDenied", 403)));
    await expect(denied.listDetailed("")).rejects.toThrow(/AccessDenied/);
  });
});

describe("blobstore/s3 admin: head", () => {
  it("describes an object, with the key relative to the prefix", async () => {
    const s3 = fakeS3();
    s3.put("site/a.html", 7);
    const admin = createS3Admin({ bucket: "b", prefix: "site/" }, s3.client);
    const head = expectOk(await admin.head("a.html"));
    expect(head).toMatchObject({ key: "a.html", size: 7, etag: normalizeEtag(s3.etagOf("site/a.html")) });
    expect(head?.lastModified).toBe(Math.floor((s3.objects.get("site/a.html")?.lastModified.getTime() ?? 0) / 1000) * 1000);
  });

  it("answers Ok(null) for a missing key", async () => {
    const admin = createS3Admin({ bucket: "b", prefix: "" }, fakeS3().client);
    expect(expectOk(await admin.head("nope"))).toBeNull();
  });

  it("answers TRANSIENT, rejects invalid keys and lets a denied request throw", async () => {
    expectErr(await createS3Admin({ bucket: "b", prefix: "" }, failingS3(httpError("SlowDown", 503))).head("k"), "TRANSIENT");
    await expect(createS3Admin({ bucket: "b", prefix: "" }, fakeS3().client).head("")).rejects.toThrow(/invalid key/);
    await expect(createS3Admin({ bucket: "b", prefix: "" }, failingS3(httpError("AccessDenied", 403))).head("k")).rejects.toThrow(/AccessDenied/);
  });
});

describe("blobstore/s3 admin: lifecycle", () => {
  it("close() destroys a real S3Client and is a no-op for a stub", () => {
    const destroy = vi.spyOn(S3Client.prototype, "destroy");
    createS3Admin({ bucket: "b", prefix: "" }).close();
    expect(destroy).toHaveBeenCalledTimes(1);
    destroy.mockRestore();
    expect(() => createS3Admin({ bucket: "b", prefix: "" }, fakeS3().client).close()).not.toThrow();
  });
});

describe("blobstore/s3 admin: package entry", () => {
  it("is exported from source and, as compiled output, from the published package", () => {
    const pkg = boundaryCast<{ exports: Record<string, unknown>; publishConfig: { exports: Record<string, unknown> } }>(JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")), "json");
    expect(pkg.exports["./admin"]).toBe("./admin.ts");
    expect(pkg.publishConfig.exports["./admin"]).toEqual({ types: "./dist/admin.d.ts", default: "./dist/admin.js" });
  });
});
