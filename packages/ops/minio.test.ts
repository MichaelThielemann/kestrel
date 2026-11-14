import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { backupRestoreRoundTrip } from "./src/scenario.fixture.ts";
import { s3Store } from "./src/s3Store.ts";
import { serverClock } from "./src/serverTime.ts";
import { PreconditionFailed } from "./src/store.ts";

const endpoint = process.env.KESTREL_S3_ENDPOINT;

describe.skipIf(!endpoint)("kestrel-ops against MinIO", () => {
  const config = {
    bucket: process.env.KESTREL_S3_BUCKET ?? "kestrel-test",
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    accessKeyId: process.env.KESTREL_S3_ACCESS_KEY,
    secretAccessKey: process.env.KESTREL_S3_SECRET_KEY,
  };
  const fresh = () => s3Store({ ...config, prefix: `ops-e2e/${Date.now()}-${randomBytes(4).toString("hex")}/` });

  backupRestoreRoundTrip(async () => fresh());

  it("refuses a server-side copy whose source no longer has the listed ETag, and reports unquoted ETags", async () => {
    const store = fresh();
    try {
      await store.put("a.txt", new TextEncoder().encode("first"));
      const listed = (await store.list("a.txt"))[0];
      expect(listed?.etag).toMatch(/^[0-9a-f]{32}$/);
      expect((await store.head("a.txt"))?.etag).toBe(listed?.etag);
      await store.put("a.txt", new TextEncoder().encode("second"));
      await expect(store.copy("a.txt", "b.txt", { ifMatch: listed?.etag ?? "" })).rejects.toBeInstanceOf(PreconditionFailed);
      expect(await store.head("b.txt")).toBeNull();
      await store.copy("a.txt", "b.txt", { ifMatch: (await store.head("a.txt"))?.etag ?? "" });
      expect(new TextDecoder().decode((await store.get("b.txt")) ?? new Uint8Array())).toBe("second");
    } finally {
      store.close();
    }
  });

  it("reads the server clock from a probe's LastModified within a second of this machine's", async () => {
    const store = fresh();
    try {
      const clock = await serverClock(store, "kestrel-backups/", "minio", Date.now, { delayMs: 50 });
      expect(Math.abs(clock.skewMs)).toBeLessThan(5000);
      expect(await store.list("kestrel-backups/probes/")).toEqual([]);
    } finally {
      store.close();
    }
  });
});
