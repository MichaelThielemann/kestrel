import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pipelineSteps } from "@michaelthielemann/kestrel/definePipeline";
import { insertPipelineStep, setModuleConfigProperties } from "./edits.ts";
import { isRecord } from "./guards.ts";
import type { Rule, RuleContext } from "./plugin.ts";
import type { Edit, Finding } from "./report.ts";
import { combineEditParts, fileForPipeline, hasModule, infoFinding, isProjectFile, moduleEntry, upgradingDocs } from "./ruleHelpers.ts";

const AUTHZ_MODULE = "authz/roles";
const FIELD_STEP = "pipelines/field-step";
const FIELD_GRANT = "authz/field-grant-unknown";
const QUESTION = "field-step";

const MISSING_STEP = /^authz\/roles: pipeline "([^"]+)" answers anonymous callers but does not end with authz\.fields:<resource>\?shape=(item|list|array|file) /;
const MISSING_GRANT = /^authz\/roles: pipeline "([^"]+)" answers anonymous callers and ends with authz\.fields:([A-Za-z][\w-]*), but anonymousFields grants nothing for /;
const OTHER_FIELD_PROBLEMS = [
  /^authz\/roles: (?:anonymousFields|fields\.\S+)\.[A-Za-z][\w-]* names "[^"]+", which no pipeline ending with authz\.fields:\S+ declares/,
  /^authz\/roles: (?:anonymousFields|fields\.\S+) grants fields of "[^"]+", but no pipeline ends with authz\.fields:/,
  /^authz\/roles: pipeline "[^"]+" runs \S+ after authz\.fields:/,
  /^authz\/roles: pipeline "[^"]+" ends with authz\.fields:\S+, but its declared output (?:is|reads as) /,
  /^authz\/roles: pipeline "[^"]+" can end at \S+ before authz\.fields:/,
];

const MEDIA_FIELDS = ["id", "path", "filename", "contentType", "size", "width", "height", "alt", "title", "description", "provenance"];
const VARIANT_FIELDS = ["variants[].size", "variants[].width", "variants[].height", "variants[].format", "variants[].path"];

function authzLines(ctx: RuleContext): string[] {
  return ctx.bootCheck.errors
    .filter((e) => e.code === "attach-failed" && e.module === AUTHZ_MODULE)
    .flatMap((e) => e.reason.replace(/^attach\(\) threw: /, "").split("\n"));
}

function nameAndArg(spec: string): { name: string; type: string } {
  const colon = spec.indexOf(":");
  if (colon === -1) return { name: spec, type: "" };
  return { name: spec.slice(0, colon), type: spec.slice(colon + 1).split("?")[0] ?? "" };
}

/** The resource of a pipeline's answer, from the step that reads it; `undefined` for a step this tool does not know. */
export function readingResource(steps: readonly string[]): string | undefined {
  for (const spec of steps) {
    const { name, type } = nameAndArg(spec);
    if (["content.get", "content.list", "site.resolve", "site.resolveLinks"].includes(name) && type !== "") return type;
    if (name === "media.get" || name === "media.list") return "media";
    if (["media.download", "media.serve", "images.serve"].includes(name)) return "mediaFile";
    if (name === "redirects.render") return "redirectRules";
  }
  return undefined;
}

function stepsOf(ctx: RuleContext, pipeline: string): string[] {
  const def = ctx.project.input.pipelines.find((p) => p.name === pipeline);
  return def === undefined ? [] : pipelineSteps(def.steps);
}

function runs(steps: readonly string[], name: string): boolean {
  return steps.some((spec) => nameAndArg(spec).name === name);
}

function contentModel(ctx: RuleContext): { types: Record<string, unknown>; localized: boolean } {
  const entry = moduleEntry(ctx, "content-default");
  const config = isRecord(entry?.config) ? entry.config : {};
  const types = isRecord(config.types) ? config.types : {};
  return { types, localized: Array.isArray(config.locales) && config.locales.length > 0 };
}

function proposedGrant(ctx: RuleContext, resource: string, pipelines: ReadonlyArray<readonly string[]>): string[] | undefined {
  const all = pipelines.flat();
  if (resource === "media") return [...MEDIA_FIELDS, ...(hasModule(ctx, "images-default") && runs(all, "images.attach") ? VARIANT_FIELDS : [])];
  if (resource === "mediaFile") return ["headers.cache-control", "headers.x-content-provenance", ...(hasModule(ctx, "images-default") ? ["headers.x-kestrel-variant"] : [])];
  if (resource === "redirectRules") return ["pattern", "target", "status"];
  const model = contentModel(ctx);
  const type = model.types[resource];
  if (!isRecord(type) || !isRecord(type.fields)) return undefined;
  const paths = ["id", ...Object.keys(type.fields)];
  if (model.localized) paths.push("_locales", "_translations");
  if (runs(all, "site.resolve")) paths.push("_locale", "_links");
  if (runs(all, "site.resolveLinks")) paths.push("_links");
  if (runs(all, "redirects.lookup")) paths.push("redirect");
  return [...new Set(paths)];
}

function existingGrants(ctx: RuleContext): Record<string, string[]> {
  const entry = moduleEntry(ctx, "authz-roles");
  const config = isRecord(entry?.config) ? entry.config : {};
  const grants = isRecord(config.anonymousFields) ? config.anonymousFields : {};
  return Object.fromEntries(Object.entries(grants).map(([resource, paths]): [string, string[]] => [resource, Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : []]));
}

function literalOf(grants: Record<string, readonly string[]>): string {
  const key = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));
  return `{ ${Object.entries(grants)
    .map(([resource, paths]) => `${key(resource)}: [${paths.map((p) => JSON.stringify(p)).join(", ")}]`)
    .join(", ")} }`;
}

function boot(finding: Omit<Finding, "tier" | "rule" | "docs" | "where"> & { where?: Finding["where"] }, rule: string, docs: string): Finding {
  return { ...finding, rule, tier: "boot", where: finding.where ?? { module: AUTHZ_MODULE }, docs };
}

/**
 * `pipelines/field-step`: a pipeline anonymous callers reach does not end with `authz.fields`, or its resource has no
 * anonymous field grant. Asks once, with no default, to append the step to each such pipeline and to grant the fields
 * proposed from the content model and the loaded modules.
 */
export const fieldStepRule: Rule = {
  id: FIELD_STEP,
  check(ctx) {
    const lines = authzLines(ctx);
    const missingSteps = lines.flatMap((line) => {
      const match = MISSING_STEP.exec(line);
      return match ? [{ pipeline: match[1]!, shape: match[2]! }] : [];
    });
    const missingGrants = lines.flatMap((line) => {
      const match = MISSING_GRANT.exec(line);
      return match ? [{ pipeline: match[1]!, resource: match[2]! }] : [];
    });
    if (missingSteps.length === 0 && missingGrants.length === 0) return [];

    const existing = existingGrants(ctx);
    const unknown: string[] = [];
    const steps = missingSteps.flatMap(({ pipeline, shape }) => {
      const resource = readingResource(stepsOf(ctx, pipeline));
      if (resource === undefined) {
        unknown.push(`${pipeline}: the resource of its answer`);
        return [];
      }
      return [{ pipeline, resource, step: `authz.fields:${resource}?shape=${shape}` }];
    });
    const usesByResource = new Map<string, string[][]>();
    for (const { pipeline, resource } of [...steps, ...missingGrants]) {
      if (Object.hasOwn(existing, resource)) continue;
      usesByResource.set(resource, [...(usesByResource.get(resource) ?? []), stepsOf(ctx, pipeline)]);
    }
    const proposals: Record<string, string[]> = {};
    for (const [resource, uses] of usesByResource) {
      const grant = proposedGrant(ctx, resource, uses);
      if (grant === undefined) unknown.push(`${resource}: the fields of this resource`);
      else proposals[resource] = grant;
    }

    const names = [...new Set([...missingSteps, ...missingGrants].map((p) => p.pipeline))];
    const message = `${names.map((n) => `"${n}"`).join(", ")} ${names.length === 1 ? "answers" : "answer"} anonymous callers without ending with authz.fields or without an anonymous field grant, so boot fails`;
    const plan = [
      ...(steps.length === 0 ? [] : [`end ${steps.map((s) => `${s.pipeline} → "${s.step}"`).join(", ")}`]),
      ...(Object.keys(proposals).length === 0 ? [] : [`grant anonymous callers ${Object.entries(proposals).map(([resource, paths]) => `${resource}: ${paths.join(", ")}`).join("; ")}`]),
    ].join("; and ");
    const docs = upgradingDocs("pipelines-field-step");
    const id = FIELD_STEP;

    if (unknown.length > 0) return [boot({ id, severity: "error", message, suggestion: `choose by hand for ${unknown.join("; ")}${plan === "" ? "" : `; the rest: ${plan}`}`, fix: { kind: "manual" } }, FIELD_STEP, docs)];
    const answer = ctx.answers.get(QUESTION);
    if (answer === undefined) {
      return [boot({ id, severity: "error", message, suggestion: plan, fix: { kind: "ask", question: QUESTION, prompt: `${plan}? Every field granted here is served to callers without a session`, choices: ["yes", "manual"], closedChoices: true } }, FIELD_STEP, docs)];
    }
    if (answer !== "yes") return [boot({ id, severity: "error", message, suggestion: `left manual: ${plan}`, fix: { kind: "manual" } }, FIELD_STEP, docs)];

    const parts: Record<string, Edit[] | undefined> = {};
    for (const { pipeline, step } of steps) {
      const file = fileForPipeline(ctx, pipeline);
      const source = file === undefined ? undefined : ctx.readFile(file);
      const last = stepsOf(ctx, pipeline).at(-1);
      const edit = file === undefined || source === undefined || last === undefined ? undefined : insertPipelineStep(file, source, { pipelineName: pipeline, anchorStep: last, position: "after", newStep: step, ...(ctx.locateSteps === undefined ? {} : { locateSteps: ctx.locateSteps }) });
      parts[`${pipeline}'s step list`] = edit === undefined ? undefined : [edit];
    }
    if (Object.keys(proposals).length > 0) {
      const entry = moduleEntry(ctx, "authz-roles");
      const source = ctx.readFile(ctx.project.configFile);
      parts["authz-roles' anonymousFields"] = entry === undefined || source === undefined ? undefined : setModuleConfigProperties(ctx.project.configFile, source, { use: entry.use, assignments: { anonymousFields: literalOf({ ...existing, ...proposals }) } });
    }
    const { edits, missing } = combineEditParts(parts);
    if (missing.length > 0) return [boot({ id, severity: "error", message, suggestion: `${plan} by hand; could not locate: ${missing.join(", ")}`, fix: { kind: "manual" } }, FIELD_STEP, docs)];
    return [boot({ id, severity: "error", message, suggestion: plan, fix: { kind: "auto", edits } }, FIELD_STEP, docs)];
  },
};

/** `authz/field-grant-unknown`: every other way the field grants and the pipelines do not fit together; manual, with the hint boot gives. */
export const fieldGrantUnknownRule: Rule = {
  id: FIELD_GRANT,
  check(ctx) {
    return authzLines(ctx)
      .filter((line) => OTHER_FIELD_PROBLEMS.some((pattern) => pattern.test(line)))
      .map((line, index) => {
        const hint = line.split(" – ")[1];
        return boot({ id: `${FIELD_GRANT}:${index}`, severity: "error", message: line, suggestion: hint ?? "change the grant or the pipeline so that the grant names only fields the pipeline's declared output has", fix: { kind: "manual" } }, FIELD_GRANT, upgradingDocs("authz-field-grant-unknown"));
      });
  },
};

function granted(grants: readonly string[], permission: string): boolean {
  return grants.some((grant) => grant === "*" || grant === permission || (grant.endsWith(".*") && permission.startsWith(grant.slice(0, -1))));
}

function droppedMembers(resource: string | undefined, steps: readonly string[]): string {
  if (resource === "media") return `folder, createdAt, updatedAt${runs(steps, "images.attach") ? ", available, variantCounts, variants[].bytes, variants[].state" : ""}`;
  if (resource === "mediaFile") return "every response header the grant does not name";
  if (resource === undefined) return "every member the grant does not name";
  return "createdAt, updatedAt";
}

/** `responses/anonymous-fields`: a pipeline anonymous callers reach answers them only the granted fields once it ends with `authz.fields`. */
export const anonymousFieldsRule: Rule = {
  id: "responses/anonymous-fields",
  check(ctx) {
    const entry = moduleEntry(ctx, "authz-roles");
    const config = isRecord(entry?.config) ? entry.config : {};
    const anonymous = Array.isArray(config.anonymous) ? config.anonymous.filter((p): p is string => typeof p === "string") : [];
    if (entry === undefined || anonymous.length === 0) return [];
    const findings: Finding[] = [];
    const seen = new Set<string>();
    for (const trigger of ctx.project.input.config.triggers) {
      if (!("http" in trigger) || seen.has(trigger.pipeline)) continue;
      seen.add(trigger.pipeline);
      const steps = stepsOf(ctx, trigger.pipeline);
      if (steps.length === 0 || runs(steps, "authn.requireUser") || runs(steps, "authn.login")) continue;
      if (nameAndArg(steps.at(-1)!).name === "authz.fields") continue;
      const permissions = steps.filter((s) => nameAndArg(s).name === "authz.require").map((s) => s.slice("authz.require:".length));
      if (!permissions.every((permission) => granted(anonymous, permission))) continue;
      const resource = readingResource(steps);
      if (resource === "redirectRules") continue;
      const file = fileForPipeline(ctx, trigger.pipeline);
      findings.push(
        infoFinding(
          `responses/anonymous-fields:${trigger.pipeline}`,
          "responses/anonymous-fields",
          `pipeline "${trigger.pipeline}" (${trigger.http}) answers anonymous callers; once it ends with authz.fields they no longer receive ${droppedMembers(resource, steps)}`,
          "make sure no client that reads it without a session relies on those members",
          file === undefined ? { pipeline: trigger.pipeline } : { pipeline: trigger.pipeline, file },
          upgradingDocs("responses-anonymous-fields"),
        ),
      );
    }
    return findings;
  },
};

const MATCHES_ERROR_TEXT = /\.error\)?\.(?:toContain|toMatch|toBe|toEqual|includes|startsWith|endsWith|match)\(/;

/** `responses/thrown-error-text`: a file next to a local module matches on the `error` text of an answer, which reads `unexpected <ErrorName>` for a step that throws. */
export const thrownErrorTextRule: Rule = {
  id: "responses/thrown-error-text",
  check(ctx) {
    const dirs = [...new Set([...ctx.project.moduleFiles.values()].filter((file) => isProjectFile(ctx, file)).map((file) => dirname(file)))];
    const files = dirs.flatMap((dir) => {
      try {
        return readdirSync(dir)
          .filter((name) => /\.(?:[cm]?[jt]s)$/.test(name))
          .map((name) => join(dir, name));
      } catch {
        return [];
      }
    });
    return files
      .filter((file) => MATCHES_ERROR_TEXT.test(ctx.readFile(file) ?? ""))
      .sort()
      .map((file) =>
        infoFinding(
          `responses/thrown-error-text:${file}`,
          "responses/thrown-error-text",
          "this file matches on the error text of an answer; a step that throws now answers \"<pipeline>/<step>: unexpected <ErrorName>\", and its message is only in the log",
          "match on code and step instead, or read the message from the log under the answer's runId",
          { file },
          upgradingDocs("responses-thrown-error-text"),
        ),
      );
  },
};

export const fieldGrantRules: readonly Rule[] = [fieldStepRule, fieldGrantUnknownRule, anonymousFieldsRule, thrownErrorTextRule];
