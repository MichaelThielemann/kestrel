import { logWarn, type Logger } from "../logger.ts";
import type { Runner } from "../runner.ts";
import { cronMatches, parseCron, type CronSpec } from "./cronMatch.ts";

export interface CronEntry {
  expression: string;
  spec: CronSpec;
  pipeline: string;
}

export function createCronEntry(expression: string, pipeline: string): CronEntry {
  return { expression, spec: parseCron(expression), pipeline };
}

export function startCron(entries: readonly CronEntry[], run: Runner, logger: Logger, now: () => Date = () => new Date()): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const running = new Set<string>();

  const tick = () => {
    const date = now();
    for (const entry of entries) {
      if (!cronMatches(entry.spec, date)) continue;
      if (running.has(entry.pipeline)) {
        logWarn(logger, `cron "${entry.expression}" skipped: pipeline "${entry.pipeline}" is still running`, { cron: entry.expression, pipeline: entry.pipeline });
        continue;
      }
      running.add(entry.pipeline);
      void run(entry.pipeline, { trigger: { kind: "cron", name: entry.expression } })
        .then(
          (res) => {
            if (res.status >= 400) logger.error(`cron "${entry.expression}" pipeline "${entry.pipeline}" ended with ${res.status}`, { runId: res.runId, error: res.error });
          },
          (err: unknown) => {
            logger.error(`cron "${entry.expression}" pipeline "${entry.pipeline}" threw`, { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
          },
        )
        .finally(() => running.delete(entry.pipeline));
    }
    schedule();
  };
  const schedule = () => {
    if (stopped) return;
    const ms = 60_000 - (now().getTime() % 60_000);
    timer = setTimeout(tick, ms);
    timer.unref();
  };

  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
