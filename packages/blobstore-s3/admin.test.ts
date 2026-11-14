import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
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
  refuseAllConditions?: boolean;
  rejectConditionHeaders?: boolean;
  deleteMissingAnswers404?: boolean;
  truncatedListingWithoutToken?: boolean;
  repeatingContinuationToken?: boolean;
  missingBucket?: boolean;
  listingLag?: number;
  staleHeadsAfterOverwrite?: number;
  truncateCopyTo?: number;
  pageSize?: number;
  clockOffsetMs?: number;
  md5Etags?: boolean;
  serverSideEncryption?: "aws:kms";
}

function httpError(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

function fakeS3(behaviour: FakeBehaviour = {}) {
  const objects = new Map<string, StoredObject>();
  const sent: unknown[] = [];
  let listCalls = 0;
  let sequence = 0;
  const etagOf = (data: Uint8Array): string => {
    sequence += 1;
    if (behaviour.md5Etags === true) return `"${createHash("md5").update(data).digest("hex")}"`;
    if (behaviour.serverSideEncryption !== undefined) return `"${sequence.toString(16).padStart(32, "0")}"`;
    return `"etag-${sequence}"`;
  };
  const encryption = behaviour.serverSideEncryption === undefined ? {} : { ServerSideEncryption: behaviour.serverSideEncryption };

  function store(key: string, data: Uint8Array): void {
    const existing = objects.get(key);
    const object: StoredObject = {
      data,
      etag: etagOf(data),
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
    if (behaviour.refuseAllConditions === true) throw httpError("PreconditionFailed", 412);
    if (behaviour.rejectConditionHeaders === true) throw httpError("InvalidArgument", 400);
    return behaviour.ignoreConditions !== true;
  }

  const client: S3AdminLike = {
    async send(command) {
      sent.push(command);
      if (behaviour.missingBucket === true) {
        throw command instanceof HeadObjectCommand || command instanceof HeadBucketCommand ? httpError("NotFound", 404) : httpError("NoSuchBucket", 404);
      }
      if (command instanceof HeadBucketCommand) return {};
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
        if (behaviour.deleteMissingAnswers404 === true && !objects.has(command.input.Key ?? "")) throw httpError("NoSuchKey", 404);
        objects.delete(command.input.Key ?? "");
        return {};
      }
      if (command instanceof HeadObjectCommand) {
        const object = objects.get(command.input.Key ?? "");
        if (object === undefined) throw httpError("NotFound", 404);
        if (object.previous !== undefined && object.previous.remainingStaleHeads > 0) {
          object.previous.remainingStaleHeads -= 1;
          return { ...encryption, ContentLength: object.previous.size, ETag: object.previous.etag, LastModified: new Date(Math.floor(object.lastModified.getTime() / 1000) * 1000) };
        }
        return { ...encryption, ContentLength: object.data.byteLength, ETag: object.etag, LastModified: new Date(Math.floor(object.lastModified.getTime() / 1000) * 1000) };
      }
      if (command instanceof ListObjectsV2Command) {
        listCalls += 1;
        const prefix = command.input.Prefix ?? "";
        const matching = [...objects]
          .filter(([key, object]) => key.startsWith(prefix) && object.visibleFromListing <= listCalls)
          .sort(([a], [b]) => (a < b ? -1 : 1));
        const start = behaviour.repeatingContinuationToken === true || command.input.ContinuationToken === undefined ? 0 : Number(command.input.ContinuationToken);
        const size = behaviour.pageSize ?? matching.length;
        const page = matching.slice(start, start + Math.max(size, 1));
        const more = start + size < matching.length;
        const token = behaviour.repeatingContinuationToken === true ? "again" : String(start + size);
        return {
          Contents: page.map(([Key, object]) => ({ Key, Size: object.data.byteLength, ETag: object.etag, LastModified: object.lastModified })),
          IsTruncated: more,
          ...(more && behaviour.truncatedListingWithoutToken !== true ? { NextContinuationToken: token } : {}),
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
        return { ...encryption, CopyObjectResult: { ETag: objects.get(command.input.Key ?? "")?.etag } };
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

  it("throws instead of answering a partial list when a truncated page carries no continuation token", async () => {
    const s3 = fakeS3({ pageSize: 2, truncatedListingWithoutToken: true });
    for (let i = 0; i < 5; i += 1) s3.put(`k/${i}`, i + 1);
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client);
    await expect(admin.listDetailed("k/")).rejects.toThrow(/continuation token/);
  });

  it("throws when the store keeps answering with the same continuation token", async () => {
    const s3 = fakeS3({ pageSize: 2, repeatingContinuationToken: true });
    for (let i = 0; i < 5; i += 1) s3.put(`k/${i}`, i + 1);
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client);
    await expect(admin.listDetailed("k/")).rejects.toThrow(/continuation token/);
    expect(s3.sent.filter((sent) => sent instanceof ListObjectsV2Command).length).toBeLessThanOrEqual(3);
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

const fastOptions = { sleep: async (): Promise<void> => {}, retryDelayMs: 0 };

describe("blobstore/s3 admin: copy", () => {
  it("copies server-side under the prefix, encodes the source and reports the verified destination", async () => {
    const s3 = fakeS3();
    s3.put("site/media/a b+c.png", 12);
    const admin = createS3Admin({ bucket: "b", prefix: "site/" }, s3.client, fastOptions);
    const copied = expectOk(await admin.copy("media/a b+c.png", "objects/a b+c.png"));
    expect(copied.size).toBe(12);
    expect(s3.objects.get("site/objects/a b+c.png")?.data.byteLength).toBe(12);
    expect(s3.objects.has("site/media/a b+c.png")).toBe(true);
    const command = s3.sent.find((sent): sent is CopyObjectCommand => sent instanceof CopyObjectCommand);
    expect(command?.input.CopySource).toBe("b/site/media/a%20b%2Bc.png");
    expect(command?.input.MetadataDirective).toBe("COPY");
  });

  it("answers NOT_FOUND for a missing source without writing anything", async () => {
    const s3 = fakeS3();
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
    expectErr(await admin.copy("missing", "dst"), "NOT_FOUND");
    expect(s3.objects.size).toBe(0);
  });

  it("fails when the destination does not carry the source's size, naming both sizes", async () => {
    const s3 = fakeS3({ truncateCopyTo: 4 });
    s3.put("src", 10);
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
    const error = expectErr(await admin.copy("src", "dst"), "VERIFY_FAILED");
    expect(error.details).toMatchObject({ expectedSize: 10, actualSize: 4 });
  });

  it("waits out a stale read of a destination it just overwrote", async () => {
    const s3 = fakeS3({ staleHeadsAfterOverwrite: 2 });
    s3.put("dst", 3);
    s3.put("src", 9);
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
    expect(expectOk(await admin.copy("src", "dst")).size).toBe(9);
  });

  it("gives up on a destination that stays stale beyond the verification attempts", async () => {
    const s3 = fakeS3({ staleHeadsAfterOverwrite: 50 });
    s3.put("dst", 3);
    s3.put("src", 9);
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, { ...fastOptions, verifyAttempts: 3 });
    expectErr(await admin.copy("src", "dst"), "VERIFY_FAILED");
  });

  it("passes the expected source ETag as copy-source-if-match, quoted or not", async () => {
    const s3 = fakeS3();
    s3.put("src", 5);
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
    expectOk(await admin.copy("src", "dst", { ifMatch: normalizeEtag(s3.etagOf("src")) }));
    const command = s3.sent.find((sent): sent is CopyObjectCommand => sent instanceof CopyObjectCommand);
    expect(command?.input.CopySourceIfMatch).toBe(s3.etagOf("src"));
  });

  it("answers PRECONDITION_FAILED when the server rejects a stale ETag with 412", async () => {
    const s3 = fakeS3();
    s3.put("src", 5);
    const stale = normalizeEtag(s3.etagOf("src"));
    const original = s3.client.send.bind(s3.client);
    let headsServedFresh = 0;
    s3.client.send = async (command) => {
      if (command instanceof HeadObjectCommand && headsServedFresh === 0) {
        headsServedFresh += 1;
        return { ContentLength: 5, ETag: `"${stale}"`, LastModified: new Date() };
      }
      return original(command);
    };
    s3.put("src", 6);
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
    const error = expectErr(await admin.copy("src", "dst", { ifMatch: stale }), "PRECONDITION_FAILED");
    expect(error.details).toEqual({ expectedEtag: stale, foundEtag: normalizeEtag(s3.etagOf("src")), reason: "store-refused", destinationWritten: false });
    expect(s3.objects.has("dst")).toBe(false);
  });

  it("still refuses a stale ETag on a store that ignores conditional headers", async () => {
    const s3 = fakeS3({ ignoreConditions: true });
    s3.put("src", 5);
    const stale = normalizeEtag(s3.etagOf("src"));
    s3.put("src", 6);
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
    const error = expectErr(await admin.copy("src", "dst", { ifMatch: stale }), "PRECONDITION_FAILED");
    expect(error.details).toMatchObject({ expectedEtag: stale, foundEtag: normalizeEtag(s3.etagOf("src")), reason: "source-changed", destinationWritten: false });
    expect(s3.objects.has("dst")).toBe(false);
  });

  it("detects a source rewritten during the copy on a store that ignores conditional headers", async () => {
    const s3 = fakeS3({ ignoreConditions: true });
    s3.put("src", 5);
    const expected = normalizeEtag(s3.etagOf("src"));
    const original = s3.client.send.bind(s3.client);
    s3.client.send = async (command) => {
      const result = await original(command);
      if (command instanceof CopyObjectCommand) s3.put("src", 7);
      return result;
    };
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
    const error = expectErr(await admin.copy("src", "dst", { ifMatch: expected }), "PRECONDITION_FAILED");
    expect(error.details).toMatchObject({ reason: "source-changed", destinationWritten: true, destinationRemoved: true });
    expect(s3.objects.has("dst")).toBe(false);
  });

  it.each([["the same size", "BBBB"], ["another size", "BBBBBB"]])("removes a destination written from a source rewritten just before the copy, with %s", async (_label, rewritten) => {
    const s3 = fakeS3({ ignoreConditions: true });
    s3.put("src", "AAAA");
    const expected = normalizeEtag(s3.etagOf("src"));
    const original = s3.client.send.bind(s3.client);
    s3.client.send = async (command) => {
      if (command instanceof CopyObjectCommand) s3.put("src", rewritten);
      return original(command);
    };
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
    const error = expectErr(await admin.copy("src", "objects/src", { ifMatch: expected }), "PRECONDITION_FAILED");
    expect(error.details).toMatchObject({ expectedEtag: expected, reason: "source-changed", destinationWritten: true, destinationRemoved: true });
    expect(s3.objects.has("objects/src")).toBe(false);
  });

  it("reports a destination it could not remove after a source rewritten during the copy", async () => {
    const s3 = fakeS3({ ignoreConditions: true });
    s3.put("src", "AAAA");
    const expected = normalizeEtag(s3.etagOf("src"));
    const original = s3.client.send.bind(s3.client);
    s3.client.send = async (command) => {
      if (command instanceof CopyObjectCommand) s3.put("src", "BBBB");
      if (command instanceof DeleteObjectCommand) throw httpError("AccessDenied", 403);
      return original(command);
    };
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
    const error = expectErr(await admin.copy("src", "dst", { ifMatch: expected }), "PRECONDITION_FAILED");
    expect(error.details).toMatchObject({ destinationWritten: true, destinationRemoved: false });
    expect(s3.objects.has("dst")).toBe(true);
  });

  it("reports a source deleted during the copy without a found ETag and removes the destination", async () => {
    const s3 = fakeS3({ ignoreConditions: true });
    s3.put("src", "AAAA");
    const expected = normalizeEtag(s3.etagOf("src"));
    const original = s3.client.send.bind(s3.client);
    s3.client.send = async (command) => {
      const result = await original(command);
      if (command instanceof CopyObjectCommand) s3.objects.delete("src");
      return result;
    };
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
    const error = expectErr(await admin.copy("src", "dst", { ifMatch: expected }), "PRECONDITION_FAILED");
    expect(error.details).toMatchObject({ foundEtag: null, reason: "source-missing", destinationRemoved: true });
    expect(s3.objects.has("dst")).toBe(false);
  });

  it("removes a destination that does not carry the source's size", async () => {
    const s3 = fakeS3({ truncateCopyTo: 4 });
    s3.put("src", 10);
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
    const error = expectErr(await admin.copy("src", "dst"), "VERIFY_FAILED");
    expect(error.details).toMatchObject({ destinationRemoved: true });
    expect(s3.objects.has("dst")).toBe(false);
  });

  it("waits out a stale read of the same size and reports the ETag of the new destination", async () => {
    const s3 = fakeS3({ staleHeadsAfterOverwrite: 2 });
    s3.put("dst", "OLDX");
    const oldEtag = normalizeEtag(s3.etagOf("dst"));
    s3.put("src", "NEWX");
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
    const copied = expectOk(await admin.copy("src", "dst"));
    expect(copied.etag).not.toBe(oldEtag);
    expect(copied.etag).toBe(normalizeEtag(s3.etagOf("dst")));
  });

  it("gives up on a stale destination of the same size beyond the verification attempts", async () => {
    const s3 = fakeS3({ staleHeadsAfterOverwrite: 50 });
    s3.put("dst", "OLDX");
    s3.put("src", "NEWX");
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, { ...fastOptions, verifyAttempts: 3 });
    expectErr(await admin.copy("src", "dst"), "VERIFY_FAILED");
  });

  it("answers a missing bucket by throwing instead of reporting a missing key", async () => {
    const admin = createS3Admin({ bucket: "typo", prefix: "" }, fakeS3({ missingBucket: true }).client, fastOptions);
    await expect(admin.head("k")).rejects.toThrow(/bucket/);
    await expect(admin.copy("k", "d")).rejects.toThrow(/bucket/);
  });

  it("still answers Ok(null) and NOT_FOUND for a missing key in an existing bucket", async () => {
    const s3 = fakeS3();
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
    expect(expectOk(await admin.head("nope"))).toBeNull();
    expect(expectOk(await admin.head("still-nope"))).toBeNull();
    expectErr(await admin.copy("nope", "dst"), "NOT_FOUND");
    expect(s3.sent.filter((sent) => sent instanceof HeadBucketCommand).length).toBe(1);
  });

  it("falls back to its own checks when the store answers 501 to the conditional header", async () => {
    const s3 = fakeS3({ notImplementedConditions: true });
    s3.put("src", 5);
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
    expect(expectOk(await admin.copy("src", "dst", { ifMatch: normalizeEtag(s3.etagOf("src")) })).size).toBe(5);
    const copies = s3.sent.filter((sent): sent is CopyObjectCommand => sent instanceof CopyObjectCommand);
    expect(copies.map((copy) => copy.input.CopySourceIfMatch !== undefined)).toEqual([true, false]);
  });

  describe("on a store that cannot enforce the source condition itself", () => {
    const rewriteSourceOnCopy = (s3: ReturnType<typeof fakeS3>, when: "before" | "after", only?: (command: CopyObjectCommand) => boolean): void => {
      const original = s3.client.send.bind(s3.client);
      s3.client.send = async (command) => {
        const hit = command instanceof CopyObjectCommand && (only === undefined || only(command));
        if (hit && when === "before") s3.put("src", "CHANGED");
        const result = await original(command);
        if (hit && when === "after") s3.put("src", "CHANGED");
        return result;
      };
    };
    const copiesOf = (s3: ReturnType<typeof fakeS3>): CopyObjectCommand[] => s3.sent.filter((sent): sent is CopyObjectCommand => sent instanceof CopyObjectCommand);
    const stores = [["answers 400 to the conditional header", { rejectConditionHeaders: true }]] as const;

    it.each(stores)("copies an unchanged source on a store that %s", async (_label, behaviour) => {
      const s3 = fakeS3(behaviour);
      s3.put("src", "AAAA");
      const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
      expect(expectOk(await admin.copy("src", "dst", { ifMatch: normalizeEtag(s3.etagOf("src")) })).size).toBe(4);
      expect(s3.objects.has("dst")).toBe(true);
      expect(copiesOf(s3).map((copy) => copy.input.CopySourceIfMatch !== undefined)).toEqual([true, false]);
    });

    it("treats a 412 as final on a store that refuses every conditional request, and copies in compare mode", async () => {
      const s3 = fakeS3({ refuseAllConditions: true });
      s3.put("src", "AAAA");
      const expected = normalizeEtag(s3.etagOf("src"));
      const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
      const error = expectErr(await admin.copy("src", "dst", { ifMatch: expected }), "PRECONDITION_FAILED");
      expect(error.details).toEqual({ expectedEtag: expected, foundEtag: expected, reason: "store-refused", destinationWritten: false });
      expect(copiesOf(s3).length).toBe(1);
      expect(s3.objects.has("dst")).toBe(false);
      expect(expectOk(await admin.copy("src", "dst", { ifMatch: expected, sourceCheck: "compare" })).size).toBe(4);
    });

    it("keeps the store's 412 when the source is read stale after being overwritten", async () => {
      const s3 = fakeS3({ staleHeadsAfterOverwrite: 3 });
      s3.put("src", "AAAA");
      const listed = normalizeEtag(s3.etagOf("src"));
      s3.put("src", "BBBB");
      const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
      const error = expectErr(await admin.copy("src", "dst", { ifMatch: listed }), "PRECONDITION_FAILED");
      expect(error.details).toMatchObject({ expectedEtag: listed, reason: "store-refused", destinationWritten: false });
      expect(copiesOf(s3).length).toBe(1);
      expect(s3.objects.has("dst")).toBe(false);
    });

    it("reports the found ETag when a store that refuses every conditional request meets a changed source", async () => {
      const s3 = fakeS3({ refuseAllConditions: true });
      s3.put("src", "AAAA");
      const expected = normalizeEtag(s3.etagOf("src"));
      rewriteSourceOnCopy(s3, "before");
      const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
      const error = expectErr(await admin.copy("src", "dst", { ifMatch: expected }), "PRECONDITION_FAILED");
      expect(error.details).toEqual({ expectedEtag: expected, foundEtag: normalizeEtag(s3.etagOf("src")), reason: "store-refused", destinationWritten: false });
      expect(s3.objects.has("dst")).toBe(false);
    });

    it("answers a source deleted before the refused copy as missing", async () => {
      const s3 = fakeS3({ refuseAllConditions: true });
      s3.put("src", "AAAA");
      const expected = normalizeEtag(s3.etagOf("src"));
      const original = s3.client.send.bind(s3.client);
      s3.client.send = async (command) => {
        if (command instanceof CopyObjectCommand) {
          s3.objects.delete("src");
          throw httpError("PreconditionFailed", 412);
        }
        return original(command);
      };
      const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
      const error = expectErr(await admin.copy("src", "dst", { ifMatch: expected }), "PRECONDITION_FAILED");
      expect(error.details).toMatchObject({ foundEtag: null, reason: "source-missing", destinationWritten: false });
    });

    it.each(stores)("removes the destination when the source changes during a copy on a store that %s", async (_label, behaviour) => {
      const s3 = fakeS3(behaviour);
      s3.put("src", "AAAA");
      const expected = normalizeEtag(s3.etagOf("src"));
      rewriteSourceOnCopy(s3, "after", (command) => command.input.CopySourceIfMatch === undefined);
      const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
      const error = expectErr(await admin.copy("src", "dst", { ifMatch: expected }), "PRECONDITION_FAILED");
      expect(error.details).toMatchObject({ reason: "source-changed", destinationWritten: true, destinationRemoved: true });
      expect(s3.objects.has("dst")).toBe(false);
    });

    it("answers a transient re-read of the source after a refused copy with TRANSIENT", async () => {
      const s3 = fakeS3({ refuseAllConditions: true });
      s3.put("src", "AAAA");
      const expected = normalizeEtag(s3.etagOf("src"));
      const original = s3.client.send.bind(s3.client);
      let refused = false;
      s3.client.send = async (command) => {
        if (command instanceof HeadObjectCommand && refused) throw httpError("ServiceUnavailable", 503);
        try {
          return await original(command);
        } catch (cause) {
          if (command instanceof CopyObjectCommand) refused = true;
          throw cause;
        }
      };
      const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
      expectErr(await admin.copy("src", "dst", { ifMatch: expected }), "TRANSIENT");
      expect(s3.objects.has("dst")).toBe(false);
    });

    it('with sourceCheck "compare" never sends the conditional header and still detects a source changed during the copy', async () => {
      const s3 = fakeS3();
      s3.put("src", "AAAA");
      const expected = normalizeEtag(s3.etagOf("src"));
      const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
      expectOk(await admin.copy("src", "ok", { ifMatch: expected, sourceCheck: "compare" }));
      expect(copiesOf(s3).every((copy) => copy.input.CopySourceIfMatch === undefined)).toBe(true);
      rewriteSourceOnCopy(s3, "after");
      const error = expectErr(await admin.copy("src", "dst", { ifMatch: normalizeEtag(s3.etagOf("src")), sourceCheck: "compare" }), "PRECONDITION_FAILED");
      expect(error.details).toMatchObject({ reason: "source-changed", destinationWritten: true, destinationRemoved: true });
      expect(s3.objects.has("dst")).toBe(false);
    });

    it('sends the conditional header by default and with sourceCheck "header"', async () => {
      const s3 = fakeS3();
      s3.put("src", "AAAA");
      const expected = normalizeEtag(s3.etagOf("src"));
      const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
      expectOk(await admin.copy("src", "one", { ifMatch: expected }));
      expectOk(await admin.copy("src", "two", { ifMatch: expected, sourceCheck: "header" }));
      expect(copiesOf(s3).map((copy) => copy.input.CopySourceIfMatch !== undefined)).toEqual([true, true]);
    });

    it("lets a denied conditional copy throw instead of falling back", async () => {
      const s3 = fakeS3();
      s3.put("src", "AAAA");
      const original = s3.client.send.bind(s3.client);
      let attempts = 0;
      s3.client.send = async (command) => {
        if (command instanceof CopyObjectCommand) {
          attempts += 1;
          throw httpError("AccessDenied", 403);
        }
        return original(command);
      };
      const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
      await expect(admin.copy("src", "dst", { ifMatch: normalizeEtag(s3.etagOf("src")) })).rejects.toThrow(/AccessDenied/);
      expect(attempts).toBe(1);
    });
  });

  describe("when the source is read stale after being overwritten", () => {
    const staleSource = async (behaviour: FakeBehaviour) => {
      const s3 = fakeS3({ staleHeadsAfterOverwrite: 5, md5Etags: true, ...behaviour });
      s3.put("src", "AAAA");
      const listed = normalizeEtag(s3.etagOf("src"));
      s3.put("src", "BBBB");
      return { s3, listed, admin: createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions) };
    };

    it.each([
      ["compares the source", { ignoreConditions: true }, "compare"],
      ["ignores the conditional header", { ignoreConditions: true }, "header"],
    ] as const)("removes the destination when the store %s, by the ETag the copy reports", async (_label, behaviour, sourceCheck) => {
      const { s3, listed, admin } = await staleSource(behaviour);
      const error = expectErr(await admin.copy("src", "dst", { ifMatch: listed, sourceCheck }), "PRECONDITION_FAILED");
      expect(error.details).toEqual({ expectedEtag: listed, foundEtag: normalizeEtag(s3.etagOf("src")), reason: "source-changed", destinationWritten: true, destinationRemoved: true });
      expect(s3.objects.has("dst")).toBe(false);
    });

    it("does not compare the copy's ETag without ifMatch", async () => {
      const { s3, admin } = await staleSource({ ignoreConditions: true });
      expect(expectOk(await admin.copy("src", "dst")).size).toBe(4);
      expect(s3.objects.has("dst")).toBe(true);
    });

    it("does not refuse a copy whose ETag matches", async () => {
      const s3 = fakeS3({ md5Etags: true });
      s3.put("src", "AAAA");
      const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
      const copied = expectOk(await admin.copy("src", "dst", { ifMatch: normalizeEtag(s3.etagOf("src")), sourceCheck: "compare" }));
      expect(copied.etag).toBe(normalizeEtag(s3.etagOf("src")));
    });

    it("leaves the ETag alone when the source ETag is not a plain content hash", async () => {
      const s3 = fakeS3();
      s3.put("src", "AAAA");
      const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
      expectOk(await admin.copy("src", "dst", { ifMatch: normalizeEtag(s3.etagOf("src")), sourceCheck: "compare" }));
      expect(s3.etagOf("dst")).not.toBe(s3.etagOf("src"));
    });

    it("leaves the ETag alone when the copy reports server-side encryption", async () => {
      const s3 = fakeS3({ serverSideEncryption: "aws:kms" });
      s3.put("src", "AAAA");
      const original = s3.client.send.bind(s3.client);
      s3.client.send = async (command) => {
        const result = await original(command);
        if (command instanceof HeadObjectCommand && command.input.Key === "src") return { ...boundaryCast<object>(result, "host"), ServerSideEncryption: undefined };
        return result;
      };
      const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
      expectOk(await admin.copy("src", "dst", { ifMatch: normalizeEtag(s3.etagOf("src")), sourceCheck: "compare" }));
    });

    it("leaves the ETag alone when the source is server-side encrypted and the copy is not", async () => {
      const s3 = fakeS3({ serverSideEncryption: "aws:kms" });
      s3.put("src", "AAAA");
      const original = s3.client.send.bind(s3.client);
      s3.client.send = async (command) => {
        const result = await original(command);
        if (command instanceof CopyObjectCommand) {
          const hash = `"${createHash("md5").update("AAAA").digest("hex")}"`;
          const written = s3.objects.get("dst");
          if (written !== undefined) written.etag = hash;
          return { CopyObjectResult: { ETag: hash } };
        }
        return result;
      };
      const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
      expectOk(await admin.copy("src", "dst", { ifMatch: normalizeEtag(s3.etagOf("src")), sourceCheck: "compare" }));
    });
  });

  it("refuses to copy an object onto itself without sending a copy or a delete", async () => {
    const s3 = fakeS3({ ignoreConditions: true });
    s3.put("site/live.png", 4);
    const admin = createS3Admin({ bucket: "b", prefix: "site/" }, s3.client, fastOptions);
    await expect(admin.copy("live.png", "live.png", { ifMatch: normalizeEtag(s3.etagOf("site/live.png")) })).rejects.toThrow(/onto itself/);
    expect(s3.sent.some((sent) => sent instanceof CopyObjectCommand || sent instanceof DeleteObjectCommand)).toBe(false);
    expect(s3.objects.has("site/live.png")).toBe(true);
  });

  describe("when a transient failure follows a written destination", () => {
    const failAfterCopy = (s3: ReturnType<typeof fakeS3>, failing: (command: unknown) => boolean, denyDelete: boolean): void => {
      const original = s3.client.send.bind(s3.client);
      let copied = false;
      s3.client.send = async (command) => {
        if (copied && failing(command)) throw httpError("ServiceUnavailable", 503);
        if (copied && denyDelete && command instanceof DeleteObjectCommand) throw httpError("ServiceUnavailable", 503);
        const result = await original(command);
        if (command instanceof CopyObjectCommand) copied = true;
        return result;
      };
    };
    const sourceHead = (command: unknown): boolean => command instanceof HeadObjectCommand && command.input.Key === "src";
    const destinationHead = (command: unknown): boolean => command instanceof HeadObjectCommand && command.input.Key === "dst";

    it("removes the destination and reports it when the source cannot be read again", async () => {
      const s3 = fakeS3({ ignoreConditions: true });
      s3.put("src", "AAAA");
      failAfterCopy(s3, sourceHead, false);
      const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
      const error = expectErr(await admin.copy("src", "dst", { ifMatch: normalizeEtag(s3.etagOf("src")) }), "TRANSIENT");
      expect(error.details).toEqual({ destinationWritten: true, destinationRemoved: true });
      expect(s3.objects.has("dst")).toBe(false);
    });

    it("reports a destination it could not remove when the source cannot be read again", async () => {
      const s3 = fakeS3({ ignoreConditions: true });
      s3.put("src", "AAAA");
      failAfterCopy(s3, sourceHead, true);
      const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
      const error = expectErr(await admin.copy("src", "dst", { ifMatch: normalizeEtag(s3.etagOf("src")) }), "TRANSIENT");
      expect(error.details).toEqual({ destinationWritten: true, destinationRemoved: false });
      expect(s3.objects.has("dst")).toBe(true);
    });

    it("removes an unverified destination when it cannot be read back", async () => {
      const s3 = fakeS3({ truncateCopyTo: 2 });
      s3.put("src", "AAAA");
      failAfterCopy(s3, destinationHead, false);
      const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
      const error = expectErr(await admin.copy("src", "dst"), "TRANSIENT");
      expect(error.details).toEqual({ destinationWritten: true, destinationRemoved: true });
      expect(s3.objects.has("dst")).toBe(false);
    });

    it("reports an unverified destination it could not remove", async () => {
      const s3 = fakeS3({ truncateCopyTo: 2 });
      s3.put("src", "AAAA");
      failAfterCopy(s3, destinationHead, true);
      const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
      const error = expectErr(await admin.copy("src", "dst"), "TRANSIENT");
      expect(error.details).toEqual({ destinationWritten: true, destinationRemoved: false });
      expect(s3.objects.has("dst")).toBe(true);
    });
  });

  it("throws when the bucket disappears between reading the source and copying it, instead of reporting a missing source", async () => {
    const s3 = fakeS3();
    s3.put("src", 4);
    const original = s3.client.send.bind(s3.client);
    s3.client.send = async (command) => {
      if (command instanceof CopyObjectCommand) throw httpError("NoSuchBucket", 404);
      return original(command);
    };
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
    await expect(admin.copy("src", "dst")).rejects.toThrow(/NoSuchBucket/);
  });

  it("answers NOT_FOUND when the source disappears between reading it and copying it", async () => {
    const s3 = fakeS3();
    s3.put("src", 4);
    const original = s3.client.send.bind(s3.client);
    s3.client.send = async (command) => {
      if (command instanceof CopyObjectCommand) throw httpError("NoSuchKey", 404);
      return original(command);
    };
    expectErr(await createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions).copy("src", "dst"), "NOT_FOUND");
  });

  it("refuses a source above the single-request copy limit before sending a copy", async () => {
    const s3 = fakeS3();
    const original = s3.client.send.bind(s3.client);
    s3.client.send = async (command) => {
      if (command instanceof HeadObjectCommand) return { ContentLength: 5 * 1024 ** 3 + 1, ETag: '"x"', LastModified: new Date() };
      return original(command);
    };
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
    expectErr(await admin.copy("big", "dst"), "PAYLOAD_TOO_LARGE");
    expect(s3.sent.some((sent) => sent instanceof CopyObjectCommand)).toBe(false);
  });

  it("answers TRANSIENT when the copy fails after the SDK's retries and lets a denied copy throw", async () => {
    const s3 = fakeS3();
    s3.put("src", 1);
    const original = s3.client.send.bind(s3.client);
    s3.client.send = async (command) => {
      if (command instanceof CopyObjectCommand) throw httpError("ServiceUnavailable", 503);
      return original(command);
    };
    expectErr(await createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions).copy("src", "dst"), "TRANSIENT");
    s3.client.send = async (command) => {
      if (command instanceof CopyObjectCommand) throw httpError("AccessDenied", 403);
      return original(command);
    };
    await expect(createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions).copy("src", "dst")).rejects.toThrow(/AccessDenied/);
  });
});

describe("blobstore/s3 admin: serverTime", () => {
  it("reads the store's own clock from a probe object's LastModified and reports the skew against the local clock", async () => {
    const s3 = fakeS3({ clockOffsetMs: 90_000 });
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
    const clock = expectOk(await admin.serverTime());
    expect(Math.abs(clock.serverMs - clock.localMs - 90_000)).toBeLessThan(2000);
    expect(clock.skewMs).toBe(clock.serverMs - clock.localMs);
  });

  it("lists again until the probe object appears", async () => {
    const s3 = fakeS3({ listingLag: 3 });
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
    expectOk(await admin.serverTime());
    expect(s3.sent.filter((sent) => sent instanceof ListObjectsV2Command).length).toBe(4);
  });

  it("answers TRANSIENT when the probe object never shows up in a listing", async () => {
    const s3 = fakeS3({ listingLag: 50 });
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, { ...fastOptions, observeAttempts: 3 });
    expectErr(await admin.serverTime(), "TRANSIENT");
  });

  it("leaves no probe object behind and writes under the configured prefix", async () => {
    const s3 = fakeS3();
    const admin = createS3Admin({ bucket: "b", prefix: "site/" }, s3.client, fastOptions);
    expectOk(await admin.serverTime());
    const puts = s3.sent.filter((sent): sent is PutObjectCommand => sent instanceof PutObjectCommand);
    expect(puts.every((put) => put.input.Key?.startsWith("site/") === true)).toBe(true);
    expect(s3.objects.size).toBe(0);
  });
});

describe("blobstore/s3 admin: probeCapabilities", () => {
  it("reports a capability as supported only when the store refused the stale condition", async () => {
    const s3 = fakeS3();
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
    const probed = expectOk(await admin.probeCapabilities());
    for (const capability of [probed.conditionalCreate, probed.conditionalOverwrite, probed.copySourceIfMatch]) {
      expect(capability).toMatchObject({ supported: true, outcome: "enforced" });
    }
  });

  it("reports unproven, so unsupported, when the store ignores conditional headers", async () => {
    const admin = createS3Admin({ bucket: "b", prefix: "" }, fakeS3({ ignoreConditions: true }).client, fastOptions);
    const probed = expectOk(await admin.probeCapabilities());
    for (const capability of [probed.conditionalCreate, probed.conditionalOverwrite, probed.copySourceIfMatch]) {
      expect(capability).toMatchObject({ supported: false, outcome: "ignored" });
    }
  });

  it("reports unsupported when the store answers 501", async () => {
    const admin = createS3Admin({ bucket: "b", prefix: "" }, fakeS3({ notImplementedConditions: true }).client, fastOptions);
    const probed = expectOk(await admin.probeCapabilities());
    for (const capability of [probed.conditionalCreate, probed.conditionalOverwrite, probed.copySourceIfMatch]) {
      expect(capability).toMatchObject({ supported: false, outcome: "not-implemented" });
    }
  });

  it("reports a store that refuses every conditional request as unsupported, since a matching condition is refused too", async () => {
    const s3 = fakeS3({ refuseAllConditions: true });
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
    const probed = expectOk(await admin.probeCapabilities());
    for (const capability of [probed.conditionalCreate, probed.conditionalOverwrite, probed.copySourceIfMatch]) {
      expect(capability).toMatchObject({ supported: false, outcome: "always-refused" });
    }
    expect(s3.objects.size).toBe(0);
  });

  it("confirms each capability with a condition the store must accept", async () => {
    const s3 = fakeS3();
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
    expectOk(await admin.probeCapabilities());
    const puts = s3.sent.filter((sent): sent is PutObjectCommand => sent instanceof PutObjectCommand);
    const copies = s3.sent.filter((sent): sent is CopyObjectCommand => sent instanceof CopyObjectCommand);
    expect(puts.filter((put) => put.input.IfNoneMatch === "*").length).toBe(2);
    expect(puts.filter((put) => put.input.IfMatch !== undefined && !put.input.IfMatch.includes("no-such-etag")).length).toBe(1);
    expect(copies.filter((copy) => copy.input.CopySourceIfMatch !== undefined && !copy.input.CopySourceIfMatch.includes("no-such-etag")).length).toBe(1);
  });

  it("reports an unexpected refusal as unsupported with the error name", async () => {
    const s3 = fakeS3();
    const original = s3.client.send.bind(s3.client);
    s3.client.send = async (command) => {
      if (command instanceof PutObjectCommand && command.input.IfNoneMatch !== undefined) throw httpError("InvalidArgument", 400);
      return original(command);
    };
    const probed = expectOk(await createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions).probeCapabilities());
    expect(probed.conditionalCreate).toMatchObject({ supported: false, outcome: "error", detail: "InvalidArgument" });
    expect(probed.conditionalOverwrite.supported).toBe(true);
  });

  it("works on a scratch prefix under the configured prefix and removes what it wrote", async () => {
    const s3 = fakeS3({ ignoreConditions: true });
    const admin = createS3Admin({ bucket: "b", prefix: "site/" }, s3.client, fastOptions);
    s3.put("site/keep.txt", 1);
    expectOk(await admin.probeCapabilities());
    const written = s3.sent.flatMap((sent) => (sent instanceof PutObjectCommand || sent instanceof CopyObjectCommand ? [sent.input.Key ?? ""] : []));
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((key) => key.startsWith("site/."))).toBe(true);
    expect([...s3.objects.keys()]).toEqual(["site/keep.txt"]);
  });

  it("answers TRANSIENT when the store cannot be reached and lets a denied write throw", async () => {
    expectErr(await createS3Admin({ bucket: "b", prefix: "" }, failingS3(httpError("SlowDown", 503)), fastOptions).probeCapabilities(), "TRANSIENT");
    await expect(createS3Admin({ bucket: "b", prefix: "" }, failingS3(httpError("AccessDenied", 403)), fastOptions).probeCapabilities()).rejects.toThrow(/AccessDenied/);
  });
});

describe("blobstore/s3 admin: probes against stores that answer a delete of a missing key with 404", () => {
  it.each([
    ["ignores conditions", { ignoreConditions: true }],
    ["answers 501 to conditions", { notImplementedConditions: true }],
    ["refuses every condition", { refuseAllConditions: true }],
    ["answers 400 to conditions", { rejectConditionHeaders: true }],
  ] as const)("reports the capabilities as unsupported instead of throwing when the store %s", async (_label, behaviour) => {
    const s3 = fakeS3({ ...behaviour, deleteMissingAnswers404: true });
    const probed = expectOk(await createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions).probeCapabilities());
    for (const capability of [probed.conditionalCreate, probed.conditionalOverwrite, probed.copySourceIfMatch]) expect(capability.supported).toBe(false);
    expect(s3.objects.size).toBe(0);
  });

  it("still reads the clock", async () => {
    expectOk(await createS3Admin({ bucket: "b", prefix: "" }, fakeS3({ deleteMissingAnswers404: true }).client, fastOptions).serverTime());
  });
});

describe("blobstore/s3 admin: cleanup of scratch objects", () => {
  const denyDeletes = (s3: ReturnType<typeof fakeS3>, error: Error): void => {
    const original = s3.client.send.bind(s3.client);
    s3.client.send = async (command) => {
      if (command instanceof DeleteObjectCommand) throw error;
      return original(command);
    };
  };

  it("lets a denied delete of the clock probe throw, since the probe object would stay in the bucket", async () => {
    const s3 = fakeS3();
    denyDeletes(s3, httpError("AccessDenied", 403));
    await expect(createS3Admin({ bucket: "b", prefix: "media/" }, s3.client, fastOptions).serverTime()).rejects.toThrow(/AccessDenied/);
  });

  it("lets a denied delete of the capability probe objects throw", async () => {
    const s3 = fakeS3();
    denyDeletes(s3, httpError("AccessDenied", 403));
    await expect(createS3Admin({ bucket: "b", prefix: "media/" }, s3.client, fastOptions).probeCapabilities()).rejects.toThrow(/AccessDenied/);
  });

  it("ignores a transient failure to delete a probe object", async () => {
    const s3 = fakeS3();
    denyDeletes(s3, httpError("ServiceUnavailable", 503));
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, fastOptions);
    expectOk(await admin.serverTime());
    expectOk(await admin.probeCapabilities());
  });

  it("keeps the original error when the probe fails and the cleanup is denied as well", async () => {
    const s3 = fakeS3({ listingLag: 50 });
    denyDeletes(s3, httpError("AccessDenied", 403));
    const admin = createS3Admin({ bucket: "b", prefix: "" }, s3.client, { ...fastOptions, observeAttempts: 2 });
    expectErr(await admin.serverTime(), "TRANSIENT");
  });
});

describe("blobstore/s3 admin: probe objects of a write that failed", () => {
  const landThenFail = (s3: ReturnType<typeof fakeS3>): void => {
    const original = s3.client.send.bind(s3.client);
    let failed = false;
    s3.client.send = async (command) => {
      const result = await original(command);
      if (command instanceof PutObjectCommand && !failed) {
        failed = true;
        throw httpError("ServiceUnavailable", 503);
      }
      return result;
    };
  };

  it("removes the clock probe object when its write is reported as failed after it arrived", async () => {
    const s3 = fakeS3();
    landThenFail(s3);
    expectErr(await createS3Admin({ bucket: "b", prefix: "media/" }, s3.client, fastOptions).serverTime(), "TRANSIENT");
    expect(s3.objects.size).toBe(0);
  });

  it("removes the capability probe object when its write is reported as failed after it arrived", async () => {
    const s3 = fakeS3();
    landThenFail(s3);
    expectErr(await createS3Admin({ bucket: "b", prefix: "media/" }, s3.client, fastOptions).probeCapabilities(), "TRANSIENT");
    expect(s3.objects.size).toBe(0);
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
