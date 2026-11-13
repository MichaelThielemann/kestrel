import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { runCli } from "./cli-run.ts";
import type { UpgradeReport } from "./report.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "__fixtures__", "images-render-timeout-5.8");

async function runJson(argv: string[]): Promise<UpgradeReport> {
  const lines: string[] = [];
  await runCli(argv, { stdout: (line) => lines.push(line), stderr: () => undefined, forceInstalledMajor: 6 });
  return boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json");
}

describe("kestrel-upgrade check against the images-render-timeout-5.8 fixture", () => {
  it("reports a renderTimeoutMs not below staleAfterMs once, as its own rule instead of a boot error", async () => {
    const report = await runJson(["check", "--root", FIXTURE, "--json"]);
    expect(report.tiers.boot).toBe("done");
    const errors = report.findings.filter((f) => f.severity === "error" && (f.rule === "modules/images-render-timeout" || f.where.module === "images/default"));
    expect(errors.map((f) => f.rule)).toEqual(["modules/images-render-timeout"]);
    expect(errors[0]?.where).toMatchObject({ module: "images/default", path: "staleAfterMs" });
  });
});
