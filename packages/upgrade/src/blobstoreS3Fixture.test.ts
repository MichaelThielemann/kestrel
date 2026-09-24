import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { runUpgradeCli } from "./plugin.ts";
import type { UpgradeReport } from "./report.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "__fixtures__", "blobstore-s3-5.8");
const INVALID_FIXTURE = join(HERE, "..", "__fixtures__", "blobstore-s3-invalid-5.8");

async function runJson(argv: string[], forceInstalledMajor?: number): Promise<{ code: number; report: UpgradeReport }> {
  const lines: string[] = [];
  const code = await runUpgradeCli(argv, { stdout: (line) => lines.push(line), stderr: () => undefined, ...(forceInstalledMajor === undefined ? {} : { forceInstalledMajor }) });
  return { code, report: boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json") };
}

describe("kestrel-upgrade check against the blobstore-s3-5.8 fixture", () => {
  it("checks every module requiring blobstore@1, replacing the S3 module with a local stand-in", async () => {
    const { report } = await runJson(["check", "--root", FIXTURE, "--json"], 6);
    expect(report.tiers).toEqual({ source: "done", load: "done", boot: "done", data: "not-run" });

    const notChecked = report.findings.filter((f) => f.rule === "boot/not-checked").map((f) => f.where.module);
    for (const name of ["media/default", "images/default", "delivery/static", "replication/sqlite", "backup/blobstore"]) {
      expect(notChecked).not.toContain(name);
    }

    const standIn = report.findings.find((f) => f.rule === "sandbox/blobstore-standin");
    expect(standIn?.where.module).toBe("@michaelthielemann/kestrel-blobstore-s3");
    expect(standIn?.message).toBe("blobstore replaced by a local stand-in for the check");

    expect(report.findings.some((f) => f.rule === "boot/not-checked" && f.where.module === "@michaelthielemann/kestrel-blobstore-s3")).toBe(false);
  });
});

describe("kestrel-upgrade check against the blobstore-s3-invalid-5.8 fixture", () => {
  it("reports the real module's own config error instead of letting the stand-in's schema accept it", async () => {
    const { report } = await runJson(["check", "--root", INVALID_FIXTURE, "--json"], 6);
    const configError = report.findings.find((f) => f.rule === "boot/invalid-module-config");
    expect(configError?.where.module).toBe("blobstore/s3");
    expect(configError?.message).toContain("bucket");
  });
});
