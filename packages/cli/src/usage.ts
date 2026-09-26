import { readFileSync } from "node:fs";

export const USAGE = `usage: kestrel [command] [options]

commands:
  start      start the project in the current directory (the default)
  check      check the project's boot without starting it
  explain    show a pipeline or an event: steps, emitted events, listeners, delivery
  manifest   print the project's manifest: modules, contracts, pipelines, triggers
  openapi    write an OpenAPI 3.1 document for the project's HTTP triggers
  upgrade    check, fix or data: the major-version upgrade assistant
  help       show this text, or a command's usage

kestrel --version prints the version; kestrel help <command> shows a command's options.`;

export const COMMAND_USAGE: Readonly<Record<string, string>> = {
  start: "usage: kestrel [start]\n\nStarts the project in the current directory. Takes no options.",
  check: "usage: kestrel check [--root <dir>] [--json] [--fail-on error|warning] [--run-setup <use>]... [--no-plugins]",
  explain: "usage: kestrel explain <pipeline> [--json | --mermaid] [--depth <n>] [--root <dir>] [--run-setup <use>]... [--no-plugins]\n       kestrel explain --event <name> [--json | --mermaid] [--depth <n>] [--root <dir>] [--run-setup <use>]... [--no-plugins]",
  manifest: "usage: kestrel manifest [--json] [--root <dir>] [--run-setup <use>]... [--no-plugins]",
  openapi: "usage: kestrel openapi [--out <file>] [--title <t>] [--version <v>] [--server <url>] [--mount <path>] [--root <dir>] [--run-setup <use>]... [--no-plugins]",
  upgrade: "usage: kestrel upgrade check|fix|data [options] [--no-plugins]\n\nSee docs/upgrading.md for the options of each subcommand.",
};

/** The version of the running kestrel-cli, read from its own package.json. */
export function cliVersion(): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg === "object" && pkg !== null && "version" in pkg && typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
