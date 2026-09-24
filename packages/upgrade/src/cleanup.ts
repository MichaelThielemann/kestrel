import { rmSync } from "node:fs";

const tracked = new Set<string>();
let installed = false;

function removeAllSync(): void {
  for (const dir of tracked) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      continue;
    }
  }
}

function install(): void {
  if (installed) return;
  installed = true;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      removeAllSync();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

/** Tracks a temp directory so a SIGINT/SIGTERM/SIGHUP removes it before the process exits. */
export function trackTempDir(dir: string): void {
  install();
  tracked.add(dir);
}

/** Stops tracking a temp directory once the caller has removed it itself. */
export function untrackTempDir(dir: string): void {
  tracked.delete(dir);
}
