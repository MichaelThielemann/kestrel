import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OBJECT_BINDING_REGISTRY } from "./objectBinding.waivers.ts";

export const OBJECT_BINDING_PROOF_FILE = join(process.cwd(), "node_modules", ".cache", "kestrel-object-binding-proofs.ndjson");

function isFilteredRun(): boolean {
  return process.argv.slice(2).some((arg) => !arg.startsWith("-") && arg !== "run");
}

export default function setup(): () => void {
  rmSync(OBJECT_BINDING_PROOF_FILE, { force: true });
  return () => {
    if (isFilteredRun()) return;
    const proven = existsSync(OBJECT_BINDING_PROOF_FILE) ? new Set(readFileSync(OBJECT_BINDING_PROOF_FILE, "utf8").split("\n").filter(Boolean)) : new Set<string>();
    const missing = Object.entries(OBJECT_BINDING_REGISTRY)
      .filter(([, entry]) => entry.kind === "test")
      .map(([key]) => key)
      .filter((key) => !proven.has(key));
    if (missing.length > 0) throw new Error(`objectBinding: these registry test references never called provesObjectBinding(): ${missing.join(", ")}`);
  };
}
