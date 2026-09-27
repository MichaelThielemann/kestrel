import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import type { Authn, AuthnError, Identity } from "@michaelthielemann/kestrel-contracts/authn";
import type { Authz } from "@michaelthielemann/kestrel-contracts/authz";
import { customFailure, err, failure, isErr, ok, type KestrelError, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import type { Document, Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { requestToken, type SessionCookieOptions } from "@michaelthielemann/kestrel-contracts/helpers/session";

export const USERS = "authn_users";
export const SESSIONS = "authn_sessions";

export interface Config {
  identifier: "username" | "email";
  minPasswordLength: number;
  sessionTtlSeconds: number;
  secureCookie?: boolean | undefined;
  adminPermission: string;
  bootstrap?: { username: string; passwordHash: string; roles: string[] } | undefined;
}

export interface User extends Document {
  username: string;
  passwordHash: string;
  roles: string[];
  active: boolean;
  createdAt: number;
}

export interface PublicUser {
  id: string;
  username: string;
  roles: string[];
  active: boolean;
  createdAt: number;
}

interface SessionRow extends Document {
  userId: string;
  expiresAt: number;
}

export type AuthnMultiError = KestrelError<"VALIDATION" | "CONFLICT" | "NOT_FOUND" | "TRANSIENT" | "LAST_ADMIN">;

export const LAST_ADMIN_STATUS = 409;

const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, KEY_LENGTH).toString("hex")}`;
}

function parseHash(stored: string): { salt: Buffer; expected: Buffer } {
  const [algorithm, saltHex, hashHex] = stored.split("$");
  if (algorithm !== "scrypt" || !saltHex || !hashHex) throw new Error('authn/multi: passwordHash must look like "scrypt$<salt>$<hash>" (use hashPassword())');
  return { salt: Buffer.from(saltHex, "hex"), expected: Buffer.from(hashHex, "hex") };
}

function derive(password: string, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, length, (error, key) => (error ? reject(error) : resolve(key))));
}

export function verifyPassword(password: string, stored: string): boolean {
  const { salt, expected } = parseHash(stored);
  return timingSafeEqual(scryptSync(password, salt, expected.length), expected);
}

/** `verifyPassword` without blocking the event loop: the key is derived on the libuv thread pool. */
export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  const { salt, expected } = parseHash(stored);
  return timingSafeEqual(await derive(password, salt, expected.length), expected);
}

async function hashPasswordAsync(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${(await derive(password, salt, KEY_LENGTH)).toString("hex")}`;
}

const DUMMY_HASH = hashPassword(randomBytes(16).toString("hex"));

const TOKEN_DIGEST = /^[A-Za-z0-9_-]{43}$/;

function sessionId(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function tokenFromHeaders(headers: Record<string, string>): string | undefined {
  return requestToken(headers)?.token;
}

export interface UserPatch {
  username?: string;
  roles?: string[];
}

export interface AuthnMulti extends Authn {
  readonly sessionCookie: SessionCookieOptions;
  createUser(input: { username: string; password: string; roles?: string[] }): Promise<Result<PublicUser, AuthnMultiError>>;
  listUsers(): Promise<Result<PublicUser[], AuthnMultiError>>;
  getUser(id: string): Promise<Result<PublicUser | null, AuthnMultiError>>;
  updateUser(id: string, patch: UserPatch): Promise<Result<PublicUser, AuthnMultiError>>;
  deleteUser(id: string): Promise<Result<void, AuthnMultiError>>;
  setPassword(id: string, password: string): Promise<Result<void, AuthnMultiError>>;
  changePassword(id: string, current: string, next: string, keepToken?: string): Promise<Result<void, AuthnMultiError>>;
  setActive(id: string, active: boolean): Promise<Result<void, AuthnMultiError>>;
  cleanupSessions(): Promise<Result<number, AuthnMultiError>>;
}

function publicUser(user: User): PublicUser {
  return { id: user.id, username: user.username, roles: user.roles, active: user.active, createdAt: user.createdAt };
}

function isTransient(error: KestrelError<"CONFLICT" | "NOT_FOUND" | "TRANSIENT">): error is AuthnError {
  return error.code === "TRANSIENT";
}

function transientOnly(error: KestrelError<"CONFLICT" | "NOT_FOUND" | "TRANSIENT">): AuthnError {
  if (!isTransient(error)) throw new Error(`authn/multi: unexpected persistence error ${error.code}: ${error.message}`);
  return error;
}

function checkPassword(config: Config, password: string): Result<void, KestrelError<"VALIDATION">> {
  return password.length < config.minPasswordLength ? err(failure("VALIDATION", `authn/multi: password must have at least ${config.minPasswordLength} characters`)) : ok();
}

function checkRoles(roles: readonly string[]): Result<void, KestrelError<"VALIDATION">> {
  return roles.every((role) => role.trim() !== "") ? ok() : err(failure("VALIDATION", "authn/multi: a role must not be empty"));
}

function sameRoles(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((role, i) => role === b[i]);
}

export async function createAuthnMulti(config: Config, db: Persistence, now: () => number = Date.now, authz?: Authz): Promise<AuthnMulti> {
  const usersReady = await db.ensureCollection(USERS, { username: { type: "string", unique: true }, passwordHash: "string", roles: "json", active: "boolean", createdAt: "number" });
  if (isErr(usersReady)) throw new Error(`authn/multi: setup failed: ${usersReady.error.message}`);
  const sessionsReady = await db.ensureCollection(SESSIONS, { userId: "string", expiresAt: "number" });
  if (isErr(sessionsReady)) throw new Error(`authn/multi: setup failed: ${sessionsReady.error.message}`);
  const stored = await db.findMany<SessionRow>(SESSIONS, {});
  if (isErr(stored)) throw new Error(`authn/multi: setup failed: ${stored.error.message}`);
  const plain = stored.value.items.filter((row) => !TOKEN_DIGEST.test(row.id)).map((row) => row.id);
  if (plain.length > 0) {
    const dropped = await db.deleteMany(SESSIONS, { id: { in: plain } });
    if (isErr(dropped)) throw new Error(`authn/multi: setup failed: ${dropped.error.message}`);
  }

  const identity = (user: User): Identity => ({ id: user.id, claims: { username: user.username, roles: user.roles } });
  const userById = async (id: string): Promise<Result<User, AuthnMultiError>> => {
    const found = await db.findOne<User>(USERS, { id });
    if (isErr(found)) return found;
    if (!found.value) return err(failure("NOT_FOUND", `authn/multi: user ${id} does not exist`));
    return ok(found.value);
  };

  const isAdmin = async (user: User): Promise<Result<boolean, AuthnMultiError>> => {
    if (!authz || !user.active) return ok(false);
    const allowed = await authz.can(identity(user), config.adminPermission);
    if (isErr(allowed)) return allowed;
    return ok(allowed.value);
  };

  const guardLastAdmin = async (user: User, next: { roles: string[]; active: boolean }): Promise<Result<void, AuthnMultiError>> => {
    const was = await isAdmin(user);
    if (isErr(was)) return was;
    if (!was.value) return ok();
    const stays = await isAdmin({ ...user, ...next });
    if (isErr(stays)) return stays;
    if (stays.value) return ok();
    const active = await db.findMany<User>(USERS, { active: true });
    if (isErr(active)) return active;
    for (const other of active.value.items) {
      if (other.id === user.id) continue;
      const admin = await isAdmin(other);
      if (isErr(admin)) return admin;
      if (admin.value) return ok();
    }
    return err(customFailure("LAST_ADMIN", LAST_ADMIN_STATUS, `authn/multi: "${user.username}" is the last active user with "${config.adminPermission}"`));
  };

  const createUser: AuthnMulti["createUser"] = async ({ username, password, roles = [] }) => {
    if (username.trim() === "") return err(failure("VALIDATION", "authn/multi: username must not be empty"));
    const rolesCheck = checkRoles(roles);
    if (isErr(rolesCheck)) return rolesCheck;
    const passwordCheck = checkPassword(config, password);
    if (isErr(passwordCheck)) return passwordCheck;
    const existing = await db.findOne<User>(USERS, { username });
    if (isErr(existing)) return existing;
    if (existing.value) return err(failure("CONFLICT", `authn/multi: user "${username}" already exists`));
    const created = await db.createOne<User>(USERS, { username, passwordHash: await hashPasswordAsync(password), roles, active: true, createdAt: now() });
    if (isErr(created)) return created.error.code === "CONFLICT" && created.error.details?.field === "username" ? err(failure("CONFLICT", `authn/multi: user "${username}" already exists`)) : created;
    return ok(publicUser(created.value));
  };

  if (config.bootstrap) {
    const userCount = await db.count(USERS, {});
    if (isErr(userCount)) throw new Error(`authn/multi: setup failed: ${userCount.error.message}`);
    if (userCount.value === 0) {
      parseHash(config.bootstrap.passwordHash);
      const created = await db.createOne<User>(USERS, { username: config.bootstrap.username, passwordHash: config.bootstrap.passwordHash, roles: config.bootstrap.roles, active: true, createdAt: now() });
      if (isErr(created)) throw new Error(`authn/multi: setup failed: ${created.error.message}`);
    }
  }

  return {
    sessionCookie: { maxAgeSeconds: config.sessionTtlSeconds, secure: config.secureCookie ?? true },
    async login(credentials) {
      const username = credentials[config.identifier];
      const password = credentials.password;
      if (typeof username !== "string" || typeof password !== "string") return ok(null);
      const userResult = await db.findOne<User>(USERS, { username });
      if (isErr(userResult)) return err(transientOnly(userResult.error));
      const user = userResult.value;
      const usable = user !== null && user.active;
      const matches = await verifyPasswordAsync(password, usable ? user.passwordHash : DUMMY_HASH);
      if (!usable || !matches) return ok(null);
      const token = randomBytes(32).toString("base64url");
      const created = await db.createOne<SessionRow>(SESSIONS, { id: sessionId(token), userId: user.id, expiresAt: now() + config.sessionTtlSeconds * 1000 });
      if (isErr(created)) return err(transientOnly(created.error));
      return ok({ token, identity: identity(user) });
    },
    async resolve(token) {
      const id = sessionId(token);
      const sessionResult = await db.findOne<SessionRow>(SESSIONS, { id });
      if (isErr(sessionResult)) return err(transientOnly(sessionResult.error));
      const session = sessionResult.value;
      if (!session) return ok(null);
      if (session.expiresAt <= now()) {
        const deleted = await db.deleteOne(SESSIONS, id);
        if (isErr(deleted)) return err(transientOnly(deleted.error));
        return ok(null);
      }
      const userResult = await db.findOne<User>(USERS, { id: session.userId });
      if (isErr(userResult)) return err(transientOnly(userResult.error));
      const user = userResult.value;
      return ok(user && user.active ? identity(user) : null);
    },
    async logout(token) {
      const deleted = await db.deleteOne(SESSIONS, sessionId(token));
      if (isErr(deleted)) return err(transientOnly(deleted.error));
      return ok();
    },

    createUser,
    async listUsers() {
      const found = await db.findMany<User>(USERS, {}, { sort: { username: "asc" } });
      if (isErr(found)) return found;
      return ok(found.value.items.map(publicUser));
    },
    async getUser(id) {
      const found = await db.findOne<User>(USERS, { id });
      if (isErr(found)) return found;
      return ok(found.value ? publicUser(found.value) : null);
    },
    async updateUser(id, patch) {
      const found = await userById(id);
      if (isErr(found)) return found;
      const user = found.value;
      const username = patch.username !== undefined && patch.username !== user.username ? patch.username : undefined;
      const roles = patch.roles !== undefined && !sameRoles(patch.roles, user.roles) ? patch.roles : undefined;
      if (username !== undefined) {
        if (username.trim() === "") return err(failure("VALIDATION", "authn/multi: username must not be empty"));
        const taken = await db.findOne<User>(USERS, { username });
        if (isErr(taken)) return taken;
        if (taken.value) return err(failure("CONFLICT", `authn/multi: user "${username}" already exists`));
      }
      if (roles !== undefined) {
        const rolesCheck = checkRoles(roles);
        if (isErr(rolesCheck)) return rolesCheck;
        const guarded = await guardLastAdmin(user, { roles, active: user.active });
        if (isErr(guarded)) return guarded;
      }
      if (username === undefined && roles === undefined) return ok(publicUser(user));
      const updated = await db.updateOne<User>(USERS, id, { ...(username === undefined ? {} : { username }), ...(roles === undefined ? {} : { roles }) });
      if (isErr(updated)) return updated.error.code === "CONFLICT" && updated.error.details?.field === "username" ? err(failure("CONFLICT", `authn/multi: user "${username ?? user.username}" already exists`)) : updated;
      if (roles !== undefined) {
        const cleared = await db.deleteMany(SESSIONS, { userId: id });
        if (isErr(cleared)) return cleared;
      }
      return ok(publicUser(updated.value));
    },
    async deleteUser(id) {
      const found = await userById(id);
      if (isErr(found)) return found;
      const guarded = await guardLastAdmin(found.value, { roles: [], active: false });
      if (isErr(guarded)) return guarded;
      const cleared = await db.deleteMany(SESSIONS, { userId: id });
      if (isErr(cleared)) return cleared;
      const deleted = await db.deleteOne(USERS, id);
      if (isErr(deleted)) return deleted;
      return ok();
    },
    async setPassword(id, password) {
      const user = await userById(id);
      if (isErr(user)) return user;
      const passwordCheck = checkPassword(config, password);
      if (isErr(passwordCheck)) return passwordCheck;
      const updated = await db.updateOne<User>(USERS, id, { passwordHash: await hashPasswordAsync(password) });
      if (isErr(updated)) return updated;
      const cleared = await db.deleteMany(SESSIONS, { userId: id });
      if (isErr(cleared)) return cleared;
      return ok();
    },
    async changePassword(id, current, next, keepToken) {
      const user = await userById(id);
      if (isErr(user)) return user;
      if (!(await verifyPasswordAsync(current, user.value.passwordHash))) return err(failure("VALIDATION", "authn/multi: current password is wrong"));
      const passwordCheck = checkPassword(config, next);
      if (isErr(passwordCheck)) return passwordCheck;
      const updated = await db.updateOne<User>(USERS, id, { passwordHash: await hashPasswordAsync(next) });
      if (isErr(updated)) return updated;
      const cleared = await db.deleteMany(SESSIONS, keepToken === undefined ? { userId: id } : { userId: id, id: { ne: sessionId(keepToken) } });
      if (isErr(cleared)) return cleared;
      return ok();
    },
    async setActive(id, active) {
      const user = await userById(id);
      if (isErr(user)) return user;
      if (!active) {
        const guarded = await guardLastAdmin(user.value, { roles: user.value.roles, active });
        if (isErr(guarded)) return guarded;
      }
      const updated = await db.updateOne<User>(USERS, id, { active });
      if (isErr(updated)) return updated;
      if (!active) {
        const cleared = await db.deleteMany(SESSIONS, { userId: id });
        if (isErr(cleared)) return cleared;
      }
      return ok();
    },
    async cleanupSessions() {
      const removed = await db.deleteMany(SESSIONS, { expiresAt: { lte: now() } });
      if (isErr(removed)) return removed;
      return ok(removed.value);
    },
  };
}
