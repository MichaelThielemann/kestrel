import { boundaryCast } from "./cast.ts";
import type { JsonSchema } from "./defineModule.ts";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Stands in for a value that is withheld; the variable itself reports `value: null` with `redacted: true`. */
export const REDACTED = "[redacted]";

const MAX_STRING = 200;
const MAX_ITEMS = 20;
const MAX_KEYS = 20;
const MAX_DEPTH = 5;

const SECRET_WORDS = new Set(["password", "passwords", "passwd", "pwd", "passphrase", "secret", "secrets", "token", "tokens", "credential", "credentials", "authorization", "auth", "dsn", "salt", "signature"]);
const KEY_QUALIFIERS = new Set(["api", "access", "secret", "private", "signing", "encryption", "session", "auth", "master", "client", "service", "license"]);
const CREDENTIALS_IN_URL = /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]+:[^/\s@]+@/i;

function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase());
}

/**
 * The key-name net behind the schema marker. `key` alone never counts — `backup.key` and
 * `redirects.key` are object names — only together with a word that makes it a credential.
 */
export function isSecretName(key: string): boolean {
  const parts = words(key);
  if (parts.some((part) => SECRET_WORDS.has(part))) return true;
  if ((parts.includes("key") || parts.includes("keys")) && parts.some((part) => KEY_QUALIFIERS.has(part))) return true;
  return parts.includes("connection") && (parts.includes("string") || parts.includes("uri") || parts.includes("url"));
}

/** A number or a boolean carries no credential: `minPasswordLength` is a setting, not a secret. Takes a manifest type name or a `typeof`, which agree on both. */
export function canHoldSecret(type: string): boolean {
  return type !== "number" && type !== "integer" && type !== "boolean";
}

/** A URL that carries `user:password@` is a credential whatever its key is called. */
export function isSecretValue(value: unknown): boolean {
  return typeof value === "string" && CREDENTIALS_IN_URL.test(value);
}

export function isSecretSchema(schema: JsonSchema): boolean {
  return schema.writeOnly === true || schema.format === "password" || schema["x-secret"] === true;
}

function constructorName(value: object): string {
  const ctor: unknown = value.constructor;
  if (typeof ctor !== "function" || ctor.name.length === 0) return "object";
  return ctor.name;
}

function isPlainObject(value: object): boolean {
  const ctor: unknown = value.constructor;
  return ctor === undefined || ctor === Object;
}

function truncate(value: string): string {
  return value.length <= MAX_STRING ? value : `${value.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING} chars]`;
}

function snapshotArray(value: readonly unknown[], depth: number, seen: WeakSet<object>): JsonValue {
  const out: JsonValue[] = value.slice(0, MAX_ITEMS).map((item) => snapshot(item, depth + 1, seen));
  if (value.length > MAX_ITEMS) out.push(`…[+${value.length - MAX_ITEMS} items]`);
  return out;
}

function snapshotObject(value: Record<string, unknown>, depth: number, seen: WeakSet<object>): JsonValue {
  const out: Record<string, JsonValue> = {};
  const keys = Object.keys(value);
  for (const key of keys.slice(0, MAX_KEYS)) out[key] = isSecretName(key) && canHoldSecret(typeof value[key]) ? REDACTED : snapshot(value[key], depth + 1, seen);
  if (keys.length > MAX_KEYS) out["…"] = `[+${keys.length - MAX_KEYS} keys]`;
  return out;
}

function snapshot(value: unknown, depth: number, seen: WeakSet<object>): JsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case "undefined":
      return null;
    case "string":
      return isSecretValue(value) ? REDACTED : truncate(value);
    case "number":
      return Number.isFinite(value) ? value : `[number ${String(value)}]`;
    case "boolean":
      return value;
    case "bigint":
      return `[bigint ${value.toString()}]`;
    case "function":
      return "[function]";
    case "symbol":
      return "[symbol]";
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof RegExp) return `[RegExp ${value.source}]`;
  if (ArrayBuffer.isView(value)) return `[${constructorName(value)} ${value.byteLength} bytes]`;
  if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`;
  if (value instanceof Map) return `[Map ${value.size} entries]`;
  if (value instanceof Set) return `[Set ${value.size} items]`;
  const array = Array.isArray(value);
  if (!array && !isPlainObject(value)) return `[${constructorName(value)}]`;
  if (depth > MAX_DEPTH) return array ? "[array]" : "[object]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const out = array ? snapshotArray(boundaryCast<readonly unknown[]>(value, "host"), depth, seen) : snapshotObject(boundaryCast<Record<string, unknown>>(value, "host"), depth, seen);
  seen.delete(value);
  return out;
}

/** A JSON-serialisable view of a configured value: type labels for what JSON cannot hold, truncation for what is too big, `REDACTED` for nested keys and URLs that look like credentials. */
export function snapshotValue(value: unknown): JsonValue {
  return snapshot(value, 0, new WeakSet<object>());
}
