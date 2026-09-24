import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScratchCopy } from "./scratch.ts";

const createdScratchDirs: string[] = [];
let failCopyOf: string | undefined;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    mkdtemp: async (prefix: string) => {
      const d = await actual.mkdtemp(prefix);
      createdScratchDirs.push(d);
      return d;
    },
    copyFile: async (src: string, dest: string) => {
      if (failCopyOf !== undefined && src.endsWith(failCopyOf)) throw new Error(`simulated copy failure for ${src}`);
      return actual.copyFile(src, dest);
    },
  };
});

let dir: string;
const cleanupDirs: string[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-scratch-test-"));
  createdScratchDirs.length = 0;
  failCopyOf = undefined;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  for (const d of cleanupDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("createScratchCopy, outside a git repository", () => {
  it("never copies a .env file or a database file into the scratch copy", async () => {
    await writeFile(join(dir, "kestrel.config.ts"), "export default {};\n");
    await writeFile(join(dir, ".env"), "SECRET_TOKEN=abc123\n");
    await writeFile(join(dir, ".env.production"), "SECRET_TOKEN=xyz\n");
    await writeFile(join(dir, "data.db"), "not really sqlite but should still be excluded");
    await writeFile(join(dir, "data.db-wal"), "wal file");

    const scratch = await createScratchCopy(dir);
    cleanupDirs.push(scratch.dir);

    expect(existsSync(join(scratch.dir, "kestrel.config.ts"))).toBe(true);
    expect(existsSync(join(scratch.dir, ".env"))).toBe(false);
    expect(existsSync(join(scratch.dir, ".env.production"))).toBe(false);
    expect(existsSync(join(scratch.dir, "data.db"))).toBe(false);
    expect(existsSync(join(scratch.dir, "data.db-wal"))).toBe(false);
  });

  it("removes its own partial copy if it fails partway through, instead of leaking the tracked directory", async () => {
    await writeFile(join(dir, "kestrel.config.ts"), "export default {};\n");
    await writeFile(join(dir, "package.json"), "{}\n");
    failCopyOf = "package.json";

    await expect(createScratchCopy(dir)).rejects.toThrow("simulated copy failure");

    expect(createdScratchDirs.length).toBeGreaterThan(0);
    for (const scratchDir of createdScratchDirs) expect(existsSync(scratchDir)).toBe(false);
  });

  it("leaves zero leftover directories across many repeated failing calls", async () => {
    await writeFile(join(dir, "kestrel.config.ts"), "export default {};\n");
    await writeFile(join(dir, "package.json"), "{}\n");
    failCopyOf = "package.json";

    const RUNS = 20;
    for (let i = 0; i < RUNS; i++) await expect(createScratchCopy(dir)).rejects.toThrow("simulated copy failure");

    expect(createdScratchDirs.length).toBe(RUNS);
    const leftover = createdScratchDirs.filter((scratchDir) => existsSync(scratchDir));
    expect(leftover).toEqual([]);
  });
});
