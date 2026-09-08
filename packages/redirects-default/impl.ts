import type { Blobstore, BlobstoreError } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Content, ContentError } from "@michaelthielemann/kestrel-contracts/content";
import { err, isErr, ok, type KestrelError, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { compilePublishableRedirects, compileRedirects, matchRedirect, serializeRedirects, RedirectRuleError, type RedirectRule } from "./rules.ts";

export interface Config {
  type: string;
  field: string;
  prefix: string;
  key: string;
}

export type RedirectsError = KestrelError<"TRANSIENT">;

export interface Redirects {
  validate(rules: unknown): void;
  lookup(path: string): Promise<Result<{ to: string; status: number } | null, RedirectsError>>;
  export(): Promise<Result<{ rules: number; skipped: string[] }, RedirectsError>>;
  render(): Promise<Result<RedirectRule[], RedirectsError>>;
}

export function requestPath(raw: string): string {
  const withoutQuery = raw.split("?")[0] ?? "";
  return `/${withoutQuery.replace(/^\/+/, "")}`;
}

/** content@1 and blobstore@1 only ever answer TRANSIENT here (no locale option, no move); anything else is a bug. */
function transientOnly(error: ContentError | BlobstoreError, from: string): RedirectsError {
  if (error.code !== "TRANSIENT") throw new Error(`redirects/default: unexpected ${from} error ${error.code}: ${error.message}`);
  return error as RedirectsError;
}

export function createRedirects(config: Config, deps: { content: Content; blobs: Blobstore; logger: Logger }): Redirects {
  let cache: { updatedAt: number; rules: RedirectRule[] } | undefined;

  async function publishable(): Promise<Result<{ updatedAt: number; rules: RedirectRule[]; skipped: string[] }, RedirectsError>> {
    const found = await deps.content.get(config.type);
    if (isErr(found)) return err(transientOnly(found.error, "content@1"));
    const doc = found.value;
    if (!doc) return ok({ updatedAt: -1, rules: [], skipped: [] });
    const { rules, skipped } = compilePublishableRedirects(doc[config.field]);
    return ok({ updatedAt: doc.updatedAt, rules, skipped });
  }

  function logSkipped(skipped: string[]): void {
    for (const row of skipped) deps.logger.error(`redirects/default: skipped an unpublishable rule – ${row}`, { type: config.type });
  }

  async function current(): Promise<Result<RedirectRule[], RedirectsError>> {
    const found = await deps.content.get(config.type);
    if (isErr(found)) return err(transientOnly(found.error, "content@1"));
    const doc = found.value;
    const updatedAt = doc?.updatedAt ?? -1;
    if (cache && cache.updatedAt === updatedAt) return ok(cache.rules);
    let rules: RedirectRule[];
    try {
      const compiled = doc ? compilePublishableRedirects(doc[config.field]) : { rules: [], skipped: [] };
      logSkipped(compiled.skipped);
      rules = compiled.rules;
    } catch (e) {
      if (!(e instanceof RedirectRuleError)) throw e;
      // A stored field that is neither absent nor a list is a broken container, not a bad row: fail
      // open on lookups so a live site keeps resolving pages instead of 500ing on every request.
      deps.logger.error("redirects/default: rules are not a list, ignoring redirects", { type: config.type, error: e });
      rules = [];
    }
    cache = { updatedAt, rules };
    return ok(rules);
  }

  return {
    validate(rules) {
      compileRedirects(rules);
    },
    async lookup(path) {
      const rules = await current();
      if (isErr(rules)) return rules;
      const hit = matchRedirect(rules.value, path);
      return ok(hit ? { to: hit.target, status: hit.status } : null);
    },
    async export() {
      const pub = await publishable();
      if (isErr(pub)) return pub;
      const { rules, skipped } = pub.value;
      logSkipped(skipped);
      const put = await deps.blobs.put(`${config.prefix}${config.key}`, new TextEncoder().encode(serializeRedirects(rules)), { contentType: "application/json" });
      if (isErr(put)) return err(transientOnly(put.error, "blobstore@1"));
      return ok({ rules: rules.length, skipped });
    },
    async render() {
      const pub = await publishable();
      if (isErr(pub)) return pub;
      logSkipped(pub.value.skipped);
      return ok(pub.value.rules);
    },
  };
}
