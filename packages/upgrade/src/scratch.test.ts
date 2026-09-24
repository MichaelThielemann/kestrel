import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createScratchCopy } from "./scratch.ts";

let dir: string;
const cleanupDirs: string[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-scratch-test-"));
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
});
