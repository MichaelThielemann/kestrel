import { readFileSync } from "node:fs";

export const USAGE = `usage: kestrel [command] [options]

commands:
  start      start the project in the current directory (the default)
  check      check the project's boot without starting it
  explain    show a pipeline or an event: steps, emitted events, listeners, delivery
  manifest   print the project's manifest: modules, contracts, pipelines, triggers
  openapi    write an OpenAPI 3.1 document for the project's HTTP triggers
  upgrade    check, fix, data or migrate: the major-version upgrade assistant
  status     the state of an environment: app, replica, backups, open runs and locks
  backup     create, list, verify or prune verified backups of an environment
  restore    restore a backup over an environment, or into a local directory
  update     prepare, accept, roll back or resume an update of an environment
  help       show this text, or a command's usage

status, backup, restore and update need @michaelthielemann/kestrel-ops in the project and read
kestrel.environments.json. kestrel --version prints the version; kestrel help <command> shows a
command's options.`;

export const COMMAND_USAGE: Readonly<Record<string, string>> = {
  start: "usage: kestrel [start]\n\nStarts the project in the current directory. Takes no options.",
  check: "usage: kestrel check [--root <dir>] [--json] [--fail-on error|warning] [--run-setup <use>]... [--no-plugins]",
  explain: "usage: kestrel explain <pipeline> [--json | --mermaid] [--depth <n>] [--root <dir>] [--run-setup <use>]... [--no-plugins]\n       kestrel explain --event <name> [--json | --mermaid] [--depth <n>] [--root <dir>] [--run-setup <use>]... [--no-plugins]",
  manifest: "usage: kestrel manifest [--json] [--root <dir>] [--run-setup <use>]... [--no-plugins]",
  openapi: "usage: kestrel openapi [--out <file>] [--title <t>] [--version <v>] [--server <url>] [--mount <path>] [--root <dir>] [--run-setup <use>]... [--no-plugins]",
  upgrade: "usage: kestrel upgrade check|fix|data [options] [--no-plugins]\n       kestrel upgrade migrate --db <copy> --blobs-dir <dir> [--root <dir>] [--plan] [--answers <file>] [--media-prefix <prefix>] [--originals-gone] [--json]\n\nSee docs/upgrading.md for the options of each subcommand.",
  status: "usage: kestrel status [--env <name>] [--json]\n\nNeeds @michaelthielemann/kestrel-ops in the project.\nexit codes: 0 no problem, 1 a problem found, 2 usage or configuration error",
  backup: "usage: kestrel backup create [--freeze] [--kind manual|scheduled|cutover]\n       kestrel backup list\n       kestrel backup verify <id>\n       kestrel backup prune [--dry-run]\n\nNeeds @michaelthielemann/kestrel-ops in the project.\n\ncommon options: --env <name>, --json, --yes, --answers <file>, --keep, --break-lock\nexit codes: 0 done, 1 a check failed or a step was refused, 2 usage or configuration error",
  restore: "usage: kestrel restore --backup <id> [--no-safety-backup]\n       kestrel restore --to local <dir> (--backup <id> | --latest) [--with-media] [--keep-sessions]\n\nNeeds @michaelthielemann/kestrel-ops in the project.\n\ncommon options: --env <name>, --json, --yes, --answers <file>, --keep, --break-lock\nexit codes: 0 done, 1 a check failed or a step was refused, 2 usage or configuration error",
  update: "usage: kestrel update prepare [--full-media]\n       kestrel update accept [--run <id>]\n       kestrel update rollback [--run <id>]\n       kestrel update status [--run <id>]\n       kestrel update resume [--run <id>]\n       kestrel update abort [--run <id>]\n       kestrel update cleanup [--run <id>] [--dry-run]\n\nNeeds a @michaelthielemann/kestrel-ops in the project that brings the update assistant.\n\ncommon options: --env <name>, --json, --yes, --answers <file>, --keep, --break-lock\nexit codes: 0 done, 1 a check failed, a step was refused or the run halted, 2 usage or configuration error, 3 the update was rolled back",
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
