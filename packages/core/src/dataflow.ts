import { KestrelBootError } from "./errors.ts";
import type { ResolvedPipeline } from "./runner.ts";
import type { Route } from "./triggers/http.ts";

const CONTEXT_KEYS = ["payload", "headers", "files", "ip", "params"] as const;

function routeParams(route: Route): Set<string> {
  const names = new Set<string>();
  for (const segment of route.segments) {
    if (segment.startsWith(":") || segment.startsWith("*")) names.add(segment.slice(1));
  }
  return names;
}

/** Only a param every route binds is guaranteed to be there, whichever route served the run. */
function commonParams(routes: readonly Route[]): string[] {
  const [first, ...rest] = routes;
  if (first === undefined) return [];
  return [...routeParams(first)].filter((name) => rest.every((route) => routeParams(route).has(name)));
}

function satisfied(read: string, available: ReadonlySet<string>): boolean {
  if (available.has(read)) return true;
  for (const written of available) {
    if (read.startsWith(`${written}.`) || written.startsWith(`${read}.`)) return true;
  }
  return false;
}

/** A plain write of a parent path replaces whatever was written under it. */
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

  for (const step of pipeline.steps) {
    for (const read of step.description.reads) {
      // The client owns the payload; the dev validator checks it against describe().input instead.
      if (read.startsWith("payload.")) continue;
      let ok: boolean;
      if (read.startsWith("params.")) {
        // An event envelope carries opaque params, so it can satisfy any of them; a pipeline with
        // no trigger at all is only reachable through run(), where the caller supplies them.
        ok = available.has(read) || hasEventTrigger || (httpRoutes.length === 0 && !hasCronTrigger);
      } else {
        ok = satisfied(read, available);
      }
      if (!ok) {
        throw new KestrelBootError(`pipelines/${pipeline.name}`, `step "${step.name}" reads "${read}" but no earlier step writes it (earlier writes: ${written.size === 0 ? "none" : [...written].join(", ")})`);
      }
    }
    for (const write of step.description.writes) apply(write, [available, written]);
  }
}
