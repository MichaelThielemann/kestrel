import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, PREFIXES, type Harness } from "./harness.fixture.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";

const filesystem = vi.hoisted(() => ({ caseInsensitive: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const sameName = (path: fs.PathLike): boolean => {
    const dir = dirname(String(path));
    const name = basename(String(path)).toLowerCase();
    return actual.existsSync(dir) && actual.readdirSync(dir).some((entry) => entry.toLowerCase() === name);
  };
  return {
    ...actual,
    existsSync: (path: fs.PathLike) => actual.existsSync(path) || (filesystem.caseInsensitive && sameName(path)),
  };
});

async function backupWithCaseTwins(h: Harness): Promise<string> {
  await h.app.start();
  await h.app.seed();
  await h.app.upload("Team", "photo.png", new TextEncoder().encode("the team in summer"));
  await h.app.upload("team", "photo.png", new TextEncoder().encode("the team in winter"));
  await h.app.sync();
  const backup = await h.run(["backup", "create", "--freeze", "--json"]);
  expect(backup.code).toBe(0);
  return String(backup.json.id);
}

describe("restore --to local --with-media and keys that differ only in case", () => {
  afterEach(() => {
    filesystem.caseInsensitive = false;
  });

  it("refuses on a case-insensitive file system before it writes anything, naming both keys", async () => {
    const h = createHarness({ store: memoryStore(new MemoryBucket("case-twins")) });
    try {
      const id = await backupWithCaseTwins(h);
      filesystem.caseInsensitive = true;
      const out = join(h.root, "copy");
      const copied = await h.run(["restore", "--to", "local", out, "--backup", id, "--with-media", "--yes"]);
      expect(copied.code).toBe(1);
      expect(copied.stderr).toContain(`${PREFIXES.media}Team/photo.png`);
      expect(copied.stderr).toContain(`${PREFIXES.media}team/photo.png`);
      expect(fs.readdirSync(out)).toEqual([]);
    } finally {
      await h.dispose();
    }
  });

  it("writes both on a case-sensitive file system", async () => {
    const h = createHarness({ store: memoryStore(new MemoryBucket("case-twins-sensitive")) });
    try {
      const id = await backupWithCaseTwins(h);
      const out = join(h.root, "copy");
      const copied = await h.run(["restore", "--to", "local", out, "--backup", id, "--with-media", "--yes"]);
      expect(copied.stderr).toBe("");
      expect(copied.code).toBe(0);
      expect(fs.readFileSync(join(out, "blobs", PREFIXES.media, "Team", "photo.png"), "utf8")).toBe("the team in summer");
      expect(fs.readFileSync(join(out, "blobs", PREFIXES.media, "team", "photo.png"), "utf8")).toBe("the team in winter");
    } finally {
      await h.dispose();
    }
  });
});
