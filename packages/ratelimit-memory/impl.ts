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
  /** For a `username` bucket: the budget of each device holding a valid device cookie for the account, counted in place of the account's budget. */
  knownDevices?: DeviceBudget | undefined;
}

/** The limits of one known device's own budget; it counts the way its account bucket does. */
export interface DeviceBudget {
  limit: number;
  windowSeconds: number;
  maxBlockSeconds?: number | undefined;
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
  /** Counts the next attempt before it runs, so parallel attempts cannot pass the limit together; `refund` gives it back and `fail` keeps it. */
  reserve(bucket: string, key: string): Decision;
  /** Gives back an attempt `reserve` counted, for a run that turned out not to count. */
  refund(bucket: string, key: string): void;
  /** Keeps an attempt `reserve` counted as a failure; the key is blocked once its failures reach the limit. */
  fail(bucket: string, key: string): void;
  /** Forgets the key, e.g. after a successful sign-in. */
  reset(bucket: string, key: string): void;
  sweep(): number;
  keyOf(bucket: string): BucketKey;
  bucketOf(bucket: string): Bucket;
  /** The name under which the known devices of an account bucket are counted; `undefined` for a bucket without `knownDevices`. */
  deviceBucketOf(bucket: string): string | undefined;
}

/** The name under which the known devices of the account bucket `bucket` are counted. */
export function deviceBucketName(bucket: string): string {
  return `${bucket}~devices`;
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
  const buckets: Record<string, Bucket> = { ...config.buckets };
  for (const [name, bucket] of Object.entries(config.buckets)) {
    if (bucket.knownDevices === undefined) continue;
    if ((bucket.key ?? "ip") !== "username") throw new Error(`ratelimit/memory: bucket "${name}" has knownDevices, which only a username bucket can have`);
    const devices = deviceBucketName(name);
    if (devices in config.buckets) throw new Error(`ratelimit/memory: bucket "${devices}" clashes with the known devices of bucket "${name}"`);
    buckets[devices] = { ...bucket.knownDevices, key: "username", counts: bucket.counts };
  }
  const bucketOf = (name: string): Bucket => {
    const bucket = buckets[name];
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
    reserve(name, key) {
      const bucket = bucketOf(name);
      const windowMs = bucket.windowSeconds * 1000;
      const t = now();
      const id = `${name}:${key}`;
      let state = states.get(id);
      if (state && t < state.blockedUntil) return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((state.blockedUntil - t) / 1000)) };
      if (!state || t - state.start >= windowMs || state.blockedUntil > 0) {
        const strikes = state && state.blockedUntil > 0 && t - state.blockedUntil < quietMs(bucket) ? state.strikes : 0;
        state = { start: t, count: 0, blockedUntil: 0, strikes };
        states.set(id, state);
      }
      if (state.count >= bucket.limit) return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((state.start + windowMs - t) / 1000)) };
      state.count += 1;
      return { allowed: true, remaining: bucket.limit - state.count, retryAfterSeconds: 0 };
    },
    refund(name, key) {
      const state = states.get(`${name}:${key}`);
      if (state && state.count > 0) state.count -= 1;
    },
    fail(name, key) {
      const bucket = bucketOf(name);
      const t = now();
      const state = states.get(`${name}:${key}`);
      if (!state || state.count < bucket.limit || t < state.blockedUntil) return;
      state.strikes += 1;
      state.blockedUntil = bucket.maxBlockSeconds === undefined ? state.start + bucket.windowSeconds * 1000 : t + blockMs(bucket, state.strikes);
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
    deviceBucketOf(name) {
      return bucketOf(name).knownDevices === undefined ? undefined : deviceBucketName(name);
    },
  };
}
