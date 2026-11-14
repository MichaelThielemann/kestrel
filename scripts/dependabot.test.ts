import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function updateBlocks(source: string): string[] {
  return source.split(/^ {2}- (?=package-ecosystem:)/m).slice(1);
}

describe("the dependabot configuration", () => {
  const blocks = updateBlocks(readFileSync(join(ROOT, ".github", "dependabot.yml"), "utf8"));

  it("covers the workflows and the example container", () => {
    expect(blocks.map((block) => /^package-ecosystem: (\S+)/.exec(block)?.[1])).toEqual(["github-actions", "docker"]);
  });

  it("holds every update back for at least three days after a release", () => {
    for (const block of blocks) {
      const days = /^ {4}cooldown:\n {6}default-days: (\d+)$/m.exec(block)?.[1];
      expect(Number(days), block.split("\n")[0]).toBeGreaterThanOrEqual(3);
    }
  });
});
