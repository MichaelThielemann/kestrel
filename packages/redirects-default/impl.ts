import type { Blobstore, BlobstoreError } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Content, ContentError } from "@michaelthielemann/kestrel-contracts/content";
import { err, failure, isErr, ok, type KestrelError, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import type { Document, Filter, Persistence, PersistenceError, Schema } from "@michaelthielemann/kestrel-contracts/persistence";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { unobserved } from "@michaelthielemann/kestrel/reads";
import { compilePublishableRedirects, compileRedirects, exactPathPatternSource, matchRedirect, serializeRedirects, RedirectRuleError, type RedirectRule } from "./rules.ts";

export interface Config {
  type: string;
  field: string;
  prefix: string;
  key: string;
}

export type RedirectsError = KestrelError<"TRANSIENT">;

/** One document's path change in one locale, as `site.pathsMoved` reports it. `from`/`to` are canonical public paths, `null` when the document had/has none in `locale`. */
export interface Move {
  type: string;
  id: string;
  locale: string;
  from: string | null;
  to: string | null;
  seq: number;
}

/** An automatic redirect currently in effect: `from` is a path row, the rest identifies the document `redirects_auto_targets` says it now lives at. */
export interface AutoRedirect {
  from: string;
  to: string;
  type: string;
  docId: string;
  locale: string;
  seq: number;
}

export interface Redirects {
  validate(rules: unknown): Promise<Result<void, RedirectsError>>;
  recordMoves(moves: Move[]): Promise<Result<{ recorded: number }, RedirectsError>>;
  lookup(path: string): Promise<Result<{ to: string; status: number } | null, RedirectsError>>;
  export(): Promise<Result<{ rules: number; skipped: string[] }, RedirectsError>>;
  render(): Promise<Result<RedirectRule[], RedirectsError>>;
  listAuto(): Promise<Result<AutoRedirect[], RedirectsError>>;
  removeAuto(path: string): Promise<Result<void, RedirectsError | KestrelError<"NOT_FOUND">>>;
}

export const PATHS = "redirects_auto_paths";
export const TARGETS = "redirects_auto_targets";

/** Every collection this module stores; the persistence handle it is given reaches these and no other. */
export const COLLECTIONS: readonly string[] = [PATHS, TARGETS];

type PathKind = "redirect" | "live" | "removed";

interface PathRow extends Document {
  kind: PathKind;
  type: string;
  docId: string;
  locale: string;
  seq: number;
}

interface TargetRow extends Document {
  path: string | null;
  seq: number;
}

const PAGE = 200;

export function requestPath(raw: string): string {
  const withoutQuery = raw.split("?")[0] ?? "";
  return `/${withoutQuery.replace(/^\/+/, "")}`;
}

function canonicalPath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function targetKey(type: string, docId: string, locale: string): string {
  return `${type}/${docId}/${locale}`;
}

function isTransient(error: ContentError | BlobstoreError | PersistenceError): error is RedirectsError {
  return error.code === "TRANSIENT";
}

function transientOnly(error: ContentError | BlobstoreError | PersistenceError, from: string): RedirectsError {
  if (!isTransient(error)) throw new Error(`redirects/default: unexpected ${from} error ${error.code}: ${error.message}`);
  return error;
}

export async function createRedirects(config: Config, deps: { content: Content; blobs: Blobstore; db: Persistence; logger: Logger }): Promise<Redirects> {
  const { content, blobs, db, logger } = deps;

  const collections: Array<[string, Schema]> = [
    [PATHS, { kind: "string", type: "string", docId: "string", locale: "string", seq: "number" }],
    [TARGETS, { path: "json", seq: "number" }],
  ];
  for (const [collection, schema] of collections) {
    const prepared = await db.ensureCollection(collection, schema);
    if (isErr(prepared)) throw new Error(`redirects/default: cannot prepare collection "${collection}": ${prepared.error.message}`);
  }

  let cache: { updatedAt: number; rules: RedirectRule[] } | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };

  async function publishable(): Promise<Result<{ updatedAt: number; rules: RedirectRule[]; skipped: string[] }, RedirectsError>> {
    const found = await content.get(config.type);
    if (isErr(found)) return err(transientOnly(found.error, "content@1"));
    const doc = found.value;
    if (!doc) return ok({ updatedAt: -1, rules: [], skipped: [] });
    const { rules, skipped } = compilePublishableRedirects(doc[config.field]);
    return ok({ updatedAt: doc.updatedAt, rules, skipped });
  }

  function logSkipped(skipped: string[]): void {
    for (const row of skipped) logger.error(`redirects/default: skipped an unpublishable rule – ${row}`, { type: config.type });
  }

  async function current(): Promise<Result<RedirectRule[], RedirectsError>> {
    const found = await content.get(config.type);
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
      logger.error("redirects/default: rules are not a list, ignoring redirects", { type: config.type, error: e });
      rules = [];
    }
    cache = { updatedAt, rules };
    return ok(rules);
  }

  async function targetOf(type: string, docId: string, locale: string): Promise<Result<TargetRow | null, RedirectsError>> {
    const found = await db.findOne<TargetRow>(TARGETS, { id: targetKey(type, docId, locale) });
    if (isErr(found)) return err(transientOnly(found.error, "persistence@1"));
    return ok(found.value);
  }

  async function eachPathRow(visit: (row: PathRow) => Promise<Result<void, RedirectsError>>): Promise<Result<void, RedirectsError>> {
    let last: string | null = null;
    for (;;) {
      const filter: Filter = last === null ? {} : { id: { gt: last } };
      const page = await db.findMany<PathRow>(PATHS, filter, { sort: { id: "asc" }, limit: PAGE });
      if (isErr(page)) return err(transientOnly(page.error, "persistence@1"));
      for (const row of page.value.items) {
        const visited = await visit(row);
        if (isErr(visited)) return visited;
      }
      if (page.value.items.length < PAGE) return ok(undefined);
      last = page.value.items[page.value.items.length - 1]!.id;
    }
  }

  async function effectiveAutoRedirects(): Promise<Result<AutoRedirect[], RedirectsError>> {
    const out: AutoRedirect[] = [];
    const walked = await eachPathRow(async (row) => {
      if (row.kind !== "redirect") return ok(undefined);
      const target = await targetOf(row.type, row.docId, row.locale);
      if (isErr(target)) return target;
      if (target.value && target.value.path !== null && target.value.path !== row.id) {
        out.push({ from: row.id, to: target.value.path, type: row.type, docId: row.docId, locale: row.locale, seq: row.seq });
      }
      return ok(undefined);
    });
    if (isErr(walked)) return walked;
    return ok(out);
  }

  async function autoAt(path: string): Promise<Result<{ to: string } | null, RedirectsError>> {
    const row = await db.findOne<PathRow>(PATHS, { id: path });
    if (isErr(row)) return err(transientOnly(row.error, "persistence@1"));
    if (!row.value || row.value.kind !== "redirect") return ok(null);
    const target = await targetOf(row.value.type, row.value.docId, row.value.locale);
    if (isErr(target)) return target;
    if (!target.value || target.value.path === null || target.value.path === path) return ok(null);
    return ok({ to: target.value.path });
  }

  async function autoRules(editorRules: RedirectRule[]): Promise<Result<RedirectRule[], RedirectsError>> {
    const effective = await effectiveAutoRedirects();
    if (isErr(effective)) return effective;
    const rules: RedirectRule[] = [];
    for (const auto of effective.value) {
      const shadowedBy = editorRules.find((rule) => new RegExp(rule.pattern).test(auto.to));
      if (shadowedBy) {
        logger.info(`redirects/default: skipped the automatic redirect ${auto.from} -> ${auto.to}, an editor rule already redirects its target`, { from: auto.from, to: auto.to });
        continue;
      }
      rules.push({ pattern: exactPathPatternSource(auto.from), target: auto.to, status: 301 });
    }
    return ok(rules);
  }

  async function claimPath(path: string, kind: PathKind, move: Move, wins: (existing: PathRow) => boolean): Promise<Result<void, RedirectsError>> {
    const found = await db.findOne<PathRow>(PATHS, { id: path });
    if (isErr(found)) return err(transientOnly(found.error, "persistence@1"));
    const patch = { kind, type: move.type, docId: move.id, locale: move.locale, seq: move.seq };
    if (!found.value) {
      const created = await db.createOne<PathRow>(PATHS, { id: path, ...patch });
      return isErr(created) ? err(transientOnly(created.error, "persistence@1")) : ok(undefined);
    }
    if (!wins(found.value)) return ok(undefined);
    const updated = await db.updateOne<PathRow>(PATHS, path, patch);
    return isErr(updated) ? err(transientOnly(updated.error, "persistence@1")) : ok(undefined);
  }

  async function applyMove(move: Move): Promise<Result<void, RedirectsError>> {
    const key = targetKey(move.type, move.id, move.locale);
    const target = await db.findOne<TargetRow>(TARGETS, { id: key });
    if (isErr(target)) return err(transientOnly(target.error, "persistence@1"));
    if (!target.value || move.seq > target.value.seq) {
      const written = target.value ? await db.updateOne<TargetRow>(TARGETS, key, { path: move.to, seq: move.seq }) : await db.createOne<TargetRow>(TARGETS, { id: key, path: move.to, seq: move.seq });
      if (isErr(written)) return err(transientOnly(written.error, "persistence@1"));
    }

    if (move.from !== null) {
      const claimed = await claimPath(move.from, "redirect", move, (existing) => move.seq > existing.seq);
      if (isErr(claimed)) return claimed;
    }
    if (move.to !== null) {
      const claimed = await claimPath(move.to, "live", move, (existing) => (existing.kind === "removed" ? move.seq > existing.seq : move.seq >= existing.seq));
      if (isErr(claimed)) return claimed;
    }
    return ok(undefined);
  }

  return {
    async validate(rulesInput) {
      const compiled = compileRedirects(rulesInput);
      const effective = await effectiveAutoRedirects();
      if (isErr(effective)) return effective;
      const sources = new Set(effective.value.map((auto) => auto.from));
      compiled.forEach((rule, i) => {
        if (rule.target.startsWith("/") && sources.has(rule.target)) {
          throw new RedirectRuleError(`Row ${i + 1}: "To" points at ${rule.target}, which is itself an automatic redirect – this would create a redirect loop`);
        }
      });
      return ok(undefined);
    },
    recordMoves: (moves) =>
      serial(async () => {
        let recorded = 0;
        for (const move of moves) {
          const applied = await applyMove(move);
          if (isErr(applied)) return applied;
          recorded += 1;
        }
        return ok({ recorded });
      }),
    async lookup(path) {
      return unobserved(async () => {
        const rules = await current();
        if (isErr(rules)) return rules;
        const hit = matchRedirect(rules.value, path);
        if (hit) return ok({ to: hit.target, status: hit.status });
        const auto = await autoAt(canonicalPath(path));
        if (isErr(auto)) return auto;
        if (!auto.value || matchRedirect(rules.value, auto.value.to)) return ok(null);
        return ok({ to: auto.value.to, status: 301 });
      });
    },
    async export() {
      const pub = await publishable();
      if (isErr(pub)) return pub;
      const { rules, skipped } = pub.value;
      logSkipped(skipped);
      const auto = await autoRules(rules);
      if (isErr(auto)) return auto;
      const combined = [...rules, ...auto.value];
      const put = await blobs.put(`${config.prefix}${config.key}`, new TextEncoder().encode(serializeRedirects(combined)), { contentType: "application/json" });
      if (isErr(put)) return err(transientOnly(put.error, "blobstore@1"));
      return ok({ rules: combined.length, skipped });
    },
    async render() {
      const pub = await publishable();
      if (isErr(pub)) return pub;
      logSkipped(pub.value.skipped);
      const auto = await autoRules(pub.value.rules);
      if (isErr(auto)) return auto;
      return ok([...pub.value.rules, ...auto.value]);
    },
    async listAuto() {
      const effective = await effectiveAutoRedirects();
      if (isErr(effective)) return effective;
      return ok([...effective.value].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)));
    },
    removeAuto: (rawPath) =>
      serial(async (): Promise<Result<void, RedirectsError | KestrelError<"NOT_FOUND">>> => {
        const path = canonicalPath(requestPath(rawPath));
        const at = await autoAt(path);
        if (isErr(at)) return at;
        if (!at.value) return err(failure("NOT_FOUND", `redirects: no automatic redirect at ${path}`));
        const updated = await db.updateOne<PathRow>(PATHS, path, { kind: "removed" });
        return isErr(updated) ? err(transientOnly(updated.error, "persistence@1")) : ok(undefined);
      }),
  };
}
