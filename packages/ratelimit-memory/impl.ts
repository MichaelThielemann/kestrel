export interface Bucket {
  limit: number;
  windowSeconds: number;
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
  sweep(): number;
}

export function createRateLimitMemory(config: Config, now: () => number = Date.now): RateLimit {
  const windows = new Map<string, { start: number; count: number }>();
  const bucketOf = (name: string): Bucket => {
    const bucket = config.buckets[name];
    if (!bucket) throw new Error(`ratelimit/memory: unknown bucket "${name}"`);
    return bucket;
  };

  return {
    hit(name, key) {
      const bucket = bucketOf(name);
      const windowMs = bucket.windowSeconds * 1000;
      const t = now();
      const id = `${name}:${key}`;
      let w = windows.get(id);
      if (!w || t - w.start >= windowMs) {
        w = { start: t, count: 0 };
        windows.set(id, w);
      }
      w.count += 1;
      const retryAfterSeconds = Math.max(1, Math.ceil((w.start + windowMs - t) / 1000));
      return { allowed: w.count <= bucket.limit, remaining: Math.max(0, bucket.limit - w.count), retryAfterSeconds };
    },
    sweep() {
      const t = now();
      let removed = 0;
      for (const [id, w] of windows) {
        const name = id.slice(0, id.indexOf(":"));
        if (t - w.start >= bucketOf(name).windowSeconds * 1000) {
          windows.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
  };
}
