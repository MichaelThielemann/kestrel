import { describe, expect, it } from "vitest";
import { unifiedDiff } from "./diff.ts";

describe("unifiedDiff", () => {
  it("returns empty for identical text", () => {
    expect(unifiedDiff("a.ts", "same\n", "same\n")).toBe("");
  });

  it("renders one hunk for a single-line change with headers", () => {
    const before = "a\nb\nc\n";
    const after = "a\nX\nc\n";
    const out = unifiedDiff("a.ts", before, after);
    expect(out).toContain("--- a/a.ts");
    expect(out).toContain("+++ b/a.ts");
    expect(out).toContain("-b");
    expect(out).toContain("+X");
    expect(out).toContain(" a");
    expect(out).toContain(" c");
  });

  it("reports correct line numbers for a change past several unchanged lines", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].join("\n") + "\n";
    const after = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "X"].join("\n") + "\n";
    const out = unifiedDiff("f.ts", before, after);
    expect(out).toMatch(/@@ -7,4 \+7,4 @@/);
  });

  it("splits into two hunks when changes are far apart", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n") + "\n";
    const lines = before.split("\n");
    lines[1] = "CHANGED-A";
    lines[18] = "CHANGED-B";
    const after = lines.join("\n");
    const out = unifiedDiff("f.ts", before, after);
    expect(out.match(/^@@/gm)).toHaveLength(2);
  });

  it("handles a pure insertion", () => {
    const before = "a\nb\n";
    const after = "a\nb\nc\n";
    const out = unifiedDiff("f.ts", before, after);
    expect(out).toContain("+c");
  });
});
