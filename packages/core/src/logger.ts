export interface StepLog {
  runId: string;
  parentRunId?: string;
  pipeline: string;
  step: string;
  ms: number;
  outcome: "ok" | `fail(${string})` | "error";
}

export interface Logger {
  step(entry: StepLog): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn?(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export function logWarn(logger: Logger, message: string, data?: Record<string, unknown>): void {
  if (logger.warn) logger.warn(message, data);
  else logger.info(message, data);
}

// ISO 8601 with the local UTC offset (not "Z"), since consoleLogger runs on one machine
// and log lines should read in local time without losing offset information.
export function localIso(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${offset}`;
}

export const consoleLogger: Logger = {
  step(entry) {
    console.log(JSON.stringify({ time: localIso(new Date()), level: "step", ...entry }));
  },
  info(message, data = {}) {
    console.log(JSON.stringify({ time: localIso(new Date()), level: "info", message, ...data }));
  },
  warn(message, data = {}) {
    console.warn(JSON.stringify({ time: localIso(new Date()), level: "warn", message, ...data }));
  },
  error(message, data = {}) {
    console.error(JSON.stringify({ time: localIso(new Date()), level: "error", message, ...data }));
  },
};

export const silentLogger: Logger = {
  step() {},
  info() {},
  warn() {},
  error() {},
};
