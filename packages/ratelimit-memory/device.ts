import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** The name of the device cookie when it is not marked `Secure` (plain-HTTP development only). */
export const DEVICE_COOKIE = "kestrel_device";

/** The name of the device cookie when it is `Secure`; the `__Host-` prefix keeps a sibling origin from planting one. */
export const SECURE_DEVICE_COOKIE = "__Host-kestrel_device";

/** How device cookies are signed and written. */
export interface DeviceCookieConfig {
  /** The signing key: 32 bytes as 64 hex digits or 43 base64url characters. */
  secretKey: string;
  /** Keys `secretKey` replaced; a cookie signed under one of them stays valid until it expires. */
  previousSecretKeys?: string[] | undefined;
  /** How long a device cookie stays valid after the sign-in that issued it. */
  maxAgeSeconds: number;
  /** Mark the cookie `Secure` and give it the `__Host-` name; off only for plain-HTTP development. */
  secure: boolean;
}

/** Issues and checks device cookies, each bound to one exact account name. */
export interface DeviceCookies {
  /** The cookie's name. */
  readonly name: string;
  /** The `set-cookie` value of a new device cookie for the account named exactly `account`. */
  issue(account: string): string;
  /** The device a request's cookie names when one of its device cookies is valid for the account named exactly `account`; `undefined` otherwise. */
  verify(headers: Record<string, string>, account: string): string | undefined;
}

const NONCE = /^[A-Za-z0-9_-]{22}$/;
const LABEL = "ratelimit-memory device cookie";

function keyOf(secretKey: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(secretKey) ? Buffer.from(secretKey, "hex") : /^[A-Za-z0-9_-]{43}=?$/.test(secretKey) ? Buffer.from(secretKey, "base64url") : undefined;
  if (key === undefined || key.length !== 32) throw new Error("ratelimit/memory: deviceCookies.secretKey must be 32 bytes, as 64 hex digits or 43 base64url characters");
  return createHmac("sha256", key).update(LABEL).digest();
}

function mac(key: Buffer, expires: string, nonce: string, account: string): Buffer {
  return createHmac("sha256", key).update(`${expires}.${nonce}.${account}`).digest();
}

function cookieValues(headers: Record<string, string>, name: string): string[] {
  return (headers.cookie ?? "").split(";").flatMap((pair) => {
    const eq = pair.indexOf("=");
    return eq !== -1 && pair.slice(0, eq).trim() === name ? [pair.slice(eq + 1).trim()] : [];
  });
}

/** A device's identifier that reveals nothing of its cookie. */
export function deviceId(device: string): string {
  return createHash("sha256").update(device).digest("base64url").slice(0, 16);
}

export function createDeviceCookies(config: DeviceCookieConfig, now: () => number = Date.now): DeviceCookies {
  const key = keyOf(config.secretKey);
  const keys = [key, ...(config.previousSecretKeys ?? []).map(keyOf)];
  const name = config.secure ? SECURE_DEVICE_COOKIE : DEVICE_COOKIE;
  const attributes = `Path=/; Max-Age=${config.maxAgeSeconds}; HttpOnly;${config.secure ? " Secure;" : ""} SameSite=Strict`;

  const valid = (value: string, account: string): string | undefined => {
    const [expires, nonce, signature, extra] = value.split(".");
    if (expires === undefined || nonce === undefined || signature === undefined || extra !== undefined) return undefined;
    if (!/^\d{1,12}$/.test(expires) || Number(expires) * 1000 <= now() || !NONCE.test(nonce)) return undefined;
    const given = Buffer.from(signature, "base64url");
    return keys.some((k) => {
      const expected = mac(k, expires, nonce, account);
      return given.length === expected.length && timingSafeEqual(given, expected);
    })
      ? nonce
      : undefined;
  };

  return {
    name,
    issue(account) {
      const expires = String(Math.floor(now() / 1000) + config.maxAgeSeconds);
      const nonce = randomBytes(16).toString("base64url");
      return `${name}=${expires}.${nonce}.${mac(key, expires, nonce, account).toString("base64url")}; ${attributes}`;
    },
    verify(headers, account) {
      for (const value of cookieValues(headers, name)) {
        const device = valid(value, account);
        if (device !== undefined) return device;
      }
      return undefined;
    },
  };
}
