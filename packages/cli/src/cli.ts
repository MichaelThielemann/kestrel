#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { dispatch } from "./dispatch.ts";

try {
  const code = await dispatch(process.argv.slice(2));
  if (code !== undefined) process.exitCode = code;
} catch (err) {
  process.stderr.write(`kestrel: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 2;
}
