import { continueDeploy } from "./deploy.ts";
import { migrateCopy } from "./migrate.ts";
import { retire } from "./retire.ts";
import { rollback } from "./rollback.ts";
import { waitForSeal } from "./seal.ts";
import type { UpdateSteps } from "./types.ts";
import { verifyRelease } from "./verify.ts";

/** The real steps every phase uses from the others; tests of one phase replace the ones it does not test. */
export function defaultSteps(): UpdateSteps {
  return { waitForSeal, migrateCopy, verify: verifyRelease, rollback, retire, continueDeploy };
}
