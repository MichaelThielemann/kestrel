/** The upgrade commands' parsed flags: `--name value`, or `--name` alone as `true`; `--run-setup` collects every value. */
export interface ParsedArgs {
  flags: Map<string, string | true>;
  repeated: Map<string, string[]>;
}

const REPEATABLE = new Set(["run-setup"]);

/** Parses argv the permissive way the upgrade commands do: positionals and unknown flags are accepted and ignored. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const repeated = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    const takesValue = next !== undefined && !next.startsWith("--");
    if (REPEATABLE.has(name)) {
      const list = repeated.get(name) ?? [];
      if (takesValue) {
        list.push(next);
        i++;
      }
      repeated.set(name, list);
      continue;
    }
    if (takesValue) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }
  return { flags, repeated };
}

/** The string value of a flag, `undefined` when absent or given without a value. */
export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || typeof args.flags.get(name) === "string";
}
