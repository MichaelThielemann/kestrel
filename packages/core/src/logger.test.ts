import { describe, it, expect, vi, afterEach } from "vitest";
import { consoleLogger, localIso } from "./logger.ts";

describe("localIso", () => {
  it("formats with milliseconds and the local UTC offset", () => {
    const date = new Date(2026, 7, 29, 21, 45, 12, 345); // month is 0-based: August
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMinutes);
    const pad = (n: number) => String(n).padStart(2, "0");
    const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
    expect(localIso(date)).toBe(`2026-08-29T21:45:12.345${offset}`);
  });
});

describe("consoleLogger", () => {
  const fixedDate = new Date(2026, 7, 29, 21, 45, 12, 345);

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("puts time as the first key on step/info/error lines", () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedDate);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    consoleLogger.step({ runId: "r1", pipeline: "p", step: "s", ms: 1, outcome: "ok" });
    consoleLogger.info("hello", { a: 1 });
    consoleLogger.error("oops", { b: 2 });

    const stepLine = JSON.parse(logSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
    const infoLine = JSON.parse(logSpy.mock.calls[1]![0] as string) as Record<string, unknown>;
    const errorLine = JSON.parse(errorSpy.mock.calls[0]![0] as string) as Record<string, unknown>;

    expect(Object.keys(stepLine)[0]).toBe("time");
    expect(Object.keys(infoLine)[0]).toBe("time");
    expect(Object.keys(errorLine)[0]).toBe("time");
    expect(stepLine.time).toBe(localIso(fixedDate));
    expect(infoLine).toMatchObject({ level: "info", message: "hello", a: 1 });
    expect(errorLine).toMatchObject({ level: "error", message: "oops", b: 2 });
  });

  it("logs a failure outcome as fail(<code>)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleLogger.step({ runId: "r1", pipeline: "p", step: "s", ms: 1, outcome: "fail(NOT_FOUND)" });
    expect(JSON.parse(logSpy.mock.calls[0]![0] as string)).toMatchObject({ level: "step", outcome: "fail(NOT_FOUND)" });
  });
});
