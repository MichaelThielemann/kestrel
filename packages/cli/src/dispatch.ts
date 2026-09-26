import { COMMAND_USAGE, USAGE, cliVersion } from "./usage.ts";

const COMMANDS = new Set(["start", "check", "explain", "manifest", "openapi", "upgrade"]);
const EXTENSION = import.meta.url.endsWith(".ts") ? ".ts" : ".js";

interface CommandModule {
  run(argv: readonly string[]): Promise<number | undefined>;
}

function isCommandModule(value: unknown): value is CommandModule {
  return typeof value === "object" && value !== null && "run" in value && typeof value.run === "function";
}

async function runCommand(name: string, argv: readonly string[]): Promise<number | undefined> {
  // eslint-disable-next-line no-restricted-syntax
  const mod: unknown = await import(`./commands/${name}${EXTENSION}`);
  if (!isCommandModule(mod)) throw new Error(`command module "${name}" has no run()`);
  return mod.run(argv);
}

/** Runs one kestrel command; resolves to the exit code, or `undefined` while a started server keeps the process alive. */
export async function dispatch(argv: readonly string[]): Promise<number | undefined> {
  const [first, ...rest] = argv;
  if (first === undefined) return runCommand("start", []);
  if (first === "--help" || first === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (first === "help") {
    const topic = rest[0];
    const text = topic === undefined ? USAGE : COMMAND_USAGE[topic];
    if (text === undefined) {
      process.stderr.write(`kestrel: unknown command "${topic ?? ""}"\n\n${USAGE}\n`);
      return 2;
    }
    process.stdout.write(`${text}\n`);
    return 0;
  }
  if (first === "--version" || first === "-v") {
    process.stdout.write(`${cliVersion()}\n`);
    return 0;
  }
  if (!COMMANDS.has(first)) {
    process.stderr.write(`kestrel: unknown command "${first}"\n\n${USAGE}\n`);
    return 2;
  }
  return runCommand(first, rest);
}
