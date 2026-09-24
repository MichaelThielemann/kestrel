import type { ObservedRead } from "@michaelthielemann/kestrel/reads";
import type { DependencyKind } from "./keys.ts";

/** One dependency of a rendered output, before it is stored as a row. */
export interface DependencySpec {
  kind: DependencyKind;
  depType: string;
  /** The document id for `document` and `path`; `null` for `type` and `query`. */
  depId: string | null;
  depLocale: string | null;
  filter: Record<string, unknown> | null;
  rules: Record<string, unknown> | null;
  /** The path answered for a `path` read; `null` also when the link was broken. */
  path: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = sorted(value[key]);
  return out;
}

/** JSON with object keys sorted at every depth, so two equal filters or rule sets compare equal as strings. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sorted(value));
}

function specOf(read: ObservedRead): DependencySpec {
  switch (read.kind) {
    case "document":
      return { kind: "document", depType: read.type, depId: read.id, depLocale: read.locale ?? null, filter: null, rules: null, path: null };
    case "type":
      return { kind: "type", depType: read.type, depId: null, depLocale: null, filter: null, rules: null, path: null };
    case "query":
      return { kind: "query", depType: read.type, depId: null, depLocale: read.locale ?? null, filter: read.filter, rules: null, path: null };
    case "path":
      return { kind: "path", depType: read.type, depId: read.id, depLocale: read.locale, filter: null, rules: read.rules, path: read.path };
  }
}

function dedupeKey(spec: DependencySpec): string {
  switch (spec.kind) {
    case "document":
      return `document\u0000${spec.depType}\u0000${spec.depId ?? ""}`;
    case "type":
      return `type\u0000${spec.depType}`;
    case "query":
      return `query\u0000${spec.depType}\u0000${spec.depLocale ?? ""}\u0000${canonicalJson(spec.filter)}`;
    case "path":
      return `path\u0000${spec.depType}\u0000${spec.depId ?? ""}\u0000${spec.depLocale ?? ""}\u0000${canonicalJson(spec.rules)}\u0000${spec.path ?? ""}`;
  }
}

function typeSpec(depType: string): DependencySpec {
  return { kind: "type", depType, depId: null, depLocale: null, filter: null, rules: null, path: null };
}

/**
 * The dependency set of one render: reads of the published document itself are dropped, duplicates removed, and a
 * `type` read replaces every other read of its type. Above `max` rows, the largest per-type groups are collapsed
 * into one `type` row each, largest first; `null` (unknown) when even that does not fit.
 */
export function normalizeReads(reads: readonly ObservedRead[], self: { type: string; docId: string }, max: number): DependencySpec[] | null {
  const specs: DependencySpec[] = [];
  const seen = new Set<string>();
  const whole = new Set<string>();
  for (const read of reads) {
    if ((read.kind === "document" || read.kind === "path") && read.type === self.type && read.id === self.docId) continue;
    const spec = specOf(read);
    const key = dedupeKey(spec);
    if (seen.has(key)) continue;
    seen.add(key);
    if (spec.kind === "type") whole.add(spec.depType);
    specs.push(spec);
  }
  let types = specs.filter((s) => s.kind === "type");
  let rest = specs.filter((s) => s.kind !== "type" && !whole.has(s.depType));
  while (types.length + rest.length > max) {
    const counts = new Map<string, number>();
    for (const s of rest) counts.set(s.depType, (counts.get(s.depType) ?? 0) + 1);
    let largest: string | undefined;
    for (const [depType, count] of counts) if (largest === undefined || count > (counts.get(largest) ?? 0)) largest = depType;
    if (largest === undefined) return null;
    const collapsed = largest;
    types = [...types, typeSpec(collapsed)];
    rest = rest.filter((s) => s.depType !== collapsed);
  }
  return [...types, ...rest];
}
