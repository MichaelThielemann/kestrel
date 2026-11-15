import type { Redactor } from "./redact.ts";

/** Where a command's lines go; every line passes the redactor first. */
export interface Output {
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

/** Writes lines to two streams through a redactor; `quiet` keeps `info` off stdout, for `--json`. */
export function createOutput(redactor: Redactor, stdout: (text: string) => void, stderr: (text: string) => void, quiet = false): Output {
  return {
    info: (line) => {
      if (!quiet) stdout(redactor.apply(line) + "\n");
    },
    warn: (line) => stderr(`warning: ${redactor.apply(line)}\n`),
    error: (line) => stderr(`error: ${redactor.apply(line)}\n`),
  };
}
