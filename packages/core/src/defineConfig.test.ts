import { describe, expect, it } from "vitest";
import { configSchema } from "./defineConfig.ts";

describe("configSchema defaults", () => {
  it("fills an omitted http block with every default, nested objects included", () => {
    const http = configSchema.parse({ modules: [], triggers: [] }).http;
    expect(http).toMatchObject({ port: 3000, host: "127.0.0.1", trustProxy: false, inlineTypes: [], healthPath: "/health" });
    expect(http?.multipart).toEqual({ maxParts: 120, maxFiles: 20, maxFields: 100 });
    expect(http?.timeouts).toEqual({ requestMs: 30_000, headersMs: 10_000, keepAliveMs: 5_000 });
  });

  it("fills the nested defaults below an http block that leaves them out", () => {
    const http = configSchema.parse({ modules: [], triggers: [], http: { port: 4000 } }).http;
    expect(http).toMatchObject({ port: 4000, multipart: { maxParts: 120, maxFiles: 20, maxFields: 100 }, timeouts: { requestMs: 30_000, headersMs: 10_000, keepAliveMs: 5_000 } });
  });

  it("keeps an explicit null http block", () => {
    expect(configSchema.parse({ modules: [], triggers: [], http: null }).http).toBeNull();
  });
});
