import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { messageOf } from "../context.ts";
import { OpsError } from "../errors.ts";
import { tables } from "../sqlite.ts";
import type { UpdateContext } from "./types.ts";

/** The table the content migrations record each applied migration in. */
export const CONTENT_LEDGER = "content_migrations";

/** What {@link runContentMigrations} works on. */
export interface ContentMigrationInput {
  /** The database copy the content migrations change in place; it already holds the release's storage shape. */
  database: string;
  /** A local directory that stands in for the blob store during the local start. */
  blobsDir: string;
  /** Content migration ids the plan expects; the local start runs no others. */
  expected: readonly string[];
}

/** What a local start of the release applied. */
export interface ContentMigrationResult {
  /** False when nothing was pending and no local start ran. */
  ran: boolean;
  applied: string[];
  /** Milliseconds from the start of the local process until it reported ready. */
  bootMs: number | null;
}

/** The ids the content-migration ledger of `file` holds; none when the database has no ledger. */
export function ledgerIds(file: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!tables(db).includes(CONTENT_LEDGER)) return [];
    return boundaryCast<Array<{ id: string }>>(db.prepare(`SELECT "id" FROM "${CONTENT_LEDGER}" ORDER BY "id"`).all(), "host").map((row) => row.id);
  } finally {
    db.close();
  }
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

function executable(command: string, dir: string): string {
  if (command === "node") return process.execPath;
  if (command.includes("/") || command.includes("\\")) return isAbsolute(command) ? command : resolve(dir, command);
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (entry !== "" && existsSync(join(entry, command))) return join(entry, command);
  }
  throw new OpsError(`update.localBoot.command: ${command} is not found on PATH`, 2, "update.localBoot.command");
}

const fill = (value: string, places: Readonly<Record<string, string>>): string => value.replace(/\{(database|blobs|port|build)\}/g, (_, name: string) => places[name] ?? "");

async function ready(url: string, deadline: number, exited: () => string | null): Promise<void> {
  for (;;) {
    const ended = exited();
    if (ended !== null) throw new OpsError(`the local start of the release ended before it was ready (${ended})`, 1, "content-migrations");
    const status = await fetch(url, { signal: AbortSignal.timeout(2000) }).then(
      async (response) => {
        await response.body?.cancel();
        return response.status;
      },
      () => null,
    );
    if (status === 200) return;
    if (Date.now() > deadline) throw new OpsError(`the local start of the release did not answer ${url} with 200 in time`, 1, "content-migrations");
    await new Promise((done) => setTimeout(done, 200));
  }
}

/**
 * Applies the release's pending content migrations by starting the release on this machine on `input.database`
 * through `update.localBoot`, with an environment of exactly the host's `localBootEnv` and the `localBoot.env` values
 * (placeholders `{database}`, `{blobs}`, `{port}` and `{build}` filled in, `localBoot.env` winning), never a variable
 * of this process's environment, and stops it once ready. Nothing runs when nothing is pending. `{build}` is a build
 * identity of the local start's own, so the production start renders every output again. Refuses with exit 2 when
 * content migrations are pending and `update.localBoot` is not configured, and with exit 1 when the start applied a
 * migration the plan does not name or did not apply one it names.
 */
export async function runContentMigrations(ctx: UpdateContext, input: ContentMigrationInput): Promise<ContentMigrationResult> {
  const before = new Set(ledgerIds(input.database));
  const pending = input.expected.filter((id) => !before.has(id));
  if (pending.length === 0) return { ran: false, applied: [], bootMs: null };
  const boot = ctx.update.localBoot;
  if (boot === undefined) throw new OpsError(`content migrations ${pending.join(", ")} are pending, and update.localBoot of ${ctx.envName} names no local start of the release to apply them with`, 2, "update.localBoot");
  mkdirSync(input.blobsDir, { recursive: true });
  const dir = resolve(ctx.release.dir, boot.dir);
  const port = await freePort();
  const places = { database: input.database, blobs: input.blobsDir, port: String(port), build: `kestrel-ops-local-${ctx.runId}` };
  const env: Record<string, string> = { ...ctx.host.localBootEnv };
  for (const [name, value] of Object.entries(boot.env)) env[name] = fill(value, places);
  const [command = "", ...args] = boot.command;
  const started = Date.now();
  const child = spawn(executable(command, dir), args.map((arg) => fill(arg, places)), { cwd: dir, env, stdio: ["ignore", "ignore", "pipe"] });
  let ended: string | null = null;
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.addListener("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  const exited = new Promise<void>((done) => {
    child.once("exit", (code, signal) => {
      ended = signal === null ? `exit code ${code ?? "?"}` : `signal ${signal}`;
      done();
    });
    child.once("error", (cause) => {
      ended = messageOf(cause);
      done();
    });
  });
  let bootMs: number;
  try {
    await ready(`http://127.0.0.1:${port}${boot.readyPath}`, started + boot.timeoutSeconds * 1000, () => ended);
    bootMs = Date.now() - started;
  } catch (error) {
    const last = ctx.redactor.apply(stderr.trim().split("\n").slice(-3).join(" | "));
    if (last !== "" && error instanceof OpsError) throw new OpsError(`${error.message}; its last output: ${last}`, error.exitCode, error.element);
    throw error;
  } finally {
    if (ended === null) {
      child.kill("SIGTERM");
      const forced = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(forced);
    }
  }
  const after = ledgerIds(input.database).filter((id) => !before.has(id));
  const unplanned = after.filter((id) => !input.expected.includes(id));
  if (unplanned.length > 0) throw new OpsError(`the local start applied content migrations the plan does not name: ${unplanned.join(", ")}`, 1, "content-migrations");
  const missing = pending.filter((id) => !after.includes(id));
  if (missing.length > 0) throw new OpsError(`the local start became ready without applying ${missing.join(", ")}; check that update.localBoot.env switches the content migrations to apply`, 1, "content-migrations");
  return { ran: true, applied: pending.filter((id) => after.includes(id)), bootMs };
}
