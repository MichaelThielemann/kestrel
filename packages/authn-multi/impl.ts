import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { Authn, AuthnError, Identity } from "@michaelthielemann/kestrel-contracts/authn";
import { err, failure, isErr, ok, type KestrelError, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import type { Document, Persistence } from "@michaelthielemann/kestrel-contracts/persistence";

export const USERS = "authn_users";
export const SESSIONS = "authn_sessions";

export interface Config {
  identifier: "username" | "email";
  minPasswordLength: number;
  sessionTtlSeconds: number;
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

export type AuthnMultiError = KestrelError<"VALIDATION" | "CONFLICT" | "NOT_FOUND" | "TRANSIENT">;

const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, KEY_LENGTH).toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algorithm, saltHex, hashHex] = stored.split("$");
  if (algorithm !== "scrypt" || !saltHex || !hashHex) throw new Error('authn/multi: passwordHash must look like "scrypt$<salt>$<hash>" (use hashPassword())');
  const expected = Buffer.from(hashHex, "hex");
  return timingSafeEqual(scryptSync(password, Buffer.from(saltHex, "hex"), expected.length), expected);
}

const BEARER = /^bearer /i;

export function tokenFromHeaders(headers: Record<string, string>): string | undefined {
  const auth = headers.authorization;
  if (auth && BEARER.test(auth)) return auth.slice(7).trim();
  for (const pair of (headers.cookie ?? "").split(";")) {
    const [k, v] = pair.trim().split("=");
    if (k === "kestrel_token" && v) return decodeURIComponent(v);
  }
  return undefined;
}

export interface AuthnMulti extends Authn {
  createUser(input: { username: string; password: string; roles?: string[] }): Promise<Result<PublicUser, AuthnMultiError>>;
  listUsers(): Promise<Result<PublicUser[], AuthnMultiError>>;
  getUser(id: string): Promise<Result<PublicUser | null, AuthnMultiError>>;
  setPassword(id: string, password: string): Promise<Result<void, AuthnMultiError>>;
  changePassword(id: string, current: string, next: string, keepToken?: string): Promise<Result<void, AuthnMultiError>>;
  setActive(id: string, active: boolean): Promise<Result<void, AuthnMultiError>>;
  cleanupSessions(): Promise<Result<number, AuthnMultiError>>;
}

function publicUser(user: User): PublicUser {
  return { id: user.id, username: user.username, roles: user.roles, active: user.active, createdAt: user.createdAt };
}

/** findOne/deleteOne calls in login/resolve/logout can only ever answer TRANSIENT; a CONFLICT or NOT_FOUND there is a persistence bug, not an authn@1 failure. */
function transientOnly(error: KestrelError<"CONFLICT" | "NOT_FOUND" | "TRANSIENT">): AuthnError {
  if (error.code !== "TRANSIENT") throw new Error(`authn/multi: unexpected persistence error ${error.code}: ${error.message}`);
  return error as AuthnError;
}

function checkPassword(config: Config, password: string): Result<void, KestrelError<"VALIDATION">> {
  return password.length < config.minPasswordLength ? err(failure("VALIDATION", `authn/multi: password must have at least ${config.minPasswordLength} characters`)) : ok();
}

export async function createAuthnMulti(config: Config, db: Persistence, now: () => number = Date.now): Promise<AuthnMulti> {
  const usersReady = await db.ensureCollection(USERS, { username: { type: "string", unique: true }, passwordHash: "string", roles: "json", active: "boolean", createdAt: "number" });
  if (isErr(usersReady)) throw new Error(`authn/multi: setup failed: ${usersReady.error.message}`);
  const sessionsReady = await db.ensureCollection(SESSIONS, { userId: "string", expiresAt: "number" });
  if (isErr(sessionsReady)) throw new Error(`authn/multi: setup failed: ${sessionsReady.error.message}`);

  const identity = (user: User): Identity => ({ id: user.id, claims: { username: user.username, roles: user.roles } });
  const userById = async (id: string): Promise<Result<User, AuthnMultiError>> => {
    const found = await db.findOne<User>(USERS, { id });
    if (isErr(found)) return found;
    if (!found.value) return err(failure("NOT_FOUND", `authn/multi: user ${id} does not exist`));
    return ok(found.value);
  };

  const createUser: AuthnMulti["createUser"] = async ({ username, password, roles = [] }) => {
    if (username.trim() === "") return err(failure("VALIDATION", "authn/multi: username must not be empty"));
    const passwordCheck = checkPassword(config, password);
    if (isErr(passwordCheck)) return passwordCheck;
    const existing = await db.findOne<User>(USERS, { username });
    if (isErr(existing)) return existing;
    if (existing.value) return err(failure("CONFLICT", `authn/multi: user "${username}" already exists`));
    const created = await db.createOne<User>(USERS, { username, passwordHash: hashPassword(password), roles, active: true, createdAt: now() });
    if (isErr(created)) return created.error.code === "CONFLICT" && created.error.details?.field === "username" ? err(failure("CONFLICT", `authn/multi: user "${username}" already exists`)) : created;
    return ok(publicUser(created.value));
  };

  if (config.bootstrap) {
    const userCount = await db.count(USERS, {});
    if (isErr(userCount)) throw new Error(`authn/multi: setup failed: ${userCount.error.message}`);
    if (userCount.value === 0) {
      verifyPassword("", config.bootstrap.passwordHash);
      const created = await db.createOne<User>(USERS, { username: config.bootstrap.username, passwordHash: config.bootstrap.passwordHash, roles: config.bootstrap.roles, active: true, createdAt: now() });
      if (isErr(created)) throw new Error(`authn/multi: setup failed: ${created.error.message}`);
    }
  }

  return {
    async login(credentials) {
      const username = credentials[config.identifier];
      const password = credentials.password;
      if (typeof username !== "string" || typeof password !== "string") return ok(null);
      const userResult = await db.findOne<User>(USERS, { username });
      if (isErr(userResult)) return err(transientOnly(userResult.error));
      const user = userResult.value;
      if (!user || !user.active || !verifyPassword(password, user.passwordHash)) return ok(null);
      const token = randomUUID();
      const created = await db.createOne<SessionRow>(SESSIONS, { id: token, userId: user.id, expiresAt: now() + config.sessionTtlSeconds * 1000 });
      if (isErr(created)) return err(transientOnly(created.error));
      return ok({ token, identity: identity(user) });
    },
    async resolve(token) {
      const sessionResult = await db.findOne<SessionRow>(SESSIONS, { id: token });
      if (isErr(sessionResult)) return err(transientOnly(sessionResult.error));
      const session = sessionResult.value;
      if (!session) return ok(null);
      if (session.expiresAt <= now()) {
        const deleted = await db.deleteOne(SESSIONS, token);
        if (isErr(deleted)) return err(transientOnly(deleted.error));
        return ok(null);
      }
      const userResult = await db.findOne<User>(USERS, { id: session.userId });
      if (isErr(userResult)) return err(transientOnly(userResult.error));
      const user = userResult.value;
      return ok(user && user.active ? identity(user) : null);
    },
    async logout(token) {
      const deleted = await db.deleteOne(SESSIONS, token);
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
    async setPassword(id, password) {
      const user = await userById(id);
      if (isErr(user)) return user;
      const passwordCheck = checkPassword(config, password);
      if (isErr(passwordCheck)) return passwordCheck;
      const updated = await db.updateOne<User>(USERS, id, { passwordHash: hashPassword(password) });
      if (isErr(updated)) return updated;
      const cleared = await db.deleteMany(SESSIONS, { userId: id });
      if (isErr(cleared)) return cleared;
      return ok();
    },
    async changePassword(id, current, next, keepToken) {
      const user = await userById(id);
      if (isErr(user)) return user;
      if (!verifyPassword(current, user.value.passwordHash)) return err(failure("VALIDATION", "authn/multi: current password is wrong"));
      const passwordCheck = checkPassword(config, next);
      if (isErr(passwordCheck)) return passwordCheck;
      const updated = await db.updateOne<User>(USERS, id, { passwordHash: hashPassword(next) });
      if (isErr(updated)) return updated;
      const cleared = await db.deleteMany(SESSIONS, keepToken === undefined ? { userId: id } : { userId: id, id: { ne: keepToken } });
      if (isErr(cleared)) return cleared;
      return ok();
    },
    async setActive(id, active) {
      const user = await userById(id);
      if (isErr(user)) return user;
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
