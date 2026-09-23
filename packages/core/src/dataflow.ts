import { KestrelBootError } from "./errors.ts";
import type { ResolvedPipeline } from "./runner.ts";
import type { Route } from "./triggers/http.ts";
import { stripOptional } from "./writes.ts";

/** The context keys every trigger supplies, whatever the pipeline; a step may read them, or a dotted child of them, with no earlier writer. */
export const CONTEXT_KEYS = ["payload", "headers", "files", "ip", "params"] as const;

function routeParams(route: Route): Set<string> {
  const names = new Set<string>();
  for (const segment of route.segments) {
    if (segment.startsWith(":") || segment.startsWith("*")) names.add(segment.slice(1));
  }
  return names;
}

function commonParams(routes: readonly Route[]): string[] {
  const [first, ...rest] = routes;
  if (first === undefined) return [];
  return [...routeParams(first)].filter((name) => rest.every((route) => routeParams(route).has(name)));
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

export function satisfied(read: string, available: ReadonlySet<string>): boolean {
  for (const written of available) {
    if (overlaps(read, written)) return true;
  }
  return false;
}

function apply(write: string, sets: readonly Set<string>[]): void {
  if (write.endsWith("?")) return;
  for (const set of sets) {
    for (const existing of [...set]) {
      if (existing.startsWith(`${write}.`)) set.delete(existing);
    }
    set.add(write);
  }
}

export function checkDataflow(pipeline: ResolvedPipeline, httpRoutes: readonly Route[], hasCronTrigger: boolean, hasEventTrigger: boolean): void {
  const available = new Set<string>(CONTEXT_KEYS);
  for (const param of commonParams(httpRoutes)) available.add(`params.${param}`);
  const written = new Set<string>();
  const optionallyWritten = new Set<string>();

  for (let i = 0; i < pipeline.steps.length; i++) {
    const step = pipeline.steps[i]!;
    for (const read of step.description.reads) {
      const optional = read.endsWith("?");
      const key = stripOptional(read);
      if (key.startsWith("payload.")) continue;
      let ok: boolean;
      if (key.startsWith("params.")) {
        ok = available.has(key) || hasEventTrigger || (httpRoutes.length === 0 && !hasCronTrigger);
      } else {
        ok = satisfied(key, available);
      }
      if (ok) continue;
      if (optional) {
        if (satisfied(key, optionallyWritten)) continue;
        const laterWriter = pipeline.steps.slice(i + 1).find((later) => later.description.writes.some((write) => overlaps(key, stripOptional(write))));
        if (laterWriter) {
          throw new KestrelBootError(`pipelines/${pipeline.name}`, `step "${step.name}" optionally reads "${key}" but step "${laterWriter.name}" writes it later`);
        }
        continue;
      }
      throw new KestrelBootError(`pipelines/${pipeline.name}`, `step "${step.name}" reads "${read}" but no earlier step writes it (earlier writes: ${written.size === 0 ? "none" : [...written].join(", ")})`);
    }
    for (const write of step.description.writes) {
      if (write.endsWith("?")) optionallyWritten.add(stripOptional(write));
      apply(write, [available, written]);
    }
  }
}
