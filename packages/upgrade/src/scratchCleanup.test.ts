import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type * as ScratchModule from "./scratch.ts";

const created: string[] = [];

vi.mock("./scratch.ts", async () => {
  const actual = await vi.importActual<typeof ScratchModule>("./scratch.ts");
  return {
    ...actual,
    createScratchCopy: async (root: string) => {
      const scratch = await actual.createScratchCopy(root);
      created.push(scratch.dir);
      return scratch;
    },
  };
});

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "__fixtures__", "minimal-5.8");

describe("check and fix remove every scratch copy they create", () => {
  it("leaves no scratch directory behind after check completes", async () => {
    const { runUpgradeCli } = await import("./plugin.ts");
    created.length = 0;
    await runUpgradeCli(["check", "--root", FIXTURE, "--json"], { stdout: () => undefined, stderr: () => undefined });
    expect(created.length).toBeGreaterThan(0);
    for (const dir of created) expect(existsSync(dir)).toBe(false);
  });
});
