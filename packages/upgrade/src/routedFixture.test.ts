import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { runCli } from "./cli-run.ts";
import type { UpgradeReport } from "./report.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "__fixtures__", "routed-6.0");
const NESTED = join(HERE, "..", "__fixtures__", "routed-nested-6.0");

describe("kestrel-upgrade check against a routed 6.0 project", () => {
  it("prints nothing but the JSON report, and the report names the routed slug's unique flag once", async () => {
    const lines: string[] = [];
    const written: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      written.push(args.map(String).join(" "));
    });
    let code: number;
    try {
      code = await runCli(["check", "--root", FIXTURE, "--json"], { stdout: (line) => lines.push(line), stderr: () => undefined, forceInstalledMajor: 6 });
    } finally {
      spy.mockRestore();
    }
    expect(written).toEqual([]);
    const report = boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json");
    expect(report.tiers.boot).toBe("done");
    expect(report.findings.filter((f) => f.rule === "site/routed-slug-unique")).toHaveLength(1);
    expect(report.findings.filter((f) => f.rule.startsWith("boot/") && f.where.module === "site/default")).toEqual([]);
    expect(code).toBe(0);
  });

  it("reports a unique slug on a nested route once, as the rule's error, not again as site/default's setup failure", async () => {
    const lines: string[] = [];
    const code = await runCli(["check", "--root", NESTED, "--json"], { stdout: (line) => lines.push(line), stderr: () => undefined, forceInstalledMajor: 6 });
    const report = boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json");
    const siteFindings = report.findings.filter((f) => f.where.module === "site/default" && f.rule !== "boot/not-checked");
    expect(siteFindings.map((f) => [f.rule, f.severity])).toEqual([["site/routed-slug-unique", "error"]]);
    expect(siteFindings[0]?.fix.kind).toBe("auto");
    expect(code).toBe(1);
  });
});
