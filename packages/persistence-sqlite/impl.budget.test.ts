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
  it("logs a warning naming the keys when acquireTimeoutMs does not exceed scopeTimeoutMs", () => {
    const warnings = warningsFor({ busyTimeoutMs: 1000, acquireTimeoutMs: 6000, scopeTimeoutMs: 6000 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("acquireTimeoutMs");
    expect(warnings[0]).toContain("scopeTimeoutMs");
    expect(warnings[0]).toContain("busyTimeoutMs");
  });

  it("logs the warning when acquireTimeoutMs exceeds scopeTimeoutMs but not scopeTimeoutMs plus the busy wait of a group's BEGIN", () => {
    expect(warningsFor({ busyTimeoutMs: 1000, acquireTimeoutMs: 5500, scopeTimeoutMs: 5000 })).toHaveLength(1);
    expect(warningsFor({ busyTimeoutMs: 1000, acquireTimeoutMs: 6000, scopeTimeoutMs: 5000 })).toHaveLength(1);
  });

  it("logs the warning for an explicit scopeTimeoutMs above the derived acquireTimeoutMs", () => {
    expect(warningsFor({ scopeTimeoutMs: 20000 })).toHaveLength(1);
  });

  it("logs nothing with the defaults, or with acquireTimeoutMs above scopeTimeoutMs plus busyTimeoutMs", () => {
    expect(warningsFor({})).toEqual([]);
    expect(warningsFor({ busyTimeoutMs: 1000, acquireTimeoutMs: 6001, scopeTimeoutMs: 5000 })).toEqual([]);
    expect(warningsFor({ busyTimeoutMs: 20000 })).toEqual([]);
  });
});
