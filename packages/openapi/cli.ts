#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { boot, loadConfig, loadModules, loadPipelines, silentLogger } from "@michaelthielemann/kestrel";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { generateOpenApi } from "./index.ts";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const root = process.cwd();
const pkg = boundaryCast<{ name?: string; version?: string }>(
  JSON.parse(
    await readFile(resolve(root, "package.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "{}";
      throw error;
    }),
  ),
  "json",
);

const server = option("--server");
const mount = option("--mount");
const config = await loadConfig(resolve(root, "kestrel.config.ts"));
const modules = await loadModules(root, config);
const pipelines = await loadPipelines(root, config.pipelinesDir ?? "./pipelines");
const kestrel = await boot({ config: { ...config, http: null }, modules, pipelines, logger: silentLogger });
const doc = generateOpenApi(kestrel, {
  title: option("--title") ?? pkg.name ?? "Kestrel",
  version: option("--version") ?? pkg.version ?? "0.0.0",
  ...(server === undefined ? {} : { servers: [server] }),
  ...(mount === undefined ? {} : { mountPath: mount }),
});
const json = JSON.stringify(doc, null, 2) + "\n";
const out = option("--out");
if (out === undefined) process.stdout.write(json);
else {
  await writeFile(resolve(root, out), json);
  const count = typeof doc.paths === "object" && doc.paths !== null ? Object.keys(doc.paths).length : 0;
  process.stderr.write(`wrote ${out} (${count} paths)\n`);
}
await kestrel.stop();
