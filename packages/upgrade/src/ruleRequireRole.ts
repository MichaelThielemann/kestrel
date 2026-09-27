import { pipelineSteps } from "@michaelthielemann/kestrel/definePipeline";
import { insertPipelineStep } from "./edits.ts";
import type { Rule } from "./plugin.ts";
import type { Edit, Finding } from "./report.ts";
import { fileForPipeline, finding, moduleEntry, upgradingDocs } from "./ruleHelpers.ts";

const RULE_ID = "pipelines/require-role";
const DEFAULT_ROLELESS = ["me", "logout"];

function rolelessPipelines(config: unknown): readonly string[] {
  if (typeof config !== "object" || config === null || !("rolelessPipelines" in config)) return DEFAULT_ROLELESS;
  const named: unknown = config.rolelessPipelines;
  return Array.isArray(named) && named.every((n): n is string => typeof n === "string") ? named : DEFAULT_ROLELESS;
}

/** With authz-roles, every pipeline that runs `authn.requireUser` must run `authz.requireRole` after it, except the ones `rolelessPipelines` names. */
export const requireRoleRule: Rule = {
  id: RULE_ID,
  check(ctx) {
    const authz = moduleEntry(ctx, "authz-roles");
    if (authz === undefined) return [];
    const open = new Set(rolelessPipelines(authz.config));
    const findings: Finding[] = [];
    for (const def of ctx.project.input.pipelines) {
      if (open.has(def.name)) continue;
      const steps = pipelineSteps(def.steps);
      const signIn = steps.indexOf("authn.requireUser");
      if (signIn === -1 || steps.slice(signIn + 1).includes("authz.requireRole")) continue;
      const file = fileForPipeline(ctx, def.name);
      const edits: Edit[] = [];
      const source = file === undefined ? undefined : ctx.readFile(file);
      if (file !== undefined && source !== undefined) {
        const edit = insertPipelineStep(file, source, { pipelineName: def.name, anchorStep: "authn.requireUser", position: "after", newStep: "authz.requireRole", ...(ctx.locateSteps === undefined ? {} : { locateSteps: ctx.locateSteps }) });
        if (edit) edits.push(edit);
      }
      findings.push(
        finding(
          `${RULE_ID}:${def.name}`,
          RULE_ID,
          `pipeline "${def.name}" runs authn.requireUser without authz.requireRole after it; authz-roles refuses to boot such a pipeline, since it would serve an account without a configured role`,
          "insert authz.requireRole after authn.requireUser, or name the pipeline in authz-roles' rolelessPipelines when any signed-in account may run it",
          file === undefined ? { pipeline: def.name } : { pipeline: def.name, file },
          edits,
          upgradingDocs("pipelines-require-role"),
        ),
      );
    }
    return findings;
  },
};
