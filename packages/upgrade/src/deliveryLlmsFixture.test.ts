import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { applyEdits } from "./apply.ts";
import { runUpgradeCli } from "./plugin.ts";
import type { Finding, UpgradeReport } from "./report.ts";
import { verifiesAfterEdit } from "./verify.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "__fixtures__", "delivery-llms-5.8");

async function runJson(): Promise<{ code: number; report: UpgradeReport }> {
  const lines: string[] = [];
  const code = await runUpgradeCli(["check", "--root", FIXTURE, "--json"], { stdout: (line) => lines.push(line), stderr: () => undefined });
  return { code, report: boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json") };
}

function editedFile(finding: Finding | undefined, name: string): { file: string; text: string } {
  const edits = finding?.fix.kind === "auto" ? finding.fix.edits : [];
  const file = join(FIXTURE, name);
  const own = edits.filter((e) => e.file.endsWith(name));
  expect(own.length).toBeGreaterThan(0);
  return { file, text: applyEdits(readFileSync(file, "utf8"), own).text };
}

describe("kestrel-upgrade against the delivery-llms-5.8 fixture (llms.siteUrl and an inline delivery.exportLlms)", () => {
  it("rewrites the inline delivery.exportLlms to delivery.requestIndexes", async () => {
    const { report } = await runJson();
    const finding = report.findings.find((f) => f.rule === "delivery/export-llms");
    expect(finding).toMatchObject({ severity: "error", where: { pipeline: "publishAllPages" } });
    const { file, text } = editedFile(finding, join("pipelines", "publishAllPages.ts"));
    expect(text).toContain('steps: ["delivery.publishAll:pages", "delivery.requestIndexes"]');
    expect(verifiesAfterEdit(file, text)).toBe(true);
  });

  it("moves llms.siteUrl to the top-level siteUrl", async () => {
    const { report } = await runJson();
    const finding = report.findings.find((f) => f.rule === "delivery/site-url");
    expect(finding?.severity).toBe("error");
    const { file, text } = editedFile(finding, "kestrel.config.ts");
    expect(text).toContain('llms: { full: true }, siteUrl: "https://example.org" }');
    expect(verifiesAfterEdit(file, text)).toBe(true);
  });

  it("names the llms member the publish-all response loses, and asks for no export jobs under render \"background\"", async () => {
    const { code, report } = await runJson();
    expect(report.findings.find((f) => f.rule === "responses/delivery-members")?.message).toContain("no llms member");
    expect(report.findings.some((f) => f.rule === "delivery/index-triggers")).toBe(false);
    expect(code).toBe(1);
  });
});
