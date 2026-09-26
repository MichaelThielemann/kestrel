import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { resolve } from "node:path";
import { importProjectCore, type ProjectCore } from "../projectCore.ts";

const FATAL_TIMEOUT_MS = 5_000;
const FATAL_HANDLERS = Symbol.for("kestrel.fatalHandlers");

type Kestrel = Awaited<ReturnType<ProjectCore["boot"]>>;

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hostPackage(root: string): string | undefined {
  const rootPkgFile = resolve(root, "package.json");
  const pkg = readJson(rootPkgFile);
  if (!isRecord(pkg)) return undefined;
  for (const block of [pkg.dependencies, pkg.devDependencies]) {
    if (!isRecord(block)) continue;
    for (const name of Object.keys(block)) {
      let file: string | undefined;
      try {
        file = findPackageJSON(name, rootPkgFile);
      } catch {
        continue;
      }
      const dep = file === undefined ? undefined : readJson(file);
      if (isRecord(dep) && isRecord(dep.kestrel) && typeof dep.kestrel.plugin === "string") return name;
    }
  }
  return undefined;
}

function installFatalHandlers(core: ProjectCore, kestrel: Kestrel): void {
  if (Reflect.get(process, FATAL_HANDLERS) === true) return;
  Reflect.set(process, FATAL_HANDLERS, true);
  const fatal = (event: "unhandledRejection" | "uncaughtException") => (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    core.consoleLogger.error(event, { reason: error.message, stack: error.stack ?? null });
    const exit = () => process.exit(1);
    void kestrel.stop({ timeoutMs: FATAL_TIMEOUT_MS }).then(exit, exit);
  };
  process.on("unhandledRejection", fatal("unhandledRejection"));
  process.on("uncaughtException", fatal("uncaughtException"));
}

function installShutdown(core: ProjectCore, kestrel: Kestrel): void {
  const shutdown = (signal: string) => () => {
    core.consoleLogger.info("kestrel stopping", { signal });
    void kestrel.stop().then(
      ({ drained }) => {
        if (!drained) core.consoleLogger.error("shutdown deadline hit, closing anyway", { signal });
        process.exit(drained ? 0 : 1);
      },
      (err: unknown) => {
        core.consoleLogger.error("shutdown failed", { signal, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", shutdown("SIGINT"));
  process.once("SIGTERM", shutdown("SIGTERM"));
}

/** `kestrel start`: boots the project in the process cwd with its own core and starts the triggers. */
export async function run(argv: readonly string[]): Promise<number | undefined> {
  if (argv.length > 0) {
    process.stderr.write(`kestrel start: unexpected argument "${argv[0] ?? ""}"; start takes no options and runs in the current directory\n`);
    return 2;
  }
  const root = process.cwd();
  const resolved = await importProjectCore(root);
  if (!resolved.ok) {
    process.stderr.write(`kestrel start: ${resolved.message}\n`);
    return 2;
  }
  const core = resolved.core;
  try {
    const config = await core.loadConfig(resolve(root, "kestrel.config.ts"));
    const modules = await core.loadModules(root, config);
    const pipelines = await core.loadPipelines(root, config.pipelinesDir ?? "./pipelines");
    const kestrel = await core.boot({ config, modules, pipelines, logger: core.consoleLogger, root });
    await kestrel.start();
    installFatalHandlers(core, kestrel);
    installShutdown(core, kestrel);
    core.consoleLogger.info("kestrel started", { modules: modules.length, pipelines: kestrel.pipelines.size, triggers: kestrel.config.triggers.length });
    return undefined;
  } catch (err) {
    const host = hostPackage(root);
    const hint = host === undefined ? {} : { hint: `this project is started by its host package "${host}"` };
    if (err instanceof core.KestrelBootError) {
      core.consoleLogger.error("boot failed", { module: err.module, reason: err.reason, ...hint });
    } else {
      core.consoleLogger.error("boot failed", { error: err instanceof Error ? (err.stack ?? err.message) : String(err), ...hint });
    }
    process.exit(1);
  }
}
