import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { s3Store } from "./s3Store.ts";
import { PreconditionFailed, transfer } from "./store.ts";

interface FakeObject {
  etag: string;
  size: number;
  stale: { etag: string; size: number; heads: number } | null;
}

function laggingBucket(): { objects: Map<string, FakeObject>; sent: string[] } {
  const objects = new Map<string, FakeObject>();
  const sent: string[] = [];
  const notFound = (): Error => Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- send also has callback overloads; the store only awaits its promise form
  vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: unknown) => {
    const name = boundaryCast<{ constructor: { name: string } }>(command, "host").constructor.name;
    const input = boundaryCast<{ input: { Key?: string; CopySource?: string } }>(command, "host").input;
    sent.push(`${name} ${input.Key ?? ""}`);
    const key = input.Key ?? "";
    if (name === "HeadObjectCommand") {
      const object = objects.get(key);
      if (!object) throw notFound();
      if (object.stale && object.stale.heads > 0) {
        object.stale.heads -= 1;
        return { ContentLength: object.stale.size, ETag: `"${object.stale.etag}"`, LastModified: new Date() };
      }
      return { ContentLength: object.size, ETag: `"${object.etag}"`, LastModified: new Date() };
    }
    if (name === "CopyObjectCommand") {
      const sourceKey = decodeURIComponent((input.CopySource ?? "").split("/").slice(1).join("/"));
      const source = objects.get(sourceKey);
      if (!source) throw notFound();
      const before = objects.get(key);
      objects.set(key, { etag: source.etag, size: source.size, stale: before ? { etag: before.etag, size: before.size, heads: 20 } : null });
      return { CopyObjectResult: { ETag: `"${source.etag}"` } };
    }
    if (name === "DeleteObjectCommand") {
      objects.delete(key);
      return {};
    }
    throw new Error(`the lagging bucket does not answer ${name}`);
  });
  return { objects, sent };
}

describe("the S3 store over a bucket whose HEAD shows an overwritten key's old version for a while", () => {
  afterEach(() => vi.restoreAllMocks());

  it("replaces a live key with a copy and never removes it, however long the HEAD lags", async () => {
    const { objects, sent } = laggingBucket();
    const backups = s3Store({ bucket: "b", prefix: "kestrel-backups/", region: "us-east-1", endpoint: "http://127.0.0.1:1", forcePathStyle: true, accessKeyId: "k", secretAccessKey: "s" });
    const app = s3Store({ bucket: "b", prefix: "", region: "us-east-1", endpoint: "http://127.0.0.1:1", forcePathStyle: true, accessKeyId: "k", secretAccessKey: "s" });
    try {
      objects.set("kestrel-backups/objects/media/m1/harbour.jpg@aaaa", { etag: "aaaa", size: 19, stale: null });
      objects.set("media/m1/harbour.jpg", { etag: "bbbb", size: 7, stale: null });
      await transfer(backups, "objects/media/m1/harbour.jpg@aaaa", app, "media/m1/harbour.jpg", undefined, { replace: true });
      expect(sent.filter((line) => line.startsWith("DeleteObjectCommand"))).toEqual([]);
      expect(objects.get("media/m1/harbour.jpg")).toMatchObject({ etag: "aaaa", size: 19 });
    } finally {
      backups.close();
      app.close();
    }
  });
});

function refusingBucket(): { objects: Map<string, { etag: string; size: number }>; copies: string[] } {
  const objects = new Map<string, { etag: string; size: number }>();
  const copies: string[] = [];
  const status = (code: number, name: string): Error => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: code } });
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- send also has callback overloads; the store only awaits its promise form
  vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: unknown) => {
    const name = boundaryCast<{ constructor: { name: string } }>(command, "host").constructor.name;
    const input = boundaryCast<{ input: { Key?: string; CopySource?: string; CopySourceIfMatch?: string } }>(command, "host").input;
    const key = input.Key ?? "";
    if (name === "HeadObjectCommand") {
      const object = objects.get(key);
      if (!object) throw status(404, "NotFound");
      return { ContentLength: object.size, ETag: `"${object.etag}"`, LastModified: new Date() };
    }
    if (name === "CopyObjectCommand") {
      copies.push(input.CopySourceIfMatch === undefined ? "plain" : "conditional");
      if (input.CopySourceIfMatch !== undefined) throw status(412, "PreconditionFailed");
      const source = objects.get(decodeURIComponent((input.CopySource ?? "").split("/").slice(1).join("/")));
      if (!source) throw status(404, "NoSuchKey");
      objects.set(key, { ...source });
      return { CopyObjectResult: { ETag: `"${source.etag}"` } };
    }
    if (name === "DeleteObjectCommand") {
      objects.delete(key);
      return {};
    }
    throw new Error(`the refusing bucket does not answer ${name}`);
  });
  return { objects, copies };
}

describe("the S3 store over a bucket that refuses every copy with x-amz-copy-source-if-match", () => {
  afterEach(() => vi.restoreAllMocks());
  const etag = "0123456789abcdef0123456789abcdef";

  it("copies a source that still has the listed ETag by comparing it before and after, and remembers that for later copies", async () => {
    const { objects, copies } = refusingBucket();
    const backups = s3Store({ bucket: "b", prefix: "kestrel-backups/", region: "us-east-1", endpoint: "http://127.0.0.1:1", forcePathStyle: true, accessKeyId: "k", secretAccessKey: "s" });
    const app = s3Store({ bucket: "b", prefix: "", region: "us-east-1", endpoint: "http://127.0.0.1:1", forcePathStyle: true, accessKeyId: "k", secretAccessKey: "s" });
    try {
      objects.set("media/m1/harbour.jpg", { etag, size: 19 });
      objects.set("media/m2/plan.pdf", { etag, size: 16 });
      await transfer(app, "media/m1/harbour.jpg", backups, `objects/media/m1/harbour.jpg@${etag}`, etag);
      expect(objects.get(`kestrel-backups/objects/media/m1/harbour.jpg@${etag}`)).toEqual({ etag, size: 19 });
      await transfer(app, "media/m2/plan.pdf", backups, `objects/media/m2/plan.pdf@${etag}`, etag);
      expect(objects.get(`kestrel-backups/objects/media/m2/plan.pdf@${etag}`)).toEqual({ etag, size: 16 });
      expect(copies).toEqual(["conditional", "plain", "plain"]);
    } finally {
      backups.close();
      app.close();
    }
  });

  it("still refuses a source whose ETag changed", async () => {
    const { objects } = refusingBucket();
    const backups = s3Store({ bucket: "b", prefix: "kestrel-backups/", region: "us-east-1", endpoint: "http://127.0.0.1:1", forcePathStyle: true, accessKeyId: "k", secretAccessKey: "s" });
    const app = s3Store({ bucket: "b", prefix: "", region: "us-east-1", endpoint: "http://127.0.0.1:1", forcePathStyle: true, accessKeyId: "k", secretAccessKey: "s" });
    try {
      objects.set("media/m1/harbour.jpg", { etag: "fedcba9876543210fedcba9876543210", size: 19 });
      await expect(transfer(app, "media/m1/harbour.jpg", backups, `objects/media/m1/harbour.jpg@${etag}`, etag)).rejects.toBeInstanceOf(PreconditionFailed);
      expect(objects.has(`kestrel-backups/objects/media/m1/harbour.jpg@${etag}`)).toBe(false);
    } finally {
      backups.close();
      app.close();
    }
  });
});
