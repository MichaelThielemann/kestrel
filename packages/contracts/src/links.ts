export const INTERNAL_REF = /kestrel:([a-z][a-z0-9_]*):([A-Za-z0-9-]+)/g;

export interface InternalRef {
  type: string;
  id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collect(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    for (const m of value.matchAll(INTERNAL_REF)) out.add(`${m[1]}:${m[2]}`);
  } else if (Array.isArray(value)) {
    for (const v of value) collect(v, out);
  } else if (isRecord(value)) {
    if (value.type === "internal" && typeof value.collection === "string" && typeof value.id === "string") out.add(`${value.collection}:${value.id}`);
    for (const v of Object.values(value)) collect(v, out);
  }
}

/** Every `kestrel:<type>:<id>` string and `{ type: "internal", collection, id }` object anywhere in `value`, deduped. */
export function collectInternalRefs(value: unknown): InternalRef[] {
  const keys = new Set<string>();
  collect(value, keys);
  return [...keys].map((key) => {
    const at = key.indexOf(":");
    return { type: key.slice(0, at), id: key.slice(at + 1) };
  });
}

/** Where an internal reference points after a site resolved it: a public path, or nothing servable. */
export type LinkTarget = { path: string; locale: string } | { broken: true };
