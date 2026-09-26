import { execFile, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = join(CLI_DIR, "..", "..");
export const CLI = join(CLI_DIR, "src", "cli.ts");
export const MINIMAL = join(REPO, "examples", "minimal");
export const FIXTURES = join(CLI_DIR, "__fixtures__");

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI from source in a child process. */
export function runCli(args: readonly string[], options: { cwd?: string; env?: Record<string, string>; nodeArgs?: readonly string[]; entry?: string } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--disable-warning=ExperimentalWarning", ...(options.nodeArgs ?? []), options.entry ?? CLI, ...args], { cwd: options.cwd ?? process.cwd(), env: { ...process.env, ...options.env }, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, stdout, stderr });
    });
  });
}

/** A fresh directory under the OS temp dir whose name contains `kestrel-`. */
export function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `kestrel-cli-${label}-`));
}

/** Copies a project without its node_modules into a temp dir and links node_modules to the resolvable original. */
export function copyProject(source: string, label: string, nodeModules = join(source, "node_modules")): string {
  const dir = tempDir(label);
  cpSync(source, dir, { recursive: true, filter: (src) => basename(src) !== "node_modules" && src !== join(source, "data") });
  symlinkSync(realpathSync(existsSync(nodeModules) ? nodeModules : join(CLI_DIR, "node_modules")), join(dir, "node_modules"), "dir");
  return dir;
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

const HOOK = `import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    appendFileSync(process.env.KESTREL_LOAD_TRACE, result.url + "\\n");
    return result;
  },
});
`;

/** Writes an `--import` hook that records every resolved URL into `trace`; returns the node arguments. */
export function loadTrace(dir: string): { nodeArgs: string[]; env: Record<string, string>; urls: () => string[] } {
  const hook = join(dir, "load-trace-hook.mjs");
  const trace = join(dir, "load-trace.txt");
  writeFileSync(hook, HOOK);
  writeFileSync(trace, "");
  return { nodeArgs: ["--import", pathToFileURL(hook).href], env: { KESTREL_LOAD_TRACE: trace }, urls: () => readFileSync(trace, "utf8").split("\n").filter((line) => line !== "") };
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Starts a long-running CLI process, waits for `marker` on stdout, sends SIGTERM and returns the exit code and output. */
export function startAndStop(args: readonly string[], options: { cwd: string; env?: Record<string, string>; nodeArgs?: readonly string[]; entry?: string; marker?: string; timeoutMs?: number }): Promise<RunResult & { started: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ...(options.nodeArgs ?? []), options.entry ?? CLI, ...args], { cwd: options.cwd, env: { ...process.env, ...options.env } });
    let stdout = "";
    let stderr = "";
    let started = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!started && stdout.includes(options.marker ?? "kestrel started")) {
        started = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, started });
    });
  });
}
