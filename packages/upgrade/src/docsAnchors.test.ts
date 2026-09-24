import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_FILE = join(HERE, "..", "..", "..", "docs", "upgrading.md");

function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9 _-]/g, "")
    .replace(/\s+/g, "-");
}

function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  for (const line of markdown.split("\n")) {
    const match = /^#{1,6}\s+(.+)$/.exec(line);
    if (match) anchors.add(slugify(match[1]!));
  }
  return anchors;
}

function referencedAnchors(): Set<string> {
  const anchors = new Set<string>();
  for (const name of readdirSync(HERE)) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    const source = readFileSync(join(HERE, name), "utf8");
    for (const m of source.matchAll(/docs\/upgrading\.md#([a-z0-9-]+)/g)) anchors.add(m[1]!);
  }
  return anchors;
}

describe("every docs/upgrading.md#<anchor> a finding links to exists as a heading", () => {
  it("has no dangling anchor", () => {
    const anchors = headingAnchors(readFileSync(DOCS_FILE, "utf8"));
    const referenced = referencedAnchors();
    expect(referenced.size).toBeGreaterThan(0);
    const missing = [...referenced].filter((a) => !anchors.has(a));
    expect(missing).toEqual([]);
  });
});
