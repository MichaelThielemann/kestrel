import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
  missingBucket?: boolean;
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
    if (behaviour.refuseAllConditions === true) throw httpError("PreconditionFailed", 412);
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
        return { CopyObjectResult: { ETag: objects.get(command.input.Key ?? "")?.etag } };
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
    expect(error.details).toEqual({ expectedEtag: stale, foundEtag: null, reason: "store-refused", destinationWritten: false });
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
