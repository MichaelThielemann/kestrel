import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { ModuleHealth } from "@michaelthielemann/kestrel/defineModule";
import { KestrelBootError } from "@michaelthielemann/kestrel/errors";
import { acquireInstanceLock, instanceLockFile, type InstanceLock } from "@michaelthielemann/kestrel/instanceLock";

/** One module's hold on the database file it names. */
export interface ProcessLock {
  /** Gives up the hold; calling it again does nothing. */
  release(): void;
  /** The state of the instance lock behind the hold, `{ ok: true }` when the module takes none. */
  health(): ModuleHealth;
}

interface Claim {
  module: string;
  allowConcurrentProcesses: boolean;
}

const CLAIMS_KEY = Symbol.for("kestrel.instanceLocks.claims");

const claims = sharedClaims();

function sharedClaims(): Map<string, Claim[]> {
  const existing: unknown = Reflect.get(globalThis, CLAIMS_KEY);
  if (existing instanceof Map) return boundaryCast<Map<string, Claim[]>>(existing, "host");
  const created = new Map<string, Claim[]>();
  Reflect.set(globalThis, CLAIMS_KEY, created);
  return created;
}

function setting(claim: Claim): string {
  return claim.allowConcurrentProcesses ? "allowConcurrentProcesses: true" : "without allowConcurrentProcesses";
}

const UNLOCKED: ProcessLock = { release() {}, health: () => ({ ok: true }) };

/**
 * Takes the instance lock on `file` for `module` unless `allowConcurrentProcesses` is set. Every
 * module in this process that names the same file has to agree on `allowConcurrentProcesses`; one
 * that does not throws a `KestrelBootError` with code `invalid-module-config` before it takes the
 * lock. A refused lock throws `instance-locked` (see `acquireInstanceLock`).
 */
export function lockDatabaseFile(file: string, module: string, allowConcurrentProcesses: boolean): ProcessLock {
  const lockPath = instanceLockFile(file);
  if (lockPath === undefined) return UNLOCKED;
  const claim: Claim = { module, allowConcurrentProcesses };
  const other = (claims.get(lockPath) ?? []).find((held) => held.allowConcurrentProcesses !== allowConcurrentProcesses);
  if (other !== undefined) {
    throw new KestrelBootError(module, `${module} is configured ${setting(claim)} for ${file}, but ${other.module} names the same database file ${setting(other)}; set allowConcurrentProcesses alike on every module that names the file`, "invalid-module-config");
  }
  const lock: InstanceLock | undefined = allowConcurrentProcesses ? undefined : acquireInstanceLock(file, { module });
  claims.set(lockPath, [...(claims.get(lockPath) ?? []), claim]);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      const rest = (claims.get(lockPath) ?? []).filter((held) => held !== claim);
      if (rest.length === 0) claims.delete(lockPath);
      else claims.set(lockPath, rest);
      lock?.release();
    },
    health: () => lock?.health() ?? { ok: true },
  };
}

/** The module's own health, overridden by a lost lock and carrying the lock's note. */
export function withLockHealth(lock: ProcessLock, own: ModuleHealth): ModuleHealth {
  const held = lock.health();
  if (!held.ok) return held;
  if (!own.ok || held.note === undefined) return own;
  return { ok: true, note: own.note === undefined ? held.note : `${own.note}; ${held.note}` };
}
