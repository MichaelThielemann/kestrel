#!/usr/bin/env node
import { runUpgradeCli } from "./plugin.ts";

runUpgradeCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
  });
