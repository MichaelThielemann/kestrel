/** How a flag takes its value: one string, none, or a string that may repeat. */
export type FlagKind = "string" | "boolean" | "repeat";

export interface StrictArgs {
  strings: Map<string, string>;
  booleans: Set<string>;
  repeated: Map<string, string[]>;
  positionals: string[];
}

export type ParseResult = { ok: true; args: StrictArgs } | { ok: false; error: string };

/** Parses argv against a fixed flag table: an unknown flag, a missing value or too many positionals is an error. */
export function parseStrict(argv: readonly string[], flags: Readonly<Record<string, FlagKind>>, maxPositionals: number): ParseResult {
  const args: StrictArgs = { strings: new Map(), booleans: new Set(), repeated: new Map(), positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--") || token === "--") {
      if (token.startsWith("-") && token !== "-") return { ok: false, error: `unknown option "${token}"` };
      args.positionals.push(token);
      if (args.positionals.length > maxPositionals) return { ok: false, error: `unexpected argument "${token}"` };
      continue;
    }
    const eq = token.indexOf("=");
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const kind = flags[name];
    if (kind === undefined) return { ok: false, error: `unknown option "--${name}"` };
    if (kind === "boolean") {
      if (eq !== -1) return { ok: false, error: `option "--${name}" takes no value` };
      args.booleans.add(name);
      continue;
    }
    let value: string | undefined;
    if (eq !== -1) value = token.slice(eq + 1);
    else {
      value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return { ok: false, error: `option "--${name}" needs a value` };
      i++;
    }
    if (kind === "repeat") args.repeated.set(name, [...(args.repeated.get(name) ?? []), value]);
    else args.strings.set(name, value);
  }
  return { ok: true, args };
}
