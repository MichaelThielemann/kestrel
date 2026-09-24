import { rmSync } from "node:fs";

const tracked = new Set<string>();
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type TrackedSignal = (typeof SIGNALS)[number];

let handlers: Map<TrackedSignal, () => void> | undefined;

function removeAllSync(): void {
  for (const dir of tracked) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      continue;
    }
  }
}

function uninstall(): void {
  if (handlers === undefined) return;
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  handlers = undefined;
}

function handle(signal: TrackedSignal): void {
  removeAllSync();
  uninstall();
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

function install(): void {
  if (handlers !== undefined) return;
  const map = new Map<TrackedSignal, () => void>();
  for (const signal of SIGNALS) {
    const handler = (): void => handle(signal);
    map.set(signal, handler);
    process.on(signal, handler);
  }
  handlers = map;
}

/** Tracks a temp directory so a SIGINT/SIGTERM/SIGHUP removes it before the process exits. Installs the signal handlers only while at least one directory is tracked. */
export function trackTempDir(dir: string): void {
  install();
  tracked.add(dir);
}

/** Stops tracking a temp directory once the caller has removed it itself, and removes the signal handlers once none are left, so a host process keeps sole control of its own signal handling between runs. */
export function untrackTempDir(dir: string): void {
  tracked.delete(dir);
  if (tracked.size === 0) uninstall();
}
