import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { s3Store } from "./s3Store.ts";
import { transfer } from "./store.ts";

interface FakeObject {
  etag: string;
  size: number;
  stale: { etag: string; size: number; heads: number } | null;
}

function laggingBucket(): { objects: Map<string, FakeObject>; sent: string[] } {
  const objects = new Map<string, FakeObject>();
  const sent: string[] = [];
  const notFound = (): Error => Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
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
