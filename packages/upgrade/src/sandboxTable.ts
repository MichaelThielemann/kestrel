import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { isRecord } from "./guards.ts";

type SandboxRewrite = (config: unknown, scratch: string) => unknown;

const OFFICIAL_PREFIX = "@michaelthielemann/kestrel-";

function asRecord(config: unknown): Record<string, unknown> {
  return isRecord(config) ? { ...config } : {};
}

function scratchDatabase(config: unknown, scratch: string): string {
  const file: unknown = isRecord(config) ? config.file : undefined;
  if (typeof file !== "string") return join(scratch, "sandbox", "kestrel.db");
  if (file === "" || file === ":memory:") return file;
  const key = file.startsWith("file:") ? file : resolve(file);
  const name = basename(key.replace(/^file:/, "").split(/[?#]/)[0] ?? "") || "kestrel.db";
  return join(scratch, "sandbox", `db-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`, name);
}

export const BUILT_IN_SANDBOX_ENTRIES: Readonly<Record<string, SandboxRewrite>> = {
  [`${OFFICIAL_PREFIX}persistence-sqlite`]: (config, scratch) => ({ ...asRecord(config), file: scratchDatabase(config, scratch) }),
  [`${OFFICIAL_PREFIX}replication-sqlite`]: (config, scratch) => ({ ...asRecord(config), file: scratchDatabase(config, scratch), restoreOnStart: false }),
  [`${OFFICIAL_PREFIX}backup-blobstore`]: (config, scratch) => ({ ...asRecord(config), file: scratchDatabase(config, scratch), restoreOnStart: false }),
  [`${OFFICIAL_PREFIX}blobstore-filesystem`]: (config, scratch) => ({ ...asRecord(config), root: join(scratch, "sandbox", "blobs") }),
  [`${OFFICIAL_PREFIX}migrations-default`]: (config) => ({ ...asRecord(config), mode: "off" }),
  [`${OFFICIAL_PREFIX}validate-jsonschema`]: (config) => ({ ...asRecord(config), watch: false }),
};

export const KNOWN_SAFE_USES: ReadonlySet<string> = new Set(
  ["events-inmemory", "events-direct", "events-queue", "authn-single", "authn-multi", "authz-roles", "content-default", "delivery-static", "images-default", "insights", "links-default", "media-default", "mfa-totp", "ratelimit-memory", "redirects-default", "references-default", "renderer-plain", "revisions-default", "sanitize-svg", "site-default", "audit-persistence"].map((name) => `${OFFICIAL_PREFIX}${name}`),
);

export function sandboxKey(use: string): string {
  return use.split(/[?#]/)[0] ?? use;
}

export function collidingSandboxEntries(entries: Readonly<Record<string, SandboxRewrite>>): string[] {
  return Object.keys(entries).filter((key) => Object.hasOwn(BUILT_IN_SANDBOX_ENTRIES, sandboxKey(key)));
}
