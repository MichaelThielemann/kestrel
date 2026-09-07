import type { ModuleDefinition } from "./defineModule.ts";
import { KestrelBootError } from "./errors.ts";

export function sortModules(modules: readonly ModuleDefinition[]): ModuleDefinition[] {
  const providerOf = new Map<string, ModuleDefinition>();
  for (const m of modules) {
    for (const contract of m.provides) {
      const other = providerOf.get(contract.name);
      if (other) throw new KestrelBootError(m.name, `contract "${contract.name}" is already provided by ${other.name}`);
      providerOf.set(contract.name, m);
    }
  }

  const dependsOn = new Map<ModuleDefinition, ModuleDefinition[]>();
  for (const m of modules) {
    const deps: ModuleDefinition[] = [];
    for (const contract of m.requires) {
      const provider = providerOf.get(contract.name);
      if (!provider) throw new KestrelBootError(m.name, `requires "${contract.name}" but no active module provides it`);
      if (provider === m) throw new KestrelBootError(m.name, `requires "${contract.name}" which it provides itself`);
      deps.push(provider);
    }
    for (const contract of m.optional ?? []) {
      const provider = providerOf.get(contract.name);
      if (!provider) continue;
      if (provider === m) throw new KestrelBootError(m.name, `optional "${contract.name}" which it provides itself`);
      deps.push(provider);
    }
    dependsOn.set(m, deps);
  }

  const sorted: ModuleDefinition[] = [];
  const state = new Map<ModuleDefinition, "visiting" | "done">();
  const visit = (m: ModuleDefinition, path: string[]): void => {
    const s = state.get(m);
    if (s === "done") return;
    if (s === "visiting") throw new KestrelBootError(m.name, `dependency cycle: ${[...path, m.name].join(" -> ")}`);
    state.set(m, "visiting");
    for (const dep of dependsOn.get(m) ?? []) visit(dep, [...path, m.name]);
    state.set(m, "done");
    sorted.push(m);
  };
  for (const m of modules) visit(m, []);
  return sorted;
}
