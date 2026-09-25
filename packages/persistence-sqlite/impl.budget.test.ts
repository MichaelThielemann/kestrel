import { describe, expect, it } from "vitest";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { createPersistenceSqlite, type Config } from "./impl.ts";

function warningsFor(config: Omit<Config, "file">): string[] {
  const warnings: string[] = [];
  const logger: Logger = { step() {}, info() {}, warn: (message) => warnings.push(message), error() {} };
  createPersistenceSqlite({ file: ":memory:", ...config }, { logger }).close();
  return warnings;
}

describe("persistence/sqlite: an acquire budget that a single group can outlast", () => {
  it("logs a warning naming both keys when acquireTimeoutMs does not exceed scopeTimeoutMs", () => {
    const warnings = warningsFor({ busyTimeoutMs: 1000, acquireTimeoutMs: 6000, scopeTimeoutMs: 6000 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("acquireTimeoutMs");
    expect(warnings[0]).toContain("scopeTimeoutMs");
  });

  it("logs the warning for an explicit scopeTimeoutMs above the derived acquireTimeoutMs", () => {
    expect(warningsFor({ scopeTimeoutMs: 20000 })).toHaveLength(1);
  });

  it("logs nothing with the defaults, or with acquireTimeoutMs above scopeTimeoutMs", () => {
    expect(warningsFor({})).toEqual([]);
    expect(warningsFor({ busyTimeoutMs: 1000, acquireTimeoutMs: 6001, scopeTimeoutMs: 6000 })).toEqual([]);
  });
});
