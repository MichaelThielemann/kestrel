import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { objectBindingCandidates } from "./objectBinding.candidates.ts";
import { OBJECT_BINDING_REGISTRY } from "./objectBinding.waivers.ts";

const PACKAGES = resolve(import.meta.dirname, "../..");
const candidates = objectBindingCandidates(PACKAGES);

describe("every foreign-id candidate step has a test or a waiver", () => {
  it("finds at least one candidate (the scan itself still works)", () => {
    expect(candidates.length).toBeGreaterThan(0);
  });

  for (const candidate of candidates) {
    it(candidate.step, () => {
      const entry = OBJECT_BINDING_REGISTRY[candidate.step];
      if (!entry) expect.fail(`${candidate.step} reads params.* plus another request-controlled value or an input schema (reads=${JSON.stringify(candidate.reads)}); it needs a foreign-id test or a waiver in objectBinding.waivers.ts`);
      if (entry.kind === "waiver") {
        expect(entry.reason.trim().length, `${candidate.step}: waiver reason must not be empty`).toBeGreaterThan(0);
        return;
      }
      const file = join(PACKAGES, entry.file);
      expect(existsSync(file), `${candidate.step}: waivers.ts names "${entry.file}" which does not exist`).toBe(true);
      const text = readFileSync(file, "utf8");
      expect(text.includes(`it("${entry.title}"`), `${candidate.step}: no test titled "${entry.title}" in ${entry.file}`).toBe(true);
    });
  }

  it("names no waiver or test for a step the scan no longer finds a candidate", () => {
    const known = new Set(candidates.map((c) => c.step));
    const stale = Object.keys(OBJECT_BINDING_REGISTRY).filter((step) => !known.has(step));
    expect(stale).toEqual([]);
  });
});
