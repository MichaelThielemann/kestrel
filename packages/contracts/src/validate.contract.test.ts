import { describe, it, expect, beforeEach } from "vitest";
import type { Validate } from "./validate.ts";

const SCHEMAS: Record<string, unknown> = {
  "pages.title": { type: "string", minLength: 1 },
  "pages.body": { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
};

export function validateContractTests(make: (schemas: Record<string, unknown>) => Promise<Validate>) {
  describe("validate@1", () => {
    let validate: Validate;

    beforeEach(async () => {
      validate = await make(SCHEMAS);
    });

    it("lists the configured targets", () => {
      expect([...validate.targets()].sort()).toEqual(Object.keys(SCHEMAS).sort());
    });

    it("accepts a value that matches the schema", () => {
      expect(validate.check("pages.title", "Hello")).toEqual({ ok: true, problems: [] });
    });

    it("rejects a value that violates the schema with at least one problem", () => {
      const result = validate.check("pages.body", { text: 5 });
      expect(result.ok).toBe(false);
      expect(result.problems.length).toBeGreaterThan(0);
      for (const problem of result.problems) {
        expect(problem.path.startsWith("/")).toBe(true);
        expect(problem.message.length).toBeGreaterThan(0);
      }
    });

    it("throws for an unknown target", () => {
      expect(() => validate.check("pages.nope", {})).toThrow();
    });
  });
}
