import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { BootInput, ModuleDefinition } from "@michaelthielemann/kestrel";
import { BLOBSTORE } from "@michaelthielemann/kestrel-contracts/blobstore";
import { sandboxBootInput } from "./sandbox.ts";

function s3StandInModule(): ModuleDefinition {
  return { name: "blobstore/s3", provides: [BLOBSTORE], requires: [], configSchema: z.any(), async setup() { return {}; } };
}

function dummyModule(name: string): ModuleDefinition {
  return { name, provides: [], requires: [], configSchema: z.any(), async setup() { return {}; } };
}

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

  it("swaps a blobstore@1 provider that is neither rewritten nor known-safe for a local stand-in", () => {
    const base = input();
    const withS3: BootInput = {
      ...base,
      config: { ...base.config, modules: [...base.config.modules, { use: "@michaelthielemann/kestrel-blobstore-s3", config: { bucket: "prod" } }] },
      modules: [dummyModule("a"), dummyModule("b"), dummyModule("c"), dummyModule("d"), s3StandInModule()],
    };
    const result = sandboxBootInput(withS3, { dir: "/tmp/scratch-1" });
    expect(result.replaced).toEqual(["@michaelthielemann/kestrel-blobstore-s3"]);
    expect(result.outside).not.toContain("@michaelthielemann/kestrel-blobstore-s3");
    expect(result.setup.only).toContain("@michaelthielemann/kestrel-blobstore-s3");
    const swapped = result.input.modules.find((m) => m.name === "blobstore/s3");
    expect(swapped).toBeDefined();
    expect(swapped?.provides).toEqual([BLOBSTORE]);
    expect(swapped).not.toBe(s3StandInModule());
  });

  it("does not swap a module that does not provide blobstore@1", () => {
    const base = input();
    const withOther: BootInput = {
      ...base,
      config: { ...base.config, modules: [...base.config.modules, { use: "@michaelthielemann/kestrel-blobstore-s3", config: {} }] },
      modules: [dummyModule("a"), dummyModule("b"), dummyModule("c"), dummyModule("d"), dummyModule("notes/local")],
    };
    const result = sandboxBootInput(withOther, { dir: "/tmp/scratch-1" });
    expect(result.replaced).toEqual([]);
    expect(result.outside).toContain("@michaelthielemann/kestrel-blobstore-s3");
  });
});
