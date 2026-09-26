import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateOpenApi } from "@michaelthielemann/kestrel-openapi";
import { parseStrict } from "../args.ts";
import { withProject } from "../inspectProject.ts";
import { COMMAND_USAGE } from "../usage.ts";

function fail(message: string): number {
  process.stderr.write(`kestrel openapi: ${message}\n\n${COMMAND_USAGE.openapi ?? ""}\n`);
  return 2;
}

function packageInfo(root: string): { name?: string; version?: string } {
  try {
    const pkg: unknown = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    if (typeof pkg !== "object" || pkg === null) return {};
    const name = "name" in pkg && typeof pkg.name === "string" ? { name: pkg.name } : {};
    const version = "version" in pkg && typeof pkg.version === "string" ? { version: pkg.version } : {};
    return { ...name, ...version };
  } catch {
    return {};
  }
}

/** `kestrel openapi`: boots the sandboxed project without HTTP and writes its OpenAPI 3.1 document. */
export async function run(argv: readonly string[]): Promise<number> {
  const parsed = parseStrict(argv, { out: "string", title: "string", version: "string", server: "string", mount: "string", root: "string", "run-setup": "repeat", "no-plugins": "boolean" }, 0);
  if (!parsed.ok) return fail(parsed.error);
  const { args } = parsed;
  const cwd = process.cwd();
  const root = resolve(cwd, args.strings.get("root") ?? ".");
  const out = args.strings.get("out");
  const result = await withProject({ root, runSetup: args.repeated.get("run-setup") ?? [], noPlugins: args.booleans.has("no-plugins") }, async (prepared): Promise<number> => {
    const { project, box, core } = prepared;
    if (project === undefined || box === undefined) {
      process.stderr.write(`kestrel openapi: the project did not load\n${prepared.issues.map((i) => `  ${i.file ?? i.use ?? ""}: ${i.message}`).join("\n")}\n`);
      return 2;
    }
    if (box.outside.length > 0) {
      process.stderr.write(`kestrel openapi: these modules are outside the sandbox and would run setup() against their real config:\n${box.outside.map((use) => `  ${use}`).join("\n")}\nname each with --run-setup <use> to allow it\n`);
      return 2;
    }
    let kestrel: Awaited<ReturnType<typeof core.boot>>;
    try {
      kestrel = await core.boot({ ...box.input, config: { ...box.input.config, http: null }, root: prepared.scratchDir, logger: core.silentLogger });
    } catch (err) {
      const detail = err instanceof core.KestrelBootError ? { module: err.module, reason: err.reason } : { error: err instanceof Error ? err.message : String(err) };
      process.stderr.write(`${JSON.stringify({ level: "error", msg: "boot failed", ...detail })}\n`);
      return 1;
    }
    try {
      const pkg = packageInfo(root);
      const server = args.strings.get("server");
      const mount = args.strings.get("mount");
      const doc = generateOpenApi(kestrel, {
        title: args.strings.get("title") ?? pkg.name ?? "Kestrel",
        version: args.strings.get("version") ?? pkg.version ?? "0.0.0",
        ...(server === undefined ? {} : { servers: [server] }),
        ...(mount === undefined ? {} : { mountPath: mount }),
      });
      const json = JSON.stringify(doc, null, 2) + "\n";
      if (out === undefined) process.stdout.write(json);
      else {
        writeFileSync(resolve(cwd, out), json);
        const count = typeof doc.paths === "object" && doc.paths !== null ? Object.keys(doc.paths).length : 0;
        process.stderr.write(`wrote ${out} (${count} paths)\n`);
      }
      return 0;
    } finally {
      await kestrel.stop();
    }
  });
  if (!result.ok) {
    process.stderr.write(`kestrel openapi: ${result.kind === "refused" ? result.message : result.outdated.map((o) => o.message).join("\n")}\n`);
    return 2;
  }
  return result.value;
}
