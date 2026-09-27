import { createHash } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";

/** What a bucket counts by: the client address (an IPv6 address by its /64), the username a request names, or the signed-in identity. */
export type BucketKey = "ip" | "username" | "identity";

export interface Bucket {
  limit: number;
  windowSeconds: number;
  key?: BucketKey | undefined;
  /** The longest a key stays blocked once it exceeded the limit; each further exceeded window doubles the block up to this. Without it every block lasts one window. */
  maxBlockSeconds?: number | undefined;
  /** For a `username` bucket: the body field that names the account, the same one the login reads. */
  field?: "username" | "email" | undefined;
  /** `requests` counts every request the check lets through; `failures` counts only the runs that fail after it, and a successful run clears the key. */
  counts?: "requests" | "failures" | undefined;
}

export interface Config {
  buckets: Record<string, Bucket>;
}

export interface Decision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimit {
  hit(bucket: string, key: string): Decision;
  /** The decision for the next request without counting it. */
  peek(bucket: string, key: string): Decision;
  /** Counts one failed attempt; the key is blocked once it reaches the limit. */
  fail(bucket: string, key: string): void;
  /** Forgets the key, e.g. after a successful sign-in. */
  reset(bucket: string, key: string): void;
  sweep(): number;
  keyOf(bucket: string): BucketKey;
  bucketOf(bucket: string): Bucket;
}

interface KeyState {
  start: number;
  count: number;
  blockedUntil: number;
  strikes: number;
}

function expandIPv6(address: string): string[] | undefined {
  const [head = "", tail] = address.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 0) return undefined;
  return [...left, ...Array.from({ length: missing }, () => "0"), ...right].map((group) => group.toLowerCase().replace(/^0+(?=.)/, ""));
}

/** The key an `ip` bucket counts a client address by: an IPv4 address as is, an IPv4-mapped one as its IPv4 address, an IPv6 address by its /64 prefix, `"unknown"` without one. */
export function clientKey(ip: string | undefined): string {
  if (ip === undefined || ip === "") return "unknown";
  const bare = ip.replace(/%.*$/, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare)?.[1];
  if (mapped !== undefined && isIPv4(mapped)) return mapped;
  if (!isIPv6(bare)) return bare;
  const groups = expandIPv6(bare);
  return groups === undefined ? bare : `${groups.slice(0, 4).join(":")}::/64`;
}

/** The key a `username` bucket counts a request by: a digest of the named user, trimmed, lower-cased and NFKC-normalized, so spelling variants share one budget and a long name costs no more memory than a short one. */
export function usernameKey(name: string | undefined): string {
  const normalized = (name ?? "").normalize("NFKC").trim().toLowerCase();
  return normalized === "" ? "unknown" : createHash("sha256").update(normalized).digest("base64url");
}

export function createRateLimitMemory(config: Config, now: () => number = Date.now): RateLimit {
  const states = new Map<string, KeyState>();
  const bucketOf = (name: string): Bucket => {
    const bucket = config.buckets[name];
    if (!bucket) throw new Error(`ratelimit/memory: unknown bucket "${name}"`);
    return bucket;
  };
  const blockMs = (bucket: Bucket, strikes: number): number => {
    const windowMs = bucket.windowSeconds * 1000;
    if (bucket.maxBlockSeconds === undefined) return windowMs;
    return Math.min(windowMs * 2 ** (strikes - 1), bucket.maxBlockSeconds * 1000);
  };
  const quietMs = (bucket: Bucket): number => (bucket.maxBlockSeconds ?? bucket.windowSeconds) * 1000;

  return {
    hit(name, key) {
      const bucket = bucketOf(name);
      const windowMs = bucket.windowSeconds * 1000;
      const t = now();
      const id = `${name}:${key}`;
      let state = states.get(id);
      if (state && t < state.blockedUntil) {
        return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((state.blockedUntil - t) / 1000)) };
      }
      if (!state || t - state.start >= windowMs || state.blockedUntil > 0) {
        const strikes = state && state.blockedUntil > 0 && t - state.blockedUntil < quietMs(bucket) ? state.strikes : 0;
        state = { start: t, count: 0, blockedUntil: 0, strikes };
        states.set(id, state);
      }
      state.count += 1;
      if (state.count <= bucket.limit) {
        return { allowed: true, remaining: bucket.limit - state.count, retryAfterSeconds: Math.max(1, Math.ceil((state.start + windowMs - t) / 1000)) };
      }
      state.strikes += 1;
      state.blockedUntil = bucket.maxBlockSeconds === undefined ? state.start + windowMs : t + blockMs(bucket, state.strikes);
      return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((state.blockedUntil - t) / 1000)) };
    },
    peek(name, key) {
      const bucket = bucketOf(name);
      const t = now();
      const state = states.get(`${name}:${key}`);
      if (state && t < state.blockedUntil) return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((state.blockedUntil - t) / 1000)) };
      const windowMs = bucket.windowSeconds * 1000;
      const count = state && t - state.start < windowMs ? state.count : 0;
      if (count >= bucket.limit && state) return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((state.start + windowMs - t) / 1000)) };
      return { allowed: true, remaining: bucket.limit - count, retryAfterSeconds: 0 };
    },
    fail(name, key) {
      const bucket = bucketOf(name);
      const windowMs = bucket.windowSeconds * 1000;
      const t = now();
      const id = `${name}:${key}`;
      let state = states.get(id);
      if (!state || t - state.start >= windowMs || (state.blockedUntil > 0 && t >= state.blockedUntil)) {
        const strikes = state && state.blockedUntil > 0 && t - state.blockedUntil < quietMs(bucket) ? state.strikes : 0;
        state = { start: t, count: 0, blockedUntil: 0, strikes };
        states.set(id, state);
      }
      state.count += 1;
      if (state.count < bucket.limit) return;
      state.strikes += 1;
      state.blockedUntil = bucket.maxBlockSeconds === undefined ? state.start + windowMs : t + blockMs(bucket, state.strikes);
    },
    reset(name, key) {
      states.delete(`${name}:${key}`);
    },
    bucketOf,
    sweep() {
      const t = now();
      let removed = 0;
      for (const [id, state] of states) {
        const bucket = bucketOf(id.slice(0, id.indexOf(":")));
        const windowOver = t - state.start >= bucket.windowSeconds * 1000;
        const blockOver = state.blockedUntil === 0 || t - state.blockedUntil >= quietMs(bucket);
        if (windowOver && blockOver) {
          states.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
    keyOf(name) {
      return bucketOf(name).key ?? "ip";
    },
  };
}
