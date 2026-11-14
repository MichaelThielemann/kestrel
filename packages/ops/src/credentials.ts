import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Redactor } from "./redact.ts";
import { OpsError } from "./errors.ts";

/** Where a credential comes from: an environment variable, or the standard output of a command run without a shell. */
export type CredentialSource = { env: string } | { command: string[] };

/** Runs a credential command; injectable for tests. */
export type CommandRunner = (argv: readonly string[]) => Promise<string>;

const runCommand: CommandRunner = (argv) =>
  new Promise((resolve, reject) => {
    const [file, ...args] = argv;
    if (file === undefined) {
      reject(new Error("empty command"));
      return;
    }
    execFile(file, args, { timeout: 60_000, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(new Error(`exited with ${typeof error.code === "number" ? error.code : "an error"}`));
      else resolve(stdout);
    });
  });

/** Resolves a credential, registers it with the redactor and returns it. The value is never logged, not even in an error. */
export async function resolveCredential(source: CredentialSource, label: string, redactor: Redactor, env: NodeJS.ProcessEnv, run: CommandRunner = runCommand): Promise<string> {
  let value: string;
  if ("env" in source) {
    const found = env[source.env];
    if (found === undefined || found === "") throw new OpsError(`${label}: environment variable ${source.env} is not set`, 2);
    value = found;
  } else {
    try {
      value = (await run(source.command)).replace(/\r?\n$/, "");
    } catch (cause) {
      throw new OpsError(`${label}: the command ${source.command[0] ?? ""} failed (${cause instanceof Error ? cause.message : "unknown error"})`, 2);
    }
    if (value === "") throw new OpsError(`${label}: the command ${source.command[0] ?? ""} printed nothing`, 2);
  }
  redactor.add(value);
  return value;
}

/** Hands `content` to `use` as a file readable only by the current user, removed afterwards whatever happens. */
export async function withSecretFile<T>(content: string, use: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "kestrel-ops-"));
  const file = join(dir, "secret");
  try {
    await writeFile(file, content, { mode: 0o600 });
    return await use(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
