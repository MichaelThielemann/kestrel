import type { Content, ContentDocument, ContentError } from "@michaelthielemann/kestrel-contracts/content";
import { err, failure, isErr, ok, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import type { Events } from "@michaelthielemann/kestrel-contracts/events";
import { migrationFailed, type ApplyResult, type LedgerEntry, type Migration, type MigrationContext, type Migrations, type MigrationsError, type PendingMigration } from "@michaelthielemann/kestrel-contracts/migrations";
import type { Document, Persistence, PersistenceError } from "@michaelthielemann/kestrel-contracts/persistence";
import type { Validate } from "@michaelthielemann/kestrel-contracts/validate";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import type { Err } from "@michaelthielemann/kestrel/result";

export const LEDGER = "content_migrations";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface Config {
  migrations: Migration[];
  chunk: number;
}

export interface MigrationsDefault extends Migrations {
  runBoot(mode: "apply" | "check" | "off"): Promise<void>;
}

interface LedgerRow extends Document {
  appliedAt: number;
  documents: number;
  durationMs: number;
}

interface FieldProblem {
  field: string;
  path: string;
  message: string;
}

function causeOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** Every collection and locale reaching content@1 comes from the model itself, so anything but a transient failure there is a wiring bug. */
function fromContent(error: ContentError): MigrationsError {
  if (error.code !== "TRANSIENT") throw new Error(`migrations: unexpected content@1 error ${error.code}: ${error.message}`);
  return error as MigrationsError;
}

/** The ledger is read by filter and written with a fresh id, so persistence@1 never answers NOT_FOUND here. */
function fromPersistence(error: PersistenceError): MigrationsError {
  if (error.code === "NOT_FOUND") throw new Error(`migrations: unexpected persistence@1 error ${error.code}: ${error.message}`);
  return error as MigrationsError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

const META_KEYS = new Set(["id", "createdAt", "updatedAt", "_translations", "_locales", "_locale", "_links"]);

function toPatch(next: ContentDocument | Record<string, unknown>, current: ContentDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    if (META_KEYS.has(key)) continue;
    if (!deepEqual(value, (current as Record<string, unknown>)[key])) out[key] = value;
  }
  return out;
}

function localizedFieldsOf(content: Content, collection: string): string[] {
  const fields = content.model().types[collection]?.fields ?? {};
  return Object.entries(fields)
    .filter(([, def]) => typeof def !== "string" && def.localized === true)
    .map(([field]) => field);
}

function hasOwnData(doc: ContentDocument, localizedFields: string[]): boolean {
  return localizedFields.some((field) => doc[field] !== null && doc[field] !== undefined);
}

async function localesFor(content: Content, collection: string, docId: string, modelLocales: string[], localizedFields: string[]): Promise<Result<(string | undefined)[], MigrationsError>> {
  if (modelLocales.length === 0 || localizedFields.length === 0) return ok([undefined]);
  const withData: string[] = [];
  for (const locale of modelLocales) {
    const current = await content.get(collection, docId, { locale });
    if (isErr(current)) return err(fromContent(current.error));
    if (current.value !== null && hasOwnData(current.value, localizedFields)) withData.push(locale);
  }
  return ok(withData.length > 0 ? withData : [undefined]);
}

function validatePatch(collection: string, validate: Validate, patch: Record<string, unknown>): FieldProblem[] {
  const targets = new Set(validate.targets());
  const problems: FieldProblem[] = [];
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) continue;
    const target = `${collection}.${field}`;
    if (!targets.has(target)) continue;
    const result = validate.check(target, value);
    if (!result.ok) for (const problem of result.problems) problems.push({ field, path: problem.path, message: problem.message });
  }
  return problems;
}

function failedOn(migration: Migration, docId: string, locale: string | undefined, cause: string, problems?: FieldProblem[]): Err<MigrationsError> {
  const details: { migration: string; document: string; locale?: string; problems?: unknown } = { migration: migration.id, document: docId };
  if (locale !== undefined) details.locale = locale;
  if (problems !== undefined) details.problems = problems;
  const where = `${migration.collection}/${docId}${locale === undefined ? "" : ` locale ${locale}`}`;
  return err(migrationFailed(`migrations: "${migration.id}" failed on ${where}: ${cause}`, details));
}

export async function createMigrations(
  config: Config,
  deps: { content: Content; db: Persistence; events: Events; validate?: Validate; logger: Logger; now?: () => number },
): Promise<MigrationsDefault> {
  const { content, db, events, validate, logger } = deps;
  const now = deps.now ?? Date.now;

  const seen = new Set<string>();
  const types = content.model().types;
  for (const migration of config.migrations) {
    if (!ID_RE.test(migration.id)) throw new Error(`migrations: invalid id "${migration.id}"`);
    if (seen.has(migration.id)) throw new Error(`migrations: duplicate id "${migration.id}"`);
    seen.add(migration.id);
    if (!types[migration.collection]) throw new Error(`migrations: migration "${migration.id}" names unknown collection "${migration.collection}"`);
  }

  const ledger = await db.ensureCollection(LEDGER, { appliedAt: "number", documents: "number", durationMs: "number" });
  if (isErr(ledger)) throw new Error(`migrations: the ledger collection could not be prepared: ${ledger.error.message}`);

  let busy = false;

  async function ledgerRows(): Promise<Result<LedgerEntry[], MigrationsError>> {
    const rows: LedgerEntry[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await db.findMany<LedgerRow>(LEDGER, {}, { limit: 500, offset, sort: { id: "asc" } });
      if (isErr(page)) return err(fromPersistence(page.error));
      for (const row of page.value.items) rows.push({ id: row.id, appliedAt: row.appliedAt, documents: row.documents, durationMs: row.durationMs });
      if (page.value.items.length < 500) break;
    }
    return ok(rows);
  }

  async function applyOne(migration: Migration, dry: boolean): Promise<Result<{ id: string; documents: number; durationMs: number }, MigrationsError>> {
    const start = now();
    const modelLocales = content.model().locales ?? [];
    const localizedFields = localizedFieldsOf(content, migration.collection);
    let cursor: string | undefined;
    let changedDocuments = 0;
    for (;;) {
      const filter = cursor === undefined ? {} : { id: { gt: cursor } };
      const page = await content.list(migration.collection, filter, { sort: { id: "asc" }, limit: config.chunk });
      if (isErr(page)) return err(fromContent(page.error));
      const items = page.value.items;
      if (items.length === 0) break;
      for (const doc of items) {
        let docChanged = false;
        const locales = await localesFor(content, migration.collection, doc.id, modelLocales, localizedFields);
        if (isErr(locales)) return locales;
        for (const locale of locales.value) {
          const current = await content.get(migration.collection, doc.id, locale === undefined ? {} : { locale });
          if (isErr(current)) return err(fromContent(current.error));
          if (current.value === null) continue;
          const ctx: MigrationContext = locale === undefined ? { document: current.value } : { document: current.value, locale };
          let next: ContentDocument | Record<string, unknown> | null;
          try {
            next = migration.up(ctx);
          } catch (error) {
            return failedOn(migration, doc.id, locale, causeOf(error));
          }
          if (next === null) continue;
          const patch = toPatch(next, current.value);
          if (Object.keys(patch).length === 0) continue;
          const problems = validate ? validatePatch(migration.collection, validate, patch) : [];
          if (problems.length > 0) return failedOn(migration, doc.id, locale, problems.map((p) => `${p.field} ${p.path} ${p.message}`).join("; "), problems);
          if (!dry) {
            const updated = await content.update(migration.collection, doc.id, patch, locale === undefined ? {} : { locale });
            if (isErr(updated)) {
              if (updated.error.code === "TRANSIENT") return err(fromContent(updated.error));
              return failedOn(migration, doc.id, locale, updated.error.message);
            }
          }
          docChanged = true;
        }
        if (docChanged) changedDocuments += 1;
      }
      cursor = items[items.length - 1]!.id;
      if (items.length < config.chunk) break;
    }
    return ok({ id: migration.id, documents: changedDocuments, durationMs: now() - start });
  }

  async function list(): Promise<Result<{ applied: LedgerEntry[]; pending: PendingMigration[] }, MigrationsError>> {
    const rows = await ledgerRows();
    if (isErr(rows)) return rows;
    const applied = [...rows.value].sort((a, b) => a.appliedAt - b.appliedAt || a.id.localeCompare(b.id));
    const appliedIds = new Set(rows.value.map((row) => row.id));
    const pending = config.migrations.filter((migration) => !appliedIds.has(migration.id)).map((migration) => ({ id: migration.id, collection: migration.collection }));
    return ok({ applied, pending });
  }

  async function check(): Promise<Result<PendingMigration[], MigrationsError>> {
    const listed = await list();
    if (isErr(listed)) return listed;
    return ok(listed.value.pending);
  }

  async function apply(options?: { dry?: boolean }): Promise<Result<ApplyResult, MigrationsError>> {
    if (busy) return err(failure("CONFLICT", "migrations: apply is running"));
    busy = true;
    try {
      const dry = options?.dry === true;
      const rows = await ledgerRows();
      if (isErr(rows)) return rows;
      const appliedIds = new Set(rows.value.map((row) => row.id));
      const pendingMigrations = config.migrations.filter((migration) => !appliedIds.has(migration.id));

      if (dry) {
        const changes: { id: string; documents: number }[] = [];
        for (const migration of pendingMigrations) {
          const result = await applyOne(migration, true);
          if (isErr(result)) return result;
          changes.push({ id: result.value.id, documents: result.value.documents });
        }
        return ok<ApplyResult>({ dry: true, changes });
      }

      const appliedEntries: LedgerEntry[] = [];
      const emitApplied = async (): Promise<void> => {
        if (appliedEntries.length === 0) return;
        try {
          await events.emit("migrations.applied", { migrations: appliedEntries.map((entry) => entry.id), documents: appliedEntries.reduce((sum, entry) => sum + entry.documents, 0) });
        } catch (error) {
          logger.error("migrations: a migrations.applied listener failed", { error: causeOf(error) });
        }
      };

      for (const migration of pendingMigrations) {
        const result = await applyOne(migration, false);
        if (isErr(result)) {
          await emitApplied();
          return result;
        }
        const entry: LedgerEntry = { id: migration.id, appliedAt: now(), documents: result.value.documents, durationMs: result.value.durationMs };
        const stored = await db.createOne<LedgerRow>(LEDGER, { id: entry.id, appliedAt: entry.appliedAt, documents: entry.documents, durationMs: entry.durationMs });
        if (isErr(stored)) {
          await emitApplied();
          return err(fromPersistence(stored.error));
        }
        appliedEntries.push(entry);
        logger.info(`migrations: applied "${migration.id}"`, { collection: migration.collection, documents: result.value.documents, durationMs: result.value.durationMs });
      }
      await emitApplied();
      return ok<ApplyResult>({ applied: appliedEntries });
    } finally {
      busy = false;
    }
  }

  async function runBoot(mode: "apply" | "check" | "off"): Promise<void> {
    if (mode === "off") return;
    if (mode === "check") {
      const pending = await check();
      if (isErr(pending)) throw new Error(pending.error.message);
      if (pending.value.length === 0) return;
      const names = pending.value.map((p) => `${p.id} (${p.collection})`).join(", ");
      throw new Error(`migrations: ${pending.value.length} pending migration(s): ${names} — set mode "apply" to run them`);
    }
    const applied = await apply();
    if (isErr(applied)) throw new Error(applied.error.message);
  }

  return { list, check, apply, runBoot };
}
