import type { BootInput, ModuleDefinition } from "@michaelthielemann/kestrel";
import { blobstoreStandIn, providesBlobstore } from "./blobstoreStandIn.ts";
import { BUILT_IN_SANDBOX_ENTRIES, collidingSandboxEntries, KNOWN_SAFE_USES, sandboxKey } from "./sandboxTable.ts";

/**
 * Config rewrites keyed by a module-list entry's full `use` string, without a `?`/`#` suffix: a
 * package name such as `"@acme/kestrel-archive"`, whatever its scope, or a local path exactly as the
 * config writes it. Each rewrite returns the config that module's `setup()` gets inside the sandbox.
 */
export type SandboxTable = Record<string, (config: unknown, scratch: string) => unknown>;

export interface SandboxOptions {
  dir: string;
  consent?: readonly string[];
  /** Rewrites added to the built-in ones. A key the built-in table already rewrites throws, naming the key: a built-in rewrite is never replaced. */
  entries?: SandboxTable;
}

export interface SandboxResult {
  input: BootInput;
  setup: { only: readonly string[] };
  outside: readonly string[];
  replaced: readonly string[];
  /** Entries whose config was rewritten to reach only the scratch directory (a table-driven entry, or a `blobstore@1` provider swapped for a stand-in — see `replaced`). */
  rewritten: readonly string[];
  /** Entries let through unrewritten because they are known-safe (reach nothing but `persistence@1`/`blobstore@1` and need no rewrite) or named in `consent`. */
  consented: readonly string[];
}

/**
 * Rewrites the config of kestrel's own storage modules, and of every module `options.entries` names,
 * so their `setup()` reaches only the scratch directory, and reports which other modules would need
 * to run `setup()` outside the sandbox. `setup.only` also carries every known-safe entry (one that reaches nothing but `persistence@1`
 * or `blobstore@1` and needs no rewrite) plus anything named in `consent`. A module that provides
 * `blobstore@1` but is neither rewritten nor known-safe, such as a network object store, is swapped
 * for a local, filesystem-backed stand-in instead of being left outside the sandbox, so every
 * module requiring `blobstore@1` still gets checked; `replaced` names each one swapped this way.
 */
export function sandboxBootInput(input: BootInput, options: SandboxOptions): SandboxResult {
  const extra = options.entries ?? {};
  const colliding = collidingSandboxEntries(extra);
  if (colliding.length > 0) throw new Error(`sandbox entry "${colliding[0] ?? ""}" collides with a built-in rewrite; a built-in rewrite is never replaced`);
  const table: SandboxTable = { ...extra, ...BUILT_IN_SANDBOX_ENTRIES };
  const consent = new Set(options.consent ?? []);
  const only: string[] = [];
  const outside: string[] = [];
  const replaced: string[] = [];
  const rewritten: string[] = [];
  const consented: string[] = [];
  const loadedModules = [...input.modules];
  const configModules = input.config.modules.map((entry, i) => {
    const key = sandboxKey(entry.use);
    const rewrite = Object.hasOwn(table, key) ? table[key] : undefined;
    if (rewrite) {
      only.push(entry.use);
      rewritten.push(entry.use);
      return { ...entry, config: rewrite(entry.config, options.dir) };
    }
    if (KNOWN_SAFE_USES.has(key) || consent.has(entry.use)) {
      only.push(entry.use);
      consented.push(entry.use);
      return entry;
    }
    const loaded: ModuleDefinition | undefined = loadedModules[i];
    if (loaded !== undefined && providesBlobstore(loaded)) {
      only.push(entry.use);
      replaced.push(entry.use);
      rewritten.push(entry.use);
      loadedModules[i] = blobstoreStandIn(loaded.name, options.dir, loaded.configSchema);
      return entry;
    }
    outside.push(entry.use);
    return entry;
  });
  return { input: { ...input, config: { ...input.config, modules: configModules }, modules: loadedModules }, setup: { only }, outside, replaced, rewritten, consented };
}
