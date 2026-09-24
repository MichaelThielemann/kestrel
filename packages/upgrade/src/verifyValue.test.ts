import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { runUpgradeCli } from "./plugin.ts";
import type { UpgradeReport } from "./report.ts";
import { createScratchCopy } from "./scratch.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "__fixtures__", "hole-5.8");

const cleanupDirs: string[] = [];
afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("fix drops an edit whose resulting array has a hole, instead of writing it", () => {
  it("rejects an insertion that lands between an anchor's trailing comment and the next entry's leading comma", async () => {
    const scratch = await createScratchCopy(FIXTURE);
    cleanupDirs.push(scratch.dir);
    const before = readFileSync(join(scratch.dir, "kestrel.config.ts"), "utf8");

    const code = await runUpgradeCli(["fix", "--root", scratch.dir, "--write", "--yes"], { stdout: () => undefined, stderr: () => undefined });
    expect(code).toBe(1);

    const configText = readFileSync(join(scratch.dir, "kestrel.config.ts"), "utf8");
    expect(configText).toBe(before);

    const lines: string[] = [];
    await runUpgradeCli(["check", "--root", scratch.dir, "--json"], { stdout: (l) => lines.push(l), stderr: () => undefined });
    const report = boundaryCast<UpgradeReport>(JSON.parse(lines[0]!), "json");
    const finding = report.findings.find((f) => f.rule === "modules/event-delivery");
    expect(finding?.fix.kind).toBe("manual");
  });
});
