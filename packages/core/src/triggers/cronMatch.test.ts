import { describe, it, expect } from "vitest";
import { cronMatches, parseCron } from "./cronMatch.ts";

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi);

describe("cron", () => {
  it("* * * * * matches every minute", () => {
    expect(cronMatches(parseCron("* * * * *"), at(2026, 8, 27, 12, 34))).toBe(true);
  });

  it("0 3 * * * matches only 03:00", () => {
    const spec = parseCron("0 3 * * *");
    expect(cronMatches(spec, at(2026, 8, 27, 3, 0))).toBe(true);
    expect(cronMatches(spec, at(2026, 8, 27, 3, 1))).toBe(false);
    expect(cronMatches(spec, at(2026, 8, 27, 4, 0))).toBe(false);
  });

  it("supports steps, ranges and lists", () => {
    const spec = parseCron("*/15 9-17 1,15 * 1-5");
    expect(cronMatches(spec, at(2026, 9, 1, 9, 30))).toBe(true);
    expect(cronMatches(spec, at(2026, 9, 1, 9, 20))).toBe(false);
    expect(cronMatches(spec, at(2026, 9, 1, 18, 0))).toBe(false);
  });

  it("either day field matches when both are restricted", () => {
    const spec = parseCron("0 0 13 * 5");
    expect(cronMatches(spec, at(2026, 8, 13, 0, 0))).toBe(true);
    expect(cronMatches(spec, at(2026, 8, 14, 0, 0))).toBe(true);
    expect(cronMatches(spec, at(2026, 8, 15, 0, 0))).toBe(false);
  });

  it("treats 7 as Sunday", () => {
    expect(cronMatches(parseCron("0 0 * * 7"), at(2026, 8, 30, 0, 0))).toBe(true);
  });

  it("rejects invalid expressions", () => {
    expect(() => parseCron("* * * *")).toThrow(/5 fields/);
    expect(() => parseCron("60 * * * *")).toThrow(/outside 0-59/);
    expect(() => parseCron("* * * 13 *")).toThrow(/outside 1-12/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/invalid step/);
    expect(() => parseCron("5-1 * * * *")).toThrow();
  });
});
