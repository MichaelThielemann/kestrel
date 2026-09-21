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
