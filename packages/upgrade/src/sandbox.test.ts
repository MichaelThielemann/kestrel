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

function storageInput(files: { persistence: string; replication: string; backup: string }): BootInput {
  return {
    config: {
      modules: [
        { use: "@michaelthielemann/kestrel-blobstore-filesystem", config: { root: "./data/blobs" } },
        { use: "@michaelthielemann/kestrel-replication-sqlite", config: { file: files.replication, allowConcurrentProcesses: true } },
        { use: "@michaelthielemann/kestrel-backup-blobstore", config: { file: files.backup } },
        { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: files.persistence } },
      ],
      triggers: [],
    },
    modules: [],
    pipelines: [],
  };
}

function fileOf(input: BootInput, name: string): string {
  const config = input.config.modules.find((m) => m.use.endsWith(name))?.config;
  const file: unknown = typeof config === "object" && config !== null ? Reflect.get(config, "file") : undefined;
  if (typeof file !== "string") throw new Error(`${name} has no file`);
  return file;
}

describe("sandboxBootInput", () => {
  it("rewrites persistence-sqlite's file into the scratch directory", () => {
    const result = sandboxBootInput(input(), { dir: "/tmp/scratch-1" });
    const sqlite = result.input.config.modules.find((m) => m.use.includes("persistence-sqlite"));
    expect(sqlite?.config).toMatchObject({ acquireTimeoutMs: 15000, busyTimeoutMs: 5000 });
    expect(fileOf(result.input, "persistence-sqlite")).toMatch(/^\/tmp\/scratch-1\/sandbox\/[^/]+\/kestrel\.db$/);
  });

  it("gives storage modules that name different database files different scratch files", () => {
    const result = sandboxBootInput(storageInput({ persistence: "./data/kestrel.db", replication: "./data/other.db", backup: "./data/third.db" }), { dir: "/tmp/scratch-1" });
    const files = ["persistence-sqlite", "replication-sqlite", "backup-blobstore"].map((name) => fileOf(result.input, name));
    expect(new Set(files).size).toBe(3);
    for (const file of files) expect(file.startsWith("/tmp/scratch-1/sandbox/")).toBe(true);
  });

  it("gives storage modules that name the same database file, however written, one scratch file", () => {
    const result = sandboxBootInput(storageInput({ persistence: "./data/kestrel.db", replication: "data/kestrel.db", backup: "./data/../data/kestrel.db" }), { dir: "/tmp/scratch-1" });
    const files = ["persistence-sqlite", "replication-sqlite", "backup-blobstore"].map((name) => fileOf(result.input, name));
    expect(new Set(files).size).toBe(1);
  });

  it("keeps an in-memory persistence database in memory", () => {
    const result = sandboxBootInput(storageInput({ persistence: ":memory:", replication: "./data/other.db", backup: "./data/other.db" }), { dir: "/tmp/scratch-1" });
    expect(fileOf(result.input, "persistence-sqlite")).toBe(":memory:");
    expect(fileOf(result.input, "replication-sqlite").startsWith("/tmp/scratch-1/sandbox/")).toBe(true);
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

  it("rewrites a module-list entry through a table entry keyed by its full use string, whatever the package scope", () => {
    const withThirdParty: BootInput = { ...input(), config: { ...input().config, modules: [...input().config.modules, { use: "@acme/kestrel-archive", config: { dir: "/srv/archive" } }] } };
    const result = sandboxBootInput(withThirdParty, { dir: "/tmp/scratch-1", entries: { "@acme/kestrel-archive": (_config, scratch) => ({ dir: `${scratch}/sandbox/archive` }) } });
    const archive = result.input.config.modules.find((m) => m.use === "@acme/kestrel-archive");
    expect(archive?.config).toEqual({ dir: "/tmp/scratch-1/sandbox/archive" });
    expect(result.rewritten).toContain("@acme/kestrel-archive");
    expect(result.outside).not.toContain("@acme/kestrel-archive");
  });

  it("matches a table entry for a local module by its use string, ignoring a query or fragment", () => {
    const withLocal: BootInput = { ...input(), config: { ...input().config, modules: [...input().config.modules.slice(0, 3), { use: "./modules/notes.ts#second", config: { apiKey: "secret" } }] } };
    const result = sandboxBootInput(withLocal, { dir: "/tmp/scratch-1", entries: { "./modules/notes.ts": () => ({ apiKey: "none" }) } });
    expect(result.rewritten).toContain("./modules/notes.ts#second");
    expect(result.outside).toEqual([]);
  });

  it("does not match a table entry keyed by a bare module name", () => {
    const withExtra: BootInput = { ...input(), config: { ...input().config, modules: [...input().config.modules, { use: "@michaelthielemann/kestrel-archive", config: {} }] } };
    const result = sandboxBootInput(withExtra, { dir: "/tmp/scratch-1", entries: { archive: () => ({}) } });
    expect(result.outside).toContain("@michaelthielemann/kestrel-archive");
  });

  it("reports each table entry no module-list entry matched, including one keyed with a query or fragment", () => {
    const result = sandboxBootInput(input(), { dir: "/tmp/scratch-1", entries: { "./modules/notes.ts": () => ({}), "@acme/kestrel-archive": () => ({}), "./modules/notes.ts#second": () => ({}) } });
    expect(result.unmatched).toEqual(["@acme/kestrel-archive", "./modules/notes.ts#second"]);
  });

  it("reports no unmatched entry when there are no extra entries", () => {
    expect(sandboxBootInput(input(), { dir: "/tmp/scratch-1" }).unmatched).toEqual([]);
  });

  it("refuses a table entry that would replace a built-in rewrite, naming the entry", () => {
    expect(() => sandboxBootInput(input(), { dir: "/tmp/scratch-1", entries: { "@michaelthielemann/kestrel-persistence-sqlite": (config) => config } })).toThrow(
      /sandbox entry "@michaelthielemann\/kestrel-persistence-sqlite" collides with a built-in rewrite/,
    );
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
