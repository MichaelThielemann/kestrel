import type { ModuleDefinition } from "./defineModule.ts";
import { throwSink, type Sink } from "./sink.ts";

export interface SortResult {
  ordered: ModuleDefinition[];
  /** Modules left out of `ordered` because of a problem on their own or on a dependency's path, with the reason. Empty for the default (throwing) sink, since it never returns after a problem. */
  excluded: Map<ModuleDefinition, string>;
}

/**
 * Orders modules by dependency. With a collecting sink, a module involved in a problem — its own,
 * or a dependency's — is left out of `ordered` and recorded in `excluded` instead of aborting the
 * whole sort; the default sink throws on the first problem.
 */
export function sortModules(modules: readonly ModuleDefinition[], sink: Sink = throwSink()): SortResult {
  const excluded = new Map<ModuleDefinition, string>();
  const exclude = (m: ModuleDefinition, reason: string): void => {
    if (!excluded.has(m)) excluded.set(m, reason);
  };

  const providerOf = new Map<string, ModuleDefinition>();
  for (const m of modules) {
    for (const contract of m.provides) {
      const other = providerOf.get(contract.name);
      if (other) {
        const reason = `contract "${contract.name}" is already provided by ${other.name}`;
        sink.fail("contract-provided-twice", m.name, reason);
        exclude(m, reason);
        continue;
      }
      providerOf.set(contract.name, m);
    }
  }

  for (const m of modules) {
    for (const contract of m.before ?? []) {
      if (!m.requires.some((c) => c.name === contract.name)) continue;
      const reason = `declares before "${contract.name}" and requires "${contract.name}"; a module cannot require what it must be set up before`;
      sink.fail("before-and-requires", m.name, reason);
      exclude(m, reason);
    }
  }

  const dependsOn = new Map<ModuleDefinition, ModuleDefinition[]>();
  for (const m of modules) {
    const deps: ModuleDefinition[] = [];
    for (const contract of m.requires) {
      const provider = providerOf.get(contract.name);
      if (!provider) {
        const reason = `requires "${contract.name}" but no active module provides it`;
        sink.fail("missing-provider", m.name, reason);
        exclude(m, reason);
        continue;
      }
      if (provider === m) {
        const reason = `requires "${contract.name}" which it provides itself`;
        sink.fail("provides-itself", m.name, reason);
        exclude(m, reason);
        continue;
      }
      deps.push(provider);
    }
    for (const contract of m.optional ?? []) {
      const provider = providerOf.get(contract.name);
      if (!provider) continue;
      if (provider === m) {
        const reason = `optional "${contract.name}" which it provides itself`;
        sink.fail("provides-itself", m.name, reason);
        exclude(m, reason);
        continue;
      }
      deps.push(provider);
    }
    dependsOn.set(m, deps);
  }

  for (const m of modules) {
    for (const contract of m.before ?? []) {
      const provider = providerOf.get(contract.name);
      if (!provider || provider === m) continue;
      dependsOn.get(provider)?.push(m);
    }
  }

  const hook = modules.find((m) => m.triggers?.event !== undefined);
  if (hook) {
    const needed = new Set<ModuleDefinition>();
    const collect = (m: ModuleDefinition): void => {
      if (needed.has(m)) return;
      needed.add(m);
      for (const d of dependsOn.get(m) ?? []) collect(d);
    };
    collect(hook);
    for (const m of modules) {
      if (needed.has(m)) continue;
      if ((m.emits ?? []).length === 0) continue;
      dependsOn.get(m)?.push(hook);
    }
  }

  const sorted: ModuleDefinition[] = [];
  const state = new Map<ModuleDefinition, "visiting" | "done">();
  const visit = (m: ModuleDefinition, path: string[]): void => {
    if (excluded.has(m)) return;
    const s = state.get(m);
    if (s === "done") return;
    if (s === "visiting") {
      const fullPath = [...path, m.name];
      const reason = `dependency cycle: ${fullPath.join(" -> ")}`;
      sink.fail("dependency-cycle", m.name, reason);
      const start = path.indexOf(m.name);
      const cycleNames = start === -1 ? fullPath : [...path.slice(start), m.name];
      for (const name of cycleNames) {
        const member = modules.find((candidate) => candidate.name === name);
        if (member) exclude(member, reason);
      }
      return;
    }
    state.set(m, "visiting");
    for (const dep of dependsOn.get(m) ?? []) visit(dep, [...path, m.name]);
    state.set(m, "done");
    if (!excluded.has(m)) sorted.push(m);
  };
  for (const m of modules) visit(m, []);

  let changed = true;
  while (changed) {
    changed = false;
    for (const m of modules) {
      if (excluded.has(m)) continue;
      const bad = (dependsOn.get(m) ?? []).find((dep) => excluded.has(dep));
      if (!bad) continue;
      exclude(m, `depends on "${bad.name}" which was excluded: ${excluded.get(bad)}`);
      changed = true;
    }
  }

  return { ordered: sorted.filter((m) => !excluded.has(m)), excluded };
}
