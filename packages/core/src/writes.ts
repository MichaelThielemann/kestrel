/** A `reads`/`writes` path without its optional trailing "?". */
export function stripOptional(path: string): string {
  return path.endsWith("?") ? path.slice(0, -1) : path;
}

/** The context key at the root of a `reads`/`writes` path, stripping the optional trailing "?". */
export function writeRoot(path: string): string {
  const dot = path.indexOf(".");
  const root = dot === -1 ? path : path.slice(0, dot);
  return stripOptional(root);
}

/** The context keys `createContext` always sets, whatever the trigger; a step may read one of them, or a dotted child, with no earlier writer. */
export const CONTEXT_KEYS = ["payload", "headers", "files", "ip", "params", "body", "query", "requestId", "runId", "trigger"] as const;

export function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

export function satisfied(read: string, available: ReadonlySet<string>): boolean {
  for (const written of available) {
    if (overlaps(read, written)) return true;
  }
  return false;
}
