import { describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import type { BlobstoreS3 } from "./impl.ts";
import blobstoreS3, { configSchema } from "./module.ts";

function depsWithLog(entries: { level: string; message: string; data?: Record<string, unknown> }[]): Deps {
  return {
    get: () => {
      throw new Error("blobstore/s3 requires no contract");
    },
    find: () => undefined,
    root: process.cwd(),
    eventTriggers: [],
    logger: {
      ...silentLogger,
      info: (message, data) => entries.push({ level: "info", message, ...(data === undefined ? {} : { data }) }),
      warn: (message, data) => entries.push({ level: "warn", message, ...(data === undefined ? {} : { data }) }),
      error: (message, data) => entries.push({ level: "error", message, ...(data === undefined ? {} : { data }) }),
    },
  };
}

describe("blobstore/s3 endpoint transport", () => {
  it("accepts an https endpoint and no endpoint at all", () => {
    expect(configSchema.safeParse({ bucket: "b", endpoint: "https://s3.example.com" }).success).toBe(true);
    expect(configSchema.safeParse({ bucket: "b" }).success).toBe(true);
  });

  it("accepts a plain http endpoint on a loopback address", () => {
    for (const endpoint of ["http://127.0.0.1:9000", "http://127.8.0.1:9000", "http://localhost:9000", "http://[::1]:9000"]) {
      expect(configSchema.safeParse({ bucket: "b", endpoint }).success, endpoint).toBe(true);
    }
  });

  it("refuses a plain http endpoint on any other host, naming the option that allows it", () => {
    for (const endpoint of ["http://s3.example.com", "http://10.0.0.5:9000", "http://minio:9000", "http://localhost.example.com"]) {
      const parsed = configSchema.safeParse({ bucket: "b", endpoint });
      expect(parsed.success, endpoint).toBe(false);
      expect(parsed.error?.issues[0]?.path).toEqual(["endpoint"]);
      expect(parsed.error?.issues[0]?.message).toMatch(/https.*allowInsecureEndpoint/);
    }
  });

  it("accepts a plain http endpoint with allowInsecureEndpoint and warns once at setup", async () => {
    const config = configSchema.parse({ bucket: "b", endpoint: "http://minio:9000", allowInsecureEndpoint: true, accessKeyId: "id", secretAccessKey: "key", region: "us-east-1" });
    const entries: { level: string; message: string; data?: Record<string, unknown> }[] = [];
    const store = boundaryCast<BlobstoreS3>(await blobstoreS3.setup(config, depsWithLog(entries)), "host");
    try {
      expect(entries.map((entry) => [entry.level, entry.data])).toEqual([["warn", { endpoint: "http://minio:9000" }]]);
      expect(entries[0]?.message).toContain("unencrypted");
    } finally {
      store.close();
    }
  });

  it("does not warn about an https or loopback endpoint", async () => {
    for (const endpoint of ["https://s3.example.com", "http://127.0.0.1:9000"]) {
      const entries: { level: string; message: string }[] = [];
      const store = boundaryCast<BlobstoreS3>(await blobstoreS3.setup(configSchema.parse({ bucket: "b", endpoint, accessKeyId: "id", secretAccessKey: "key", region: "us-east-1" }), depsWithLog(entries)), "host");
      store.close();
      expect(entries, endpoint).toEqual([]);
    }
  });
});
