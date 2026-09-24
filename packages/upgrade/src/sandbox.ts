import { join } from "node:path";
import type { BootInput } from "@michaelthielemann/kestrel";
import { isRecord } from "./guards.ts";
import { useToken } from "./useToken.ts";

export type SandboxTable = Record<string, (config: unknown, scratch: string) => unknown>;

export interface SandboxOptions {
  dir: string;
  consent?: readonly string[];
  entries?: SandboxTable;
}

export interface SandboxResult {
  input: BootInput;
  setup: { only: readonly string[] };
  outside: readonly string[];
}

function asRecord(config: unknown): Record<string, unknown> {
  return isRecord(config) ? { ...config } : {};
}

const KNOWN_SAFE_SUFFIXES = ["events-inmemory", "events-direct", "events-queue", "authn-single", "authn-multi", "authz-roles", "content-default", "delivery-static", "images-default", "insights", "links-default", "media-default", "ratelimit-memory", "redirects-default", "references-default", "renderer-plain", "revisions-default", "sanitize-svg", "site-default", "audit-persistence"];

const DEFAULT_SANDBOX_ENTRIES: SandboxTable = {
  "persistence-sqlite": (config, scratch) => ({ ...asRecord(config), file: join(scratch, "sandbox", "kestrel.db") }),
  "replication-sqlite": (config, scratch) => ({ ...asRecord(config), file: join(scratch, "sandbox", "kestrel.db"), restoreOnStart: false }),
  "backup-blobstore": (config, scratch) => ({ ...asRecord(config), file: join(scratch, "sandbox", "kestrel.db"), restoreOnStart: false }),
  "blobstore-filesystem": (config, scratch) => ({ ...asRecord(config), root: join(scratch, "sandbox", "blobs") }),
  "migrations-default": (config) => ({ ...asRecord(config), mode: "off" }),
  "validate-jsonschema": (config) => ({ ...asRecord(config), watch: false }),
};

/**
 * Rewrites the config of kestrel's own storage modules so their `setup()` reaches only the scratch
 * directory, and reports which other modules would need to run `setup()` outside the sandbox.
 * `setup.only` also carries every known-safe entry (one that reaches nothing but `persistence@1`
 * or `blobstore@1` and needs no rewrite) plus anything named in `consent`.
 */
export function sandboxBootInput(input: BootInput, options: SandboxOptions): SandboxResult {
  const table = { ...DEFAULT_SANDBOX_ENTRIES, ...(options.entries ?? {}) };
  const consent = new Set(options.consent ?? []);
  const only: string[] = [];
  const outside: string[] = [];
  const modules = input.config.modules.map((entry) => {
    const token = useToken(entry.use);
    const rewrite = table[token];
    if (rewrite) {
      only.push(entry.use);
      return { ...entry, config: rewrite(entry.config, options.dir) };
    }
    if (KNOWN_SAFE_SUFFIXES.includes(token) || consent.has(entry.use)) {
      only.push(entry.use);
      return entry;
    }
    outside.push(entry.use);
    return entry;
  });
  return { input: { ...input, config: { ...input.config, modules } }, setup: { only }, outside };
}
