import { pipelineSteps } from "@michaelthielemann/kestrel/definePipeline";
import { insertPipelineStep } from "./edits.ts";
import type { Rule, RuleContext } from "./plugin.ts";
import type { Edit, Finding, FindingLocation } from "./report.ts";
import { fileForPipeline, finding, hasModule, upgradingDocs } from "./ruleHelpers.ts";

const RULE_ID = "pipelines/verified-user";

function questionId(pipeline: string): string {
  return `verified-user-path:${pipeline}`;
}

function triggerKinds(ctx: RuleContext, pipeline: string): { hasHttp: boolean; hasEvent: boolean } {
  let hasHttp = false;
  let hasEvent = false;
  for (const t of ctx.project.input.config.triggers) {
    if (t.pipeline !== pipeline) continue;
    if ("http" in t) hasHttp = true;
    if ("event" in t) hasEvent = true;
  }
  return { hasHttp, hasEvent };
}

function locationOf(pipeline: string, file: string | undefined): FindingLocation {
  return file === undefined ? { pipeline } : { pipeline, file };
}

/** A pipeline calling `revisions.reassignAuthor` needs a preceding `authn.verifyUser:<path>`, which authn-multi alone provides. */
export const verifiedUserRule: Rule = {
  id: RULE_ID,
  check(ctx) {
    const findings: Finding[] = [];
    for (const def of ctx.project.input.pipelines) {
      const steps = pipelineSteps(def.steps);
      const targetIndex = steps.findIndex((s) => s.split(":")[0] === "revisions.reassignAuthor");
      if (targetIndex === -1) continue;
      if (steps.slice(0, targetIndex).some((s) => s.startsWith("authn.verifyUser:"))) continue;

      const file = fileForPipeline(ctx, def.name);
      const where = locationOf(def.name, file);
      const message = `pipeline "${def.name}" calls revisions.reassignAuthor without a preceding authn.verifyUser step`;

      if (!hasModule(ctx, "authn-multi")) {
        const suggestion = hasModule(ctx, "authn-single") ? "authn-single has no verifyUser step; verify the target user by hand before this step" : "add authn-multi, or verify the target user by hand before this step";
        findings.push(finding(`${RULE_ID}:${def.name}`, RULE_ID, message, suggestion, where, undefined, upgradingDocs("pipelines-verified-user")));
        continue;
      }

      const { hasHttp, hasEvent } = triggerKinds(ctx, def.name);
      const answer = ctx.answers.get(questionId(def.name));
      if (answer === "other" || answer === "split manually") {
        findings.push(finding(`${RULE_ID}:${def.name}`, RULE_ID, message, "left manual: pick authn.verifyUser's path by hand and insert it before revisions.reassignAuthor", where, undefined, upgradingDocs("pipelines-verified-user")));
        continue;
      }
      let path: string | undefined;
      if (hasEvent && !hasHttp) path = "result.reassignTo";
      else if (hasHttp && !hasEvent) path = "reassignTo";
      else if (answer !== undefined) path = answer;

      if (path === undefined) {
        findings.push({
          id: `${RULE_ID}:${def.name}`,
          rule: RULE_ID,
          severity: "error",
          tier: "source",
          where,
          message: `${message}, and its triggers do not decide the path by themselves`,
          suggestion: "choose where authn.verifyUser reads the target user id from",
          fix: { kind: "ask", question: questionId(def.name), prompt: "authn.verifyUser reads which path?", choices: ["reassignTo", "result.reassignTo", "other", "split manually"], closedChoices: true, defaultValue: "reassignTo" },
          docs: upgradingDocs("pipelines-verified-user"),
        });
        continue;
      }

      const edits: Edit[] = [];
      const source = file === undefined ? undefined : ctx.readFile(file);
      if (file !== undefined && source !== undefined) {
        const edit = insertPipelineStep(file, source, { pipelineName: def.name, anchorStep: "revisions.reassignAuthor", position: "before", newStep: `authn.verifyUser:${path}`, ...(ctx.locateSteps === undefined ? {} : { locateSteps: ctx.locateSteps }) });
        if (edit) edits.push(edit);
      }
      findings.push(finding(`${RULE_ID}:${def.name}`, RULE_ID, message, `insert authn.verifyUser:${path} before revisions.reassignAuthor (it now rejects an unknown or inactive target with 404/400, where 5.8 accepted one)`, where, edits, upgradingDocs("pipelines-verified-user")));
    }
    return findings;
  },
};
