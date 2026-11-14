import { randomBytes } from "node:crypto";

/** The four kinds of backup, each with its own retention count. */
export const BACKUP_KINDS = ["cutover", "scheduled", "manual", "pre-restore"] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

/** `yyyymmddThhmmssZ` in UTC, the name format of replica generations and backup ids. */
export function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Epoch milliseconds of a `yyyymmddThhmmssZ` stamp, or NaN. */
export function unstamp(value: string): number {
  return Date.parse(value.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));
}

/** Random lowercase hex of `bytes` bytes. */
export function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

const ENV_NAME = /^[a-z0-9][a-z0-9_]*$/;

/** True for an environment name usable in a backup id: lowercase letters, digits and underscores. */
export function isEnvName(name: string): boolean {
  return ENV_NAME.test(name);
}

/** `<env>-<yyyymmddThhmmssZ>-<kind>-<4 hex>`. */
export function backupId(env: string, at: number, kind: BackupKind, suffix = hex(2)): string {
  return `${env}-${stamp(at)}-${kind}-${suffix}`;
}

/** The parts of a backup id, or null for anything else. */
export function parseBackupId(id: string): { env: string; at: number; kind: BackupKind } | null {
  const m = /^([a-z0-9_]+)-(\d{8}T\d{6}Z)-(cutover|scheduled|manual|pre-restore)-([0-9a-f]{4})$/.exec(id);
  if (!m) return null;
  const kind = BACKUP_KINDS.find((k) => k === m[3]);
  if (kind === undefined) return null;
  return { env: m[1] ?? "", at: unstamp(m[2] ?? ""), kind };
}

/**
 * Keys of the backup location. Every key is written once and never overwritten; state changes are new keys
 * (a verification result, a pin, a journal entry), so a store whose overwrites are only eventually consistent never
 * serves a stale version of any of them.
 */
export const keys = {
  backupDir: (id: string) => `backups/${id}/`,
  manifest: (id: string) => `backups/${id}/manifest.json`,
  db: (id: string) => `backups/${id}/db.sqlite`,
  blobs: (id: string) => `backups/${id}/blobs.jsonl`,
  site: (id: string) => `backups/${id}/site.jsonl`,
  derived: (id: string) => `backups/${id}/derived.jsonl`,
  verification: (id: string, at: number) => `backups/${id}/verify/${stamp(at)}-${hex(2)}.json`,
  pin: (id: string, runId: string) => `backups/${id}/pins/${runId}.json`,
  unpin: (id: string, runId: string) => `backups/${id}/pins/${runId}.released.json`,
  object: (sourceKey: string, etag: string) => `objects/${sourceKey}@${etag}`,
  journal: (runId: string, seq: number, step: string, state: string) => `runs/${runId}/${String(seq).padStart(6, "0")}-${step}-${state}.json`,
  lock: (runId: string, at: number, what: "start" | "beat" | "released") => `locks/${runId}/${stamp(at)}-${what}-${hex(2)}.json`,
  probe: (runId: string) => `probes/${runId}-${hex(4)}`,
};

/** One authoritative original as `blobs.jsonl` records it. `object` is the backup copy's key in the backup location. */
export interface BlobEntry {
  key: string;
  size: number;
  etag: string;
  sha256: string | null;
  object: string;
}

/** One key of the public output as `site.jsonl` records it. */
export interface SiteEntry {
  key: string;
  size: number;
  etag: string;
  object: string;
}

/** One key of a derived prefix as `derived.jsonl` records it; derived output is listed, not copied. */
export interface DerivedEntry {
  key: string;
  size: number;
  etag: string;
}

/** How a backup knows the source database was complete: `sealed` (teardown wrote a seal), `unsealed` (no seal, e.g. a kill), `unsupported` (the runtime writes no seal), `live` (taken while the app ran). */
export type SealState = "sealed" | "unsealed" | "unsupported" | "live";

/** `manifest.json`, written once after every other file of the backup. */
export interface Manifest {
  schema: "kestrel-ops/backup@1";
  id: string;
  env: string;
  kind: BackupKind;
  createdAt: number;
  frozen: boolean;
  tool: { name: string; version: string };
  source: { generation: string; lastFrameAt: number; seal: SealState; sealAt: number | null };
  versions: Record<string, string>;
  node: string;
  lockfileSha256: string | null;
  db: { bytes: number; sha256: string; integrity: string; rows: Record<string, number> };
  blobs: { count: number; bytes: number; missingAtBackup: string[] };
  site: { prefix: string; count: number; bytes: number; pathsSha256: string };
  derived: Record<string, { count: number; bytes: number }>;
  target: Record<string, unknown>;
}

/** Serializes entries as JSON lines. */
export function toJsonl(entries: readonly unknown[]): Uint8Array {
  return new TextEncoder().encode(entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : ""));
}

/** Parses JSON lines. */
export function fromJsonl(data: Uint8Array): unknown[] {
  return new TextDecoder()
    .decode(data)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line): unknown => JSON.parse(line));
}

/** Bytes of a JSON document. */
export function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n");
}

/** Parses the bytes of a JSON document. */
export function parseJson(data: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(data));
}
