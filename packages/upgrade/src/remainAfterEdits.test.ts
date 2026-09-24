import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runUpgradeCli } from "./plugin.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

async function remainLine(fixture: string): Promise<string | undefined> {
  const lines: string[] = [];
  await runUpgradeCli(["fix", "--root", join(HERE, "..", "__fixtures__", fixture)], { stdout: (l) => lines.push(l), stderr: () => undefined, forceInstalledMajor: 6 });
  return lines.find((l) => l.startsWith("after these edits:"));
}

describe("fix preview counts what a boot of the fully edited copy would still reject", () => {
  it("drops an unknown-step boot error that the matching source auto-fix resolves", async () => {
    expect(await remainLine("event-emit-5.8")).toBe("after these edits: 0 errors remain (0 need your answer, 0 manual)");
  });

  it("keeps an unknown-step boot error no edit resolves", async () => {
    expect(await remainLine("minimal-5.8")).toBe("after these edits: 1 errors remain (0 need your answer, 1 manual)");
  });
});
