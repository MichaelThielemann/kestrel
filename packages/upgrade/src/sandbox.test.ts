import { describe, expect, it } from "vitest";
import type { BootInput } from "@michaelthielemann/kestrel";
import { sandboxBootInput } from "./sandbox.ts";

function input(): BootInput {
  return {
    config: {
      modules: [
        { use: "@michaelthielemann/kestrel-events-inmemory", config: {} },
        { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: "./data/kestrel.db", acquireTimeoutMs: 15000, busyTimeoutMs: 5000 } },
        { use: "@michaelthielemann/kestrel-blobstore-filesystem", config: { root: "./data/blobs" } },
        { use: "./modules/notes.ts", config: { apiKey: "secret" } },
      ],
      triggers: [],
    },
    modules: [],
    pipelines: [],
  };
}

describe("sandboxBootInput", () => {
  it("rewrites persistence-sqlite's file into the scratch directory", () => {
    const result = sandboxBootInput(input(), { dir: "/tmp/scratch-1" });
    const sqlite = result.input.config.modules.find((m) => m.use.includes("persistence-sqlite"));
    expect(sqlite?.config).toMatchObject({ file: "/tmp/scratch-1/sandbox/kestrel.db", acquireTimeoutMs: 15000, busyTimeoutMs: 5000 });
  });

  it("rewrites blobstore-filesystem's root into the scratch directory", () => {
    const result = sandboxBootInput(input(), { dir: "/tmp/scratch-1" });
    const blobstore = result.input.config.modules.find((m) => m.use.includes("blobstore-filesystem"));
    expect(blobstore?.config).toEqual({ root: "/tmp/scratch-1/sandbox/blobs" });
  });

  it("leaves a known-safe module's config untouched but includes it in setup.only", () => {
    const result = sandboxBootInput(input(), { dir: "/tmp/scratch-1" });
    const bus = result.input.config.modules.find((m) => m.use.includes("events-inmemory"));
    expect(bus?.config).toEqual({});
    expect(result.setup.only).toContain("@michaelthielemann/kestrel-events-inmemory");
  });

  it("reports a local module outside the sandbox by default", () => {
    const result = sandboxBootInput(input(), { dir: "/tmp/scratch-1" });
    expect(result.outside).toEqual(["./modules/notes.ts"]);
    expect(result.setup.only).not.toContain("./modules/notes.ts");
  });

  it("moves a module into setup.only once it is named in consent", () => {
    const result = sandboxBootInput(input(), { dir: "/tmp/scratch-1", consent: ["./modules/notes.ts"] });
    expect(result.outside).toEqual([]);
    expect(result.setup.only).toContain("./modules/notes.ts");
  });

  it("does not treat a local module whose bare file name matches a known-safe suffix as safe", () => {
    const withLocalInsights: BootInput = { ...input(), config: { ...input().config, modules: [...input().config.modules, { use: "./modules/insights.ts", config: { apiKey: "secret" } }] } };
    const result = sandboxBootInput(withLocalInsights, { dir: "/tmp/scratch-1" });
    expect(result.outside).toContain("./modules/insights.ts");
    expect(result.setup.only).not.toContain("./modules/insights.ts");
  });

  it("does not rewrite or run a third-party package whose bare name matches an official kestrel module", () => {
    const withForkedSqlite: BootInput = { ...input(), config: { ...input().config, modules: [...input().config.modules, { use: "@acme/kestrel-persistence-sqlite", config: { file: "/etc/passwd" } }] } };
    const result = sandboxBootInput(withForkedSqlite, { dir: "/tmp/scratch-1" });
    const forked = result.input.config.modules.find((m) => m.use === "@acme/kestrel-persistence-sqlite");
    expect(forked?.config).toEqual({ file: "/etc/passwd" });
    expect(result.outside).toContain("@acme/kestrel-persistence-sqlite");
    expect(result.setup.only).not.toContain("@acme/kestrel-persistence-sqlite");
  });

  it("never mutates the original input", () => {
    const original = input();
    const before = JSON.stringify(original);
    sandboxBootInput(original, { dir: "/tmp/scratch-1" });
    expect(JSON.stringify(original)).toBe(before);
  });
});
