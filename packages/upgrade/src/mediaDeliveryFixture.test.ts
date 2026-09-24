import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { runUpgradeCli } from "./plugin.ts";
import type { UpgradeReport } from "./report.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "__fixtures__", "media-delivery-5.8");

async function runJson(): Promise<{ code: number; report: UpgradeReport }> {
  const lines: string[] = [];
  const code = await runUpgradeCli(["check", "--root", FIXTURE, "--json"], { stdout: (line) => lines.push(line), stderr: () => undefined });
  return { code, report: boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json") };
}

describe("kestrel-upgrade against the media-delivery-5.8 fixture (old delivery-static media option, mismatched images-default publicPath, custom media-URL code)", () => {
  it("reports the removed delivery-static media option with an auto fix", async () => {
    const { report } = await runJson();
    const finding = report.findings.find((f) => f.rule === "modules/delivery-media");
    expect(finding).toBeDefined();
    expect(finding?.fix.kind).toBe("auto");
    expect(finding?.fix.kind === "auto" ? finding.fix.edits.length : 0).toBeGreaterThan(0);
  });

  it("reports images-default's publicPath mismatch (and its trailing slash) with an auto fix", async () => {
    const { report } = await runJson();
    const finding = report.findings.find((f) => f.rule === "modules/media-public-path");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warning");
    expect(finding?.fix.kind).toBe("auto");
    expect(finding?.message).toContain("/api/");
  });

  it("reports the pipeline gap for media.serve and images.serve, auto-fixed since the fixture has a pipelines directory", async () => {
    const { report } = await runJson();
    const missing = report.findings.find((f) => f.rule === "pipelines/media-serve" && f.id.endsWith(":missing"));
    expect(missing).toBeDefined();
    expect(missing?.message).toContain("media.serve");
    expect(missing?.message).toContain("images.serve");
    expect(missing?.fix.kind).toBe("auto");
    const edits = missing!.fix.kind === "auto" ? missing!.fix.edits : [];
    expect(edits.some((e) => e.file.endsWith("serveMediaFile.ts") && e.create === true)).toBe(true);
    expect(edits.some((e) => e.file.endsWith("serveImageVariant.ts") && e.create === true)).toBe(true);
  });

  it("reports the missing repair pipelines (media.syncPublic/images.syncPublic), auto-fixed", async () => {
    const { report } = await runJson();
    const finding = report.findings.find((f) => f.rule === "pipelines/media-repair");
    expect(finding).toBeDefined();
    expect(finding?.fix.kind).toBe("auto");
    const edits = finding!.fix.kind === "auto" ? finding!.fix.edits : [];
    expect(edits.some((e) => e.file.endsWith("repairPublicMedia.ts"))).toBe(true);
    expect(edits.some((e) => e.file.endsWith("syncPublicMedia.ts"))).toBe(true);
  });

  it("reports images-default configured with no images.resume cron", async () => {
    const { report } = await runJson();
    const finding = report.findings.find((f) => f.rule === "pipelines/images-resume-cron");
    expect(finding).toBeDefined();
    expect(finding?.fix.kind).toBe("manual");
  });

  it("reports the missing anonymous media.read grant, since authz-roles is configured with anonymous: []", async () => {
    const { report } = await runJson();
    const finding = report.findings.find((f) => f.rule === "pipelines/media-serve" && f.id.endsWith("anonymous-media-read"));
    expect(finding).toBeDefined();
  });

  it("reports the custom module's import of the removed rewriteMedia export, manual", async () => {
    const { report } = await runJson();
    const finding = report.findings.find((f) => f.rule === "imports/removed-export");
    expect(finding).toBeDefined();
    expect(finding?.fix.kind).toBe("manual");
    expect(finding?.message).toContain("rewriteMedia");
    expect(finding?.message).toContain("custom/media-links");
  });

  it("never crashes and never returns 0 while these findings are open", async () => {
    const { code, report } = await runJson();
    expect(report.tiers.source).toBe("done");
    expect(code).toBe(1);
  });
});
