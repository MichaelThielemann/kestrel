import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Hit {
  file: string;
  line: number;
}

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

function scanOnCallSites(): Hit[] {
  const hits: Hit[] = [];
  for (const dir of ["packages", "examples", "scripts"]) {
    for (const file of sourceFiles(join(root, dir))) {
      const relative = file.slice(root.length + 1);
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/\.on\(/.test(line)) hits.push({ file: relative, line: i + 1 });
      });
    }
  }
  return hits;
}

const KNOWN_NON_EVENT_HITS = ["packages/core/src/cli.ts:23", "packages/core/src/cli.ts:24", "packages/validate-jsonschema/impl.ts:215"];

describe("events.on call sites", () => {
  it("pins every on( call site — the two delivery subscriptions, and nothing else new", () => {
    const locations = scanOnCallSites().map((h) => `${h.file}:${h.line}`);
    const eventSubscriptions = locations.filter((l) => !KNOWN_NON_EVENT_HITS.includes(l));
    expect(eventSubscriptions.sort()).toEqual(["packages/events-direct/impl.ts:11", "packages/events-queue/module.ts:64"]);
  });
});
