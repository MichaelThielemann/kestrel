import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function countOnCallSitesByFile(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const dir of ["packages", "examples", "scripts"]) {
    for (const file of sourceFiles(join(root, dir))) {
      const relative = file.slice(root.length + 1);
      const hits = readFileSync(file, "utf8").split("\n").filter((line) => /\.on\(/.test(line)).length;
      if (hits > 0) counts[relative] = hits;
    }
  }
  return counts;
}

const KNOWN_NON_EVENT_FILES = ["packages/cli/src/commands/start.ts", "packages/cli/test/harness.ts", "packages/validate-jsonschema/impl.ts", "packages/upgrade/src/ruleInfo.ts", "packages/upgrade/src/cleanup.ts", "packages/links-default/outbound.ts", "packages/core/src/instanceLock.ts", "packages/ops/src/interrupt.ts", "packages/ops/src/run.ts", "packages/ops/src/target.ts"];

describe("events.on call sites", () => {
  it("pins the file and count of every on( call site — the two delivery subscriptions, and nothing else new", () => {
    const counts = countOnCallSitesByFile();
    const eventFiles = Object.fromEntries(Object.entries(counts).filter(([file]) => !KNOWN_NON_EVENT_FILES.includes(file)));
    expect(eventFiles).toEqual({ "packages/events-direct/impl.ts": 1, "packages/events-queue/module.ts": 1 });
  });
});
