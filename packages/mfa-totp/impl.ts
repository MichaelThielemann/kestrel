import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Identity } from "@michaelthielemann/kestrel-contracts/authn";
import type { Authz, AuthzError } from "@michaelthielemann/kestrel-contracts/authz";
import { customFailure, err, failure, isErr, ok, type KestrelError, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import type { Document, Persistence, PersistenceError } from "@michaelthielemann/kestrel-contracts/persistence";

export const FACTORS = "mfa_factors";

/** Who must have a second factor before signing in: everyone, nobody, or the accounts holding one of the permissions. */
export type Enforce = "all" | "none" | { permissions: string[] };

export interface Config {
  issuer: string;
  secretKey: string;
  /** Keys `secretKey` replaced; a secret or code stored under one of them still works, and a secret is sealed again under `secretKey` once its code passes. */
  previousSecretKeys?: string[] | undefined;
  enforce: Enforce;
  recoveryCodes: number;
  /** Wrong codes in a row after which the factor is locked. */
  maxFailures: number;
  /** How long the first lock lasts; each further one lasts twice as long, at most a day. */
  lockSeconds: number;
  /** Whether an account that never had a factor also needs an enrollment code, issued by a reset; it applies once some account has a confirmed factor. */
  requireEnrollmentCode: boolean;
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
  enrollment: string | null;
}

/** The answer of a check: pass (with the recovery codes when the check confirmed a new factor), or why not. */
export type Check = { kind: "pass"; recoveryCodes?: string[] } | { kind: "refuse"; reason: "required" | "setup-required" | "wrong" } | { kind: "refuse"; reason: "locked"; retryAfterSeconds: number };

export interface Setup {
  secret: string;
  uri: string;
}

export type MfaError = KestrelError<"CONFLICT" | "NOT_FOUND" | "TRANSIENT" | "ENROLLMENT_CODE_REQUIRED"> | AuthzError;

/** The status `startSetup` answers when the account needs an enrollment code it did not give. */
export const ENROLLMENT_CODE_STATUS = 403;

export interface MfaTotp {
  /** Checks the second factor of a caller whose password was just accepted; `code` is a time-based or a recovery code. */
  check(identity: Identity, code: string | undefined): Promise<Result<Check, MfaError>>;
  /** Stores a new, unconfirmed secret for the caller; the next check with a code for it confirms it. After a reset, or with `requireEnrollmentCode`, it needs the enrollment code the reset issued. */
  startSetup(identity: Identity, enrollmentCode?: string): Promise<Result<Setup, MfaError>>;
  /** Removes the user's factor and answers a one-time code the user needs to set up a new one. */
  reset(userId: string): Promise<Result<{ enrollmentCode: string }, MfaError>>;
  /** Removes every trace of the user, e.g. once the account is deleted. */
  forget(userId: string): Promise<Result<void, MfaError>>;
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

function unseal(key: Buffer, sealed: string): Buffer | undefined {
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== "v1" || iv === undefined || tag === undefined || data === undefined) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]);
  } catch {
    return undefined;
  }
}

const RECOVERY_GROUPS = 5;
const MAX_LOCK_SECONDS = 86_400;
const MAX_RETRIES = 50;

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
  const keys = [key, ...(config.previousSecretKeys ?? []).map(keyOf)];
  const recoveryKeyOf = (k: Buffer): Buffer => createHmac("sha256", k).update("mfa-totp recovery codes").digest();
  const recoveryKey = recoveryKeyOf(key);
  const recoveryKeys = keys.map(recoveryKeyOf);
  const normalized = (code: string): string => code.replace(/[\s-]/g, "").toUpperCase();
  const enrollmentDigests = (code: string): string[] => recoveryKeys.map((k) => createHmac("sha256", k).update(`enrollment:${normalized(code)}`).digest("base64url"));
  const recoveryDigests = (code: string): string[] => recoveryKeys.map((k) => createHmac("sha256", k).update(normalized(code)).digest("base64url"));
  const recoveryDigest = (code: string): string => createHmac("sha256", recoveryKey).update(normalized(code)).digest("base64url");
  const enrollmentDigest = (code: string): string => createHmac("sha256", recoveryKey).update(`enrollment:${normalized(code)}`).digest("base64url");
  const ready = await db.ensureCollection(FACTORS, { userId: { type: "string", unique: true }, secret: "string", confirmed: "boolean", lastStep: "number", recovery: "json", createdAt: "number", failures: "number", locks: "number", lockedUntil: "number", rev: "number", enrollment: "string" });
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

  const opened = (row: FactorRow): { secret: Buffer; current: boolean } | undefined => {
    for (const [index, k] of keys.entries()) {
      const secret = unseal(k, row.secret);
      if (secret !== undefined) return { secret, current: index === 0 };
    }
    return undefined;
  };

  const matchingStep = (secret: Buffer, lastStep: number, code: string): number | undefined => {
    if (!/^\d{6}$/.test(code)) return undefined;
    const current = Math.floor(now() / 1000 / STEP_SECONDS);
    for (let offset = -WINDOW; offset <= WINDOW; offset++) {
      const step = current + offset;
      if (step > lastStep && sameText(totp(secret, step), code)) return step;
    }
    return undefined;
  };

  const change = async (row: FactorRow, patch: Partial<Omit<FactorRow, "id">>): Promise<Result<FactorRow | undefined, PersistenceError>> => {
    const rev = row.rev ?? 0;
    const changed = await db.updateMany<FactorRow>(FACTORS, { id: row.id, rev }, { ...patch, rev: rev + 1 });
    if (isErr(changed)) return changed;
    return ok(changed.value === 1 ? { ...row, ...patch, rev: rev + 1 } : undefined);
  };

  const busy = (): Result<never, MfaError> => err(failure("TRANSIENT", "mfa/totp: the factor kept changing while it was checked"));

  const update = async (first: FactorRow, plan: (row: FactorRow) => Partial<Omit<FactorRow, "id">> | undefined): Promise<Result<FactorRow | undefined, MfaError>> => {
    let row: FactorRow | null = first;
    for (let attempt = 0; attempt < MAX_RETRIES && row !== null; attempt++) {
      const patch = plan(row);
      if (patch === undefined) return ok(undefined);
      const changed = await change(row, patch);
      if (isErr(changed)) return changed;
      if (changed.value !== undefined) return ok(changed.value);
      const fresh = await factorOf(first.userId);
      if (isErr(fresh)) return fresh;
      row = fresh.value;
    }
    return row === null ? ok(undefined) : busy();
  };

  const lockedFor = (row: FactorRow): number => Math.ceil(((row.lockedUntil ?? 0) - now()) / 1000);

  const countAttempt = (row: FactorRow): Promise<Result<FactorRow | undefined, MfaError>> =>
    update(row, (current) => {
      if (current.secret === "" || (current.lockedUntil ?? 0) > now()) return undefined;
      const failures = (current.failures ?? 0) + 1;
      const locking = failures >= config.maxFailures;
      const locks = (current.locks ?? 0) + (locking ? 1 : 0);
      const lockedUntil = locking ? now() + Math.min(config.lockSeconds * 2 ** (locks - 1), MAX_LOCK_SECONDS) * 1000 : (current.lockedUntil ?? 0);
      return { failures: locking ? 0 : failures, locks, lockedUntil };
    });

  const settle = async (row: FactorRow, plan: (row: FactorRow) => Partial<Omit<FactorRow, "id">> | undefined, answer: Check): Promise<Result<Check, MfaError>> => {
    const settled = await update(row, (current) => {
      const patch = plan(current);
      return patch === undefined ? undefined : { ...patch, failures: 0, locks: 0, lockedUntil: 0 };
    });
    if (isErr(settled)) return settled;
    return ok(settled.value !== undefined ? answer : { kind: "refuse", reason: "wrong" });
  };

  const WRONG: Check = { kind: "refuse", reason: "wrong" };

  return {
    async check(identity, code) {
      const found = await factorOf(identity.id);
      if (isErr(found)) return found;
      const row = found.value !== null && found.value.secret !== "" ? found.value : null;
      const given = code?.trim() ?? "";

      if (row !== null && given !== "") {
        const counted = await countAttempt(row);
        if (isErr(counted)) return counted;
        const attempt = counted.value;
        if (attempt === undefined) {
          const fresh = await factorOf(identity.id);
          if (isErr(fresh)) return fresh;
          const lockedRow = fresh.value;
          return ok(lockedRow !== null && (lockedRow.lockedUntil ?? 0) > now() ? { kind: "refuse", reason: "locked", retryAfterSeconds: lockedFor(lockedRow) } : WRONG);
        }
        const secret = opened(attempt);
        const step = secret === undefined ? undefined : matchingStep(secret.secret, attempt.lastStep, given);
        const resealed = secret !== undefined && !secret.current ? { secret: seal(key, secret.secret) } : {};
        const sameSecret = (current: FactorRow): boolean => current.secret === attempt.secret;

        if (attempt.confirmed) {
          if (step !== undefined) return settle(attempt, (current) => (sameSecret(current) && step > current.lastStep ? { lastStep: step, ...resealed } : undefined), { kind: "pass" });
          const digests = new Set(recoveryDigests(given));
          if (!attempt.recovery.some((stored) => digests.has(stored))) return ok(WRONG);
          return settle(
            attempt,
            (current) => {
              const kept = current.recovery.filter((stored) => !digests.has(stored));
              return kept.length < current.recovery.length ? { recovery: kept } : undefined;
            },
            { kind: "pass" },
          );
        }

        if (step === undefined) return ok(WRONG);
        const recoveryCodes = Array.from({ length: config.recoveryCodes }, recoveryCode);
        return settle(
          attempt,
          (current) => (!current.confirmed && sameSecret(current) && step > current.lastStep ? { confirmed: true, lastStep: step, recovery: recoveryCodes.map(recoveryDigest), enrollment: null, ...resealed } : undefined),
          { kind: "pass", recoveryCodes },
        );
      }

      if (row !== null && row.confirmed) return ok({ kind: "refuse", reason: "required" });
      const needed = await required(identity);
      if (isErr(needed)) return needed;
      return ok(needed.value ? { kind: "refuse", reason: "setup-required" } : { kind: "pass" });
    },

    async startSetup(identity, enrollmentCode) {
      const found = await factorOf(identity.id);
      if (isErr(found)) return found;
      const row = found.value;
      if (row?.confirmed === true) return err(failure("CONFLICT", "mfa/totp: this account already has a second factor; an administrator can reset it"));
      const expected = row?.enrollment ?? null;
      let codeNeeded = expected !== null;
      if (!codeNeeded && row === null && config.requireEnrollmentCode) {
        const anyFactor = await db.findOne<FactorRow>(FACTORS, { confirmed: true });
        if (isErr(anyFactor)) return anyFactor;
        codeNeeded = anyFactor.value !== null;
      }
      if (codeNeeded) {
        const given = enrollmentCode === undefined || enrollmentCode.trim() === "" ? [] : enrollmentDigests(enrollmentCode);
        if (expected === null || !given.some((digest) => sameText(digest, expected))) {
          return err(customFailure("ENROLLMENT_CODE_REQUIRED", ENROLLMENT_CODE_STATUS, "mfa/totp: setting up this account's second factor needs the enrollment code an administrator issued"));
        }
      }
      const secret = randomBytes(20);
      const sealed = seal(key, secret);
      const stored = row === null
        ? await db.createOne<FactorRow>(FACTORS, { userId: identity.id, secret: sealed, confirmed: false, lastStep: 0, recovery: [], createdAt: now(), failures: 0, locks: 0, lockedUntil: 0, rev: 0, enrollment: null })
        : await db.updateOne<FactorRow>(FACTORS, row.id, { secret: sealed, lastStep: 0, recovery: [], rev: (row.rev ?? 0) + 1 });
      if (isErr(stored)) return stored;
      const encoded = base32Encode(secret);
      const issuer = encodeURIComponent(config.issuer);
      return ok({ secret: encoded, uri: `otpauth://totp/${issuer}:${encodeURIComponent(labelOf(identity))}?secret=${encoded}&issuer=${issuer}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}` });
    },

    async reset(userId) {
      const removed = await db.deleteMany(FACTORS, { userId });
      if (isErr(removed)) return removed;
      const enrollmentCode = recoveryCode();
      const created = await db.createOne<FactorRow>(FACTORS, { userId, secret: "", confirmed: false, lastStep: 0, recovery: [], createdAt: now(), failures: 0, locks: 0, lockedUntil: 0, rev: 0, enrollment: enrollmentDigest(enrollmentCode) });
      if (isErr(created)) return created;
      return ok({ enrollmentCode });
    },

    async forget(userId) {
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
