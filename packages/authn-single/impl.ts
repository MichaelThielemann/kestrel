import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { Authn, AuthnError, Identity, Session } from "@michaelthielemann/kestrel-contracts/authn";
import { ok, type Result } from "@michaelthielemann/kestrel/result";

export interface Config {
  username: string;
  passwordHash: string;
  sessionTtlSeconds: number;
  roles: string[];
}

const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, KEY_LENGTH).toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algorithm, saltHex, hashHex] = stored.split("$");
  if (algorithm !== "scrypt" || !saltHex || !hashHex) throw new Error(`authn/single: passwordHash must look like "scrypt$<salt>$<hash>" (use hashPassword())`);
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

export const TOKEN_COOKIE = "kestrel_token";

const BEARER = /^bearer /i;

export function tokenFromHeaders(headers: Record<string, string>): string | undefined {
  const auth = headers.authorization;
  if (auth && BEARER.test(auth)) return auth.slice(7).trim();
  for (const pair of (headers.cookie ?? "").split(";")) {
    const [k, v] = pair.trim().split("=");
    if (k === TOKEN_COOKIE && v) return decodeURIComponent(v);
  }
  return undefined;
}

export function createAuthnSingle(config: Config, now: () => number = Date.now): Authn {
  verifyPassword("", config.passwordHash);
  const sessions = new Map<string, number>();
  const identity = (): Identity => ({ id: config.username, claims: { roles: [...config.roles] } });

  return {
    async login(credentials): Promise<Result<Session | null, AuthnError>> {
      const { username, password } = credentials;
      if (username !== config.username || typeof password !== "string" || !verifyPassword(password, config.passwordHash)) return ok(null);
      const token = randomUUID();
      sessions.set(token, now() + config.sessionTtlSeconds * 1000);
      return ok({ token, identity: identity() });
    },
    async resolve(token): Promise<Result<Identity | null, AuthnError>> {
      const expiresAt = sessions.get(token);
      if (expiresAt === undefined) return ok(null);
      if (expiresAt <= now()) {
        sessions.delete(token);
        return ok(null);
      }
      return ok(identity());
    },
    async logout(token): Promise<Result<void, AuthnError>> {
      sessions.delete(token);
      return ok();
    },
  };
}
