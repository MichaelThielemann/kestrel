import { execFile } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScratchCopy } from "./scratch.ts";

const run = promisify(execFile);

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

describe("createScratchCopy, with a git-tracked symlink", () => {
  it("recreates a tracked directory symlink as a symlink instead of crashing with EISDIR, and a tracked file symlink stays a symlink reading through to the same content", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-scratch-outside-"));
    try {
      await mkdir(join(outsideDir, "linked-dir"), { recursive: true });
      await writeFile(join(outsideDir, "linked-dir", "inside.ts"), "export const inside = 1;\n");
      const outsideFile = join(outsideDir, "linked-file.ts");
      const originalFileSource = "export const linked = 1;\n";
      await writeFile(outsideFile, originalFileSource);

      await writeFile(join(dir, "kestrel.config.ts"), "export default {};\n");
      await symlink(join(outsideDir, "linked-dir"), join(dir, "linked-dir"), "dir");
      await symlink(outsideFile, join(dir, "linked-file.ts"), "file");
      await run("git", ["init"], { cwd: dir });
      await run("git", ["config", "user.email", "t@example.com"], { cwd: dir });
      await run("git", ["config", "user.name", "t"], { cwd: dir });
      await run("git", ["add", "-A"], { cwd: dir });
      await run("git", ["commit", "-m", "initial"], { cwd: dir });

      const scratch = await createScratchCopy(dir);
      cleanupDirs.push(scratch.dir);

      expect(lstatSync(join(scratch.dir, "linked-dir")).isSymbolicLink()).toBe(true);
      expect(await readFile(join(scratch.dir, "linked-dir", "inside.ts"), "utf8")).toBe("export const inside = 1;\n");

      expect(lstatSync(join(scratch.dir, "linked-file.ts")).isSymbolicLink()).toBe(true);
      expect(await readFile(join(scratch.dir, "linked-file.ts"), "utf8")).toBe(originalFileSource);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("keeps a tracked in-project symlink pointing inside the scratch copy, relative or absolute, so an edit to the target in the copy is visible through the link there", async () => {
    await mkdir(join(dir, "lib"), { recursive: true });
    const originalRelativeSource = "export const shared = 1;\n";
    await writeFile(join(dir, "lib", "shared.ts"), originalRelativeSource);
    const originalAbsoluteSource = "export const other = 1;\n";
    await writeFile(join(dir, "lib", "other.ts"), originalAbsoluteSource);
    await writeFile(join(dir, "kestrel.config.ts"), "export default {};\n");
    await symlink("./lib/shared.ts", join(dir, "shared.ts"), "file");
    await symlink(join(dir, "lib", "other.ts"), join(dir, "other.ts"), "file");
    await run("git", ["init"], { cwd: dir });
    await run("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    await run("git", ["config", "user.name", "t"], { cwd: dir });
    await run("git", ["add", "-A"], { cwd: dir });
    await run("git", ["commit", "-m", "initial"], { cwd: dir });

    const scratch = await createScratchCopy(dir);
    cleanupDirs.push(scratch.dir);

    expect(await readFile(join(scratch.dir, "shared.ts"), "utf8")).toBe(originalRelativeSource);
    expect(await readFile(join(scratch.dir, "other.ts"), "utf8")).toBe(originalAbsoluteSource);

    const editedRelativeSource = "export const shared = 2;\n";
    await writeFile(join(scratch.dir, "lib", "shared.ts"), editedRelativeSource);
    const editedAbsoluteSource = "export const other = 2;\n";
    await writeFile(join(scratch.dir, "lib", "other.ts"), editedAbsoluteSource);

    expect(await readFile(join(scratch.dir, "shared.ts"), "utf8")).toBe(editedRelativeSource);
    expect(await readFile(join(scratch.dir, "other.ts"), "utf8")).toBe(editedAbsoluteSource);
    expect(await readFile(join(dir, "lib", "shared.ts"), "utf8")).toBe(originalRelativeSource);
    expect(await readFile(join(dir, "lib", "other.ts"), "utf8")).toBe(originalAbsoluteSource);
  });
});
