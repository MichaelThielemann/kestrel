import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localTarget } from "./target.ts";

const copies = vi.hoisted(() => ({ cutAfter: null as number | null }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    copyFileSync: (source: fs.PathLike, target: fs.PathLike, mode?: number) => {
      if (copies.cutAfter === null) return actual.copyFileSync(source, target, mode);
      actual.writeFileSync(target, actual.readFileSync(source).subarray(0, copies.cutAfter));
      throw Object.assign(new Error("ENOSPC: no space left on device, copyfile"), { code: "ENOSPC" });
    },
  };
});

describe("the local target placing a restored database", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), "kestrel-ops-install-"));
    fs.mkdirSync(join(root, "app"));
    fs.writeFileSync(join(root, "restored.db"), "a restored database of some length");
  });
  afterEach(() => {
    copies.cutAfter = null;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("leaves no <database>.restore and no partial file when the copy breaks off", async () => {
    const target = await localTarget({ dir: "app", database: "kestrel.db", command: [process.execPath, "server.mjs"], disk: "persistent" }, { root, clock: Date.now });
    copies.cutAfter = 8;
    await expect(target.installDatabase?.(join(root, "restored.db"))).rejects.toThrow(/ENOSPC/);
    expect(fs.readdirSync(join(root, "app"))).toEqual([]);
  });

  it("places the whole file as <database>.restore and nothing else", async () => {
    const target = await localTarget({ dir: "app", database: "kestrel.db", command: [process.execPath, "server.mjs"], disk: "persistent" }, { root, clock: Date.now });
    await target.installDatabase?.(join(root, "restored.db"));
    expect(fs.readdirSync(join(root, "app"))).toEqual(["kestrel.db.restore"]);
    expect(fs.readFileSync(join(root, "app", "kestrel.db.restore"), "utf8")).toBe("a restored database of some length");
  });
});
