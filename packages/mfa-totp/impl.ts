import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Identity } from "@michaelthielemann/kestrel-contracts/authn";
import type { Authz, AuthzError } from "@michaelthielemann/kestrel-contracts/authz";
import { err, failure, isErr, ok, type KestrelError, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import type { Document, Persistence, PersistenceError } from "@michaelthielemann/kestrel-contracts/persistence";

export const FACTORS = "mfa_factors";

/** Who must have a second factor before signing in: everyone, nobody, or the accounts holding one of the permissions. */
export type Enforce = "all" | "none" | { permissions: string[] };

export interface Config {
  issuer: string;
  secretKey: string;
  enforce: Enforce;
  recoveryCodes: number;
  /** Wrong codes in a row after which the factor is locked. */
  maxFailures: number;
  /** How long the first lock lasts; each further one lasts twice as long, at most a day. */
  lockSeconds: number;
}

interface FactorRow extends Document {
  userId: string;
  secret: string;
  confirmed: boolean;
  lastStep: number;
  recovery: string[];
  createdAt: number;
  failures: number;
  locks: number;
  lockedUntil: number;
  rev: number;
}

/** The answer of a check: pass (with the recovery codes when the check confirmed a new factor), or why not. */
export type Check = { kind: "pass"; recoveryCodes?: string[] } | { kind: "refuse"; reason: "required" | "setup-required" | "wrong" } | { kind: "refuse"; reason: "locked"; retryAfterSeconds: number };

export interface Setup {
  secret: string;
  uri: string;
}

export type MfaError = KestrelError<"CONFLICT" | "NOT_FOUND" | "TRANSIENT"> | AuthzError;

export interface MfaTotp {
  /** Checks the second factor of a caller whose password was just accepted; `code` is a time-based or a recovery code. */
  check(identity: Identity, code: string | undefined): Promise<Result<Check, MfaError>>;
  /** Stores a new, unconfirmed secret for the caller; the next check with a code for it confirms it. */
  startSetup(identity: Identity): Promise<Result<Setup, MfaError>>;
  /** Removes the user's factor, confirmed or not. */
  reset(userId: string): Promise<Result<void, MfaError>>;
  /** The ids of the users with a confirmed factor. */
  usersWithFactor(): Promise<Result<ReadonlySet<string>, MfaError>>;
}

const STEP_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/[\s=-]/g, "").toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error("mfa/totp: not a base32 string");
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The time-based one-time code (six digits from an HMAC over SHA1) of `secret` for the 30-second time step `step`. */
export function totp(secret: Uint8Array, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 15;
  const binary = (((mac[offset] ?? 0) & 127) << 24) | ((mac[offset + 1] ?? 0) << 16) | ((mac[offset + 2] ?? 0) << 8) | (mac[offset + 3] ?? 0);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

function keyOf(secretKey: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(secretKey) ? Buffer.from(secretKey, "hex") : /^[A-Za-z0-9_-]{43}=?$/.test(secretKey) ? Buffer.from(secretKey, "base64url") : undefined;
  if (key === undefined || key.length !== 32) throw new Error("mfa/totp: secretKey must be 32 bytes, as 64 hex digits or 43 base64url characters");
  return key;
}

function seal(key: Buffer, plain: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

function unseal(key: Buffer, sealed: string): Buffer {
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== "v1" || iv === undefined || tag === undefined || data === undefined) throw new Error("mfa/totp: a stored secret has an unknown format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]);
}

const RECOVERY_GROUPS = 5;
const MAX_LOCK_SECONDS = 86_400;

function recoveryCode(): string {
  const raw = Array.from({ length: RECOVERY_GROUPS * 5 }, () => BASE32[randomInt(32)]).join("");
  return (raw.match(/.{5}/g) ?? []).join("-");
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function labelOf(identity: Identity): string {
  const name = identity.claims.username ?? identity.claims.name;
  return typeof name === "string" && name !== "" ? name : identity.id;
}

export async function createMfaTotp(config: Config, db: Persistence, now: () => number = Date.now, authz?: Authz): Promise<MfaTotp> {
  const key = keyOf(config.secretKey);
  const recoveryKey = createHmac("sha256", key).update("mfa-totp recovery codes").digest();
  const recoveryDigest = (code: string): string => createHmac("sha256", recoveryKey).update(code.replace(/[\s-]/g, "").toUpperCase()).digest("base64url");
  const ready = await db.ensureCollection(FACTORS, { userId: { type: "string", unique: true }, secret: "string", confirmed: "boolean", lastStep: "number", recovery: "json", createdAt: "number", failures: "number", locks: "number", lockedUntil: "number", rev: "number" });
  if (isErr(ready)) throw new Error(`mfa/totp: setup failed: ${ready.error.message}`);

  const factorOf = (userId: string): Promise<Result<FactorRow | null, PersistenceError>> => db.findOne<FactorRow>(FACTORS, { userId });

  const required = async (identity: Identity): Promise<Result<boolean, AuthzError>> => {
    const rule = config.enforce;
    if (rule === "all") return ok(true);
    if (rule === "none") return ok(false);
    if (!authz) return ok(true);
    for (const permission of rule.permissions) {
      const allowed = await authz.can(identity, permission);
      if (isErr(allowed)) return allowed;
      if (allowed.value) return ok(true);
    }
    return ok(false);
  };

  const matchingStep = (row: FactorRow, code: string): number | undefined => {
    if (!/^\d{6}$/.test(code)) return undefined;
    const secret = unseal(key, row.secret);
    const current = Math.floor(now() / 1000 / STEP_SECONDS);
    for (let offset = -WINDOW; offset <= WINDOW; offset++) {
      const step = current + offset;
      if (step > row.lastStep && sameText(totp(secret, step), code)) return step;
    }
    return undefined;
  };

  const change = async (row: FactorRow, patch: Partial<Omit<FactorRow, "id">>): Promise<Result<boolean, PersistenceError>> => {
    const rev = row.rev ?? 0;
    const changed = await db.updateMany<FactorRow>(FACTORS, { id: row.id, rev }, { ...patch, rev: rev + 1 });
    if (isErr(changed)) return changed;
    return ok(changed.value === 1);
  };

  const wrongCode = async (row: FactorRow): Promise<Result<Check, MfaError>> => {
    const failures = (row.failures ?? 0) + 1;
    const locking = failures >= config.maxFailures;
    const locks = (row.locks ?? 0) + (locking ? 1 : 0);
    const lockedUntil = locking ? now() + Math.min(config.lockSeconds * 2 ** (locks - 1), MAX_LOCK_SECONDS) * 1000 : (row.lockedUntil ?? 0);
    const counted = await change(row, { failures: locking ? 0 : failures, locks, lockedUntil });
    if (isErr(counted)) return counted;
    return ok({ kind: "refuse", reason: "wrong" });
  };

  const passed = async (row: FactorRow, patch: Partial<Omit<FactorRow, "id">>, answer: Check): Promise<Result<Check, MfaError>> => {
    const changed = await change(row, { ...patch, failures: 0, locks: 0, lockedUntil: 0 });
    if (isErr(changed)) return changed;
    return ok(changed.value ? answer : { kind: "refuse", reason: "wrong" });
  };

  return {
    async check(identity, code) {
      const found = await factorOf(identity.id);
      if (isErr(found)) return found;
      const row = found.value;
      const given = code?.trim() ?? "";

      if (row !== null && given !== "" && (row.lockedUntil ?? 0) > now()) {
        return ok({ kind: "refuse", reason: "locked", retryAfterSeconds: Math.ceil(((row.lockedUntil ?? 0) - now()) / 1000) });
      }

      if (row !== null && row.confirmed) {
        if (given === "") return ok({ kind: "refuse", reason: "required" });
        const step = matchingStep(row, given);
        if (step !== undefined) return passed(row, { lastStep: step }, { kind: "pass" });
        const hashed = recoveryDigest(given);
        if (!row.recovery.some((stored) => sameText(stored, hashed))) return wrongCode(row);
        return passed(row, { recovery: row.recovery.filter((stored) => stored !== hashed) }, { kind: "pass" });
      }

      if (row !== null && given !== "") {
        const step = matchingStep(row, given);
        if (step === undefined) return wrongCode(row);
        const recoveryCodes = Array.from({ length: config.recoveryCodes }, recoveryCode);
        return passed(row, { confirmed: true, lastStep: step, recovery: recoveryCodes.map(recoveryDigest) }, { kind: "pass", recoveryCodes });
      }

      const needed = await required(identity);
      if (isErr(needed)) return needed;
      return ok(needed.value ? { kind: "refuse", reason: "setup-required" } : { kind: "pass" });
    },

    async startSetup(identity) {
      const found = await factorOf(identity.id);
      if (isErr(found)) return found;
      if (found.value?.confirmed === true) return err(failure("CONFLICT", "mfa/totp: this account already has a second factor; an administrator can reset it"));
      const secret = randomBytes(20);
      const sealed = seal(key, secret);
      const stored = found.value === null
        ? await db.createOne<FactorRow>(FACTORS, { userId: identity.id, secret: sealed, confirmed: false, lastStep: 0, recovery: [], createdAt: now(), failures: 0, locks: 0, lockedUntil: 0, rev: 0 })
        : await db.updateOne<FactorRow>(FACTORS, found.value.id, { secret: sealed, lastStep: 0, recovery: [], rev: (found.value.rev ?? 0) + 1 });
      if (isErr(stored)) return stored;
      const encoded = base32Encode(secret);
      const issuer = encodeURIComponent(config.issuer);
      return ok({ secret: encoded, uri: `otpauth://totp/${issuer}:${encodeURIComponent(labelOf(identity))}?secret=${encoded}&issuer=${issuer}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}` });
    },

    async reset(userId) {
      const removed = await db.deleteMany(FACTORS, { userId });
      if (isErr(removed)) return removed;
      return ok();
    },

    async usersWithFactor() {
      const rows = await db.findMany<FactorRow>(FACTORS, { confirmed: true });
      if (isErr(rows)) return rows;
      return ok(new Set(rows.value.items.map((row) => row.userId)));
    },
  };
}
