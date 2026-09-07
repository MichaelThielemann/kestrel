#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { resolve } from "node:path";
import { boot, type Kestrel } from "./boot.ts";
import { boundaryCast } from "./cast.ts";
import { KestrelBootError } from "./errors.ts";
import { loadConfig, loadModules, loadPipelines } from "./load.ts";
import { consoleLogger } from "./logger.ts";

const root = process.cwd();
const FATAL_TIMEOUT_MS = 5_000;
const FATAL_HANDLERS = Symbol.for("kestrel.fatalHandlers");

function installFatalHandlers(kestrel: Kestrel): void {
  const installed = boundaryCast<Record<symbol, boolean>>(process, "host");
  if (installed[FATAL_HANDLERS]) return;
  installed[FATAL_HANDLERS] = true;
  const fatal = (event: "unhandledRejection" | "uncaughtException") => (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    consoleLogger.error(event, { reason: error.message, stack: error.stack ?? null });
    const exit = () => process.exit(1);
    void kestrel.stop({ timeoutMs: FATAL_TIMEOUT_MS }).then(exit, exit);
  };
  process.on("unhandledRejection", fatal("unhandledRejection"));
  process.on("uncaughtException", fatal("uncaughtException"));
}

try {
  const config = await loadConfig(resolve(root, "kestrel.config.ts"));
  const modules = await loadModules(root, config);
  const pipelines = await loadPipelines(root, config.pipelinesDir ?? "./pipelines");
  const kestrel = await boot({ config, modules, pipelines, logger: consoleLogger, root });
  await kestrel.start();
  consoleLogger.info("kestrel started", { modules: modules.length, pipelines: kestrel.pipelines.size, triggers: kestrel.config.triggers.length });
  installFatalHandlers(kestrel);

  const shutdown = (signal: string) => () => {
    consoleLogger.info("kestrel stopping", { signal });
    void kestrel.stop().then(
      ({ drained }) => {
        if (!drained) consoleLogger.error("shutdown deadline hit, closing anyway", { signal });
        process.exit(drained ? 0 : 1);
      },
      (err: unknown) => {
        consoleLogger.error("shutdown failed", { signal, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", shutdown("SIGINT"));
  process.once("SIGTERM", shutdown("SIGTERM"));
} catch (err) {
  if (err instanceof KestrelBootError) {
    consoleLogger.error("boot failed", { module: err.module, reason: err.reason });
  } else {
    consoleLogger.error("boot failed", { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  }
  process.exit(1);
}
