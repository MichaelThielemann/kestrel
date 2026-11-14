import { pipelineSteps } from "@michaelthielemann/kestrel/definePipeline";
import type { AstNode } from "./ast.ts";
import { isRecord } from "./guards.ts";
import type { Rule, RuleContext } from "./plugin.ts";
import type { Finding, FindingLocation } from "./report.ts";
import { parseModule, queryKeysRead, stepScopes } from "./queryReads.ts";
import { fileForPipeline, finding, hasModule, infoFinding, localModuleFiles, moduleEntry, pipelinesTriggeredBy, upgradingDocs } from "./ruleHelpers.ts";

const READ_PERMISSION = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.read$/;

function printed(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

const ANONYMOUS_ISSUE = 'anonymous\\.\\d+: anonymous may hold only read permissions such as "pages\\.read"; a wildcard or a permission that writes, manages or lists is for roles';
const ANONYMOUS_ONLY_ISSUES = new RegExp(`^invalid config(?: \\(with defaults from "[^"]*"\\))?: ${ANONYMOUS_ISSUE}(?:; ${ANONYMOUS_ISSUE})*$`);

/** `authz/anonymous-read-only`: `authz-roles` refuses boot when `anonymous` holds anything but `<name>.read` entries; a wildcard, a write, a manage or a listing permission belongs to a role. When the boot check's config error for the module names only such entries, the finding carries that module's name and stands in for the error. */
export const anonymousReadOnlyRule: Rule = {
  id: "authz/anonymous-read-only",
  check(ctx) {
    const authz = moduleEntry(ctx, "authz-roles");
    if (authz === undefined || !isRecord(authz.config) || !Array.isArray(authz.config.anonymous)) return [];
    const offending: unknown[] = authz.config.anonymous.filter((entry: unknown) => typeof entry !== "string" || !READ_PERMISSION.test(entry));
    if (offending.length === 0) return [];
    const explained = ctx.bootCheck.errors.find((e) => e.code === "invalid-module-config" && e.module !== undefined && ANONYMOUS_ONLY_ISSUES.test(e.reason));
    return [
      finding(
        "authz/anonymous-read-only",
        "authz/anonymous-read-only",
        `authz-roles's anonymous list holds ${offending.map(printed).join(", ")}; from 6.0.0 it accepts only read permissions such as "pages.read", and boot fails on any other entry`,
        "grant a wildcard or a permission that writes, manages or lists to a role in roles, and keep only <name>.read entries in anonymous",
        { module: explained?.module ?? authz.use, path: "anonymous" },
        undefined,
        upgradingDocs("authz-anonymous-read-only"),
      ),
    ];
  },
};

interface LocalStep {
  module: string;
  file: string;
  description: unknown;
  queryKeys: () => ReadonlySet<string>;
}

function described(definition: { describe?: (instance: unknown) => unknown }): Record<string, unknown> | undefined {
  if (definition.describe === undefined) return undefined;
  try {
    const result = definition.describe(undefined);
    return isRecord(result) ? result : undefined;
  } catch {
    return undefined;
  }
}

function lazyQueryKeys(root: AstNode | undefined, stepKey: string): () => ReadonlySet<string> {
  let keys: ReadonlySet<string> | undefined;
  return () => {
    if (keys === undefined) keys = root === undefined ? new Set() : queryKeysRead(stepScopes(root, stepKey) ?? [root]);
    return keys;
  };
}

function localSteps(ctx: RuleContext): Map<string, LocalStep> {
  const files = new Map(localModuleFiles(ctx));
  const roots = new Map<string, AstNode | undefined>();
  const steps = new Map<string, LocalStep>();
  for (const mod of ctx.project.input.modules) {
    const file = files.get(mod.name);
    if (file === undefined) continue;
    if (!roots.has(file)) {
      const source = ctx.readFile(file);
      roots.set(file, source === undefined ? undefined : parseModule(source));
    }
    const root = roots.get(file);
    const descriptions = root === undefined ? undefined : described(mod);
    if (descriptions === undefined) continue;
    const prefix = mod.name.split("/")[0] ?? mod.name;
    for (const [key, description] of Object.entries(descriptions)) steps.set(`${prefix}.${key}`, { module: mod.name, file, description, queryKeys: lazyQueryKeys(root, key) });
  }
  return steps;
}

function resolveDescription(step: LocalStep, arg: string | undefined): Record<string, unknown> | undefined {
  if (isRecord(step.description)) return step.description;
  if (typeof step.description !== "function" || arg === undefined) return undefined;
  try {
    const result: unknown = Reflect.apply(step.description, undefined, [arg]);
    return isRecord(result) ? result : undefined;
  } catch {
    return undefined;
  }
}

interface QueryKey {
  key: string;
  read: boolean;
}

function undeclaredQueryKeys(step: LocalStep, arg: string | undefined, bodiless: boolean): QueryKey[] {
  const description = resolveDescription(step, arg);
  if (description === undefined || !isRecord(description.input) || !isRecord(description.input.properties)) return [];
  const declared = isRecord(description.query) ? description.query : {};
  const found: QueryKey[] = [];
  for (const key of Object.keys(description.input.properties)) {
    if (Object.hasOwn(declared, key)) continue;
    const read = step.queryKeys().has(key);
    if (read || bodiless) found.push({ key, read });
  }
  return found;
}

function bareNames(steps: readonly string[]): string[] {
  return steps.map((s) => s.split(":")[0]!);
}

function httpPipelines(ctx: RuleContext) {
  const names = pipelinesTriggeredBy(ctx, "http");
  return ctx.project.input.pipelines.filter((def) => names.has(def.name));
}

const BODILESS_METHODS = new Set(["GET", "HEAD"]);

function bodilessRoutes(ctx: RuleContext): Map<string, string> {
  const routes = new Map<string, string>();
  for (const trigger of ctx.project.input.config.triggers) {
    if (!("http" in trigger) || routes.has(trigger.pipeline)) continue;
    const method = trigger.http.trim().split(/\s+/)[0]?.toUpperCase();
    if (method !== undefined && BODILESS_METHODS.has(method)) routes.set(trigger.pipeline, trigger.http.trim());
  }
  return routes;
}

function locationOf(ctx: RuleContext, pipeline: string): FindingLocation {
  const file = fileForPipeline(ctx, pipeline);
  return file === undefined ? { pipeline } : { pipeline, file };
}

const QUERY_BODY_DOCS = upgradingDocs("pipelines-query-body-member");

/** `pipelines/query-body-member`: a request query key that names a member of a step's body schema answers 400 unless the step declares it in `describe().query`. On a GET or HEAD route every member of the schema can only arrive in the query, so each one the step does not declare is named; on any other route a member is named when the step's own code reads it from the query. */
export const queryBodyMemberRule: Rule = {
  id: "pipelines/query-body-member",
  check(ctx) {
    const findings: Finding[] = [];
    const pipelines = httpPipelines(ctx);
    const steps = localSteps(ctx);
    const bodiless = bodilessRoutes(ctx);
    for (const def of pipelines) {
      const route = bodiless.get(def.name);
      const specs = [...new Set(pipelineSteps(def.steps))];
      const names = bareNames(specs);
      for (const spec of specs) {
        const colon = spec.indexOf(":");
        const bare = colon === -1 ? spec : spec.slice(0, colon);
        const step = steps.get(bare);
        if (step === undefined) continue;
        for (const { key, read } of undeclaredQueryKeys(step, colon === -1 ? undefined : spec.slice(colon + 1), route !== undefined)) {
          findings.push({
            id: `pipelines/query-body-member:${def.name}:${spec}:${key}`,
            rule: "pipelines/query-body-member",
            severity: "warning",
            tier: "source",
            where: { ...locationOf(ctx, def.name), module: step.module },
            message: read
              ? `step "${spec}" reads "${key}" from the query, but "${key}" is a member of its input schema and not declared in describe().query; a request that sends it in the query now answers 400 VALIDATION before the step runs`
              : `step "${spec}" takes "${key}" from the request, which on ${route} can only be the query, but "${key}" is a member of its input schema and not declared in describe().query; a request that sends it in the query now answers 400 VALIDATION before the step runs`,
            suggestion: read
              ? `declare "${key}" in the query of the step's describe() entry, or read it from the body and have clients send it there`
              : `declare "${key}" in the query of the step's describe() entry; a ${route?.split(" ")[0]?.toUpperCase()} route has no body to take it from`,
            fix: { kind: "manual" },
            docs: QUERY_BODY_DOCS,
          });
        }
      }
      if (names.includes("migrations.apply")) {
        findings.push(infoFinding(`pipelines/query-body-member:${def.name}:migrations.apply`, "pipelines/query-body-member", `pipeline "${def.name}" runs migrations.apply over HTTP, which reads dry from the body only; a request with ?dry=true in the query now answers 400 VALIDATION instead of applying the migrations`, "send dry in the JSON body", locationOf(ctx, def.name), QUERY_BODY_DOCS));
      }
    }
    return findings;
  },
};

function stepArgument(spec: string): { name: string; arg: string } {
  const colon = spec.indexOf(":");
  return colon === -1 ? { name: spec, arg: "" } : { name: spec.slice(0, colon), arg: spec.slice(colon + 1) };
}

function listShapeResource(arg: string): string | undefined {
  const [resource, query = ""] = arg.split("?", 2);
  return resource !== undefined && resource !== "" && new URLSearchParams(query).get("shape") === "list" ? resource : undefined;
}

/** `runtime/sort-field-grant`: a pipeline that ends a list with `authz.fields:<resource>?shape=list` sorts, for a caller kept to a field grant, only by a field the grant names, and `content.list` answers every caller 400 for a sort that names no field of the type. */
export const sortFieldGrantRule: Rule = {
  id: "runtime/sort-field-grant",
  check(ctx) {
    const findings: Finding[] = [];
    for (const def of httpPipelines(ctx)) {
      const narrowed = new Set<string>();
      const contentTypes = new Set<string>();
      for (const spec of pipelineSteps(def.steps)) {
        const { name, arg } = stepArgument(spec);
        if (name === "authz.fields") {
          const resource = listShapeResource(arg);
          if (resource !== undefined) narrowed.add(resource);
        } else if (name === "content.list") {
          const type = arg.split("?")[0] ?? "";
          if (type !== "") contentTypes.add(type);
        }
      }
      const parts: string[] = [];
      if (narrowed.size > 0) parts.push(`a caller kept to a field grant for ${[...narrowed].join(", ")} by authz.fields now sorts only by a field the grant names (id, createdAt and updatedAt stay sortable)`);
      if (contentTypes.size > 0) parts.push(`content.list of ${[...contentTypes].join(", ")} answers 400 to every caller when the sort names no field of the type, such as constructor`);
      if (parts.length === 0) continue;
      findings.push(
        infoFinding(
          `runtime/sort-field-grant:${def.name}`,
          "runtime/sort-field-grant",
          `pipeline "${def.name}" lists over HTTP: ${parts.join("; ")}`,
          "check the sort values your clients send, and add each field a public list is sorted by to the grant of the callers who sort by it",
          locationOf(ctx, def.name),
          upgradingDocs("runtime-sort-field-grant"),
        ),
      );
    }
    return findings;
  },
};

const CLEANUP_STEPS = ["audit.anonymize", "revisions.reassignAuthor"];

/** `runtime/user-cleanup-guard`: an HTTP route that runs a user cleanup step acts on whatever id it is given unless `authn.requireAbsentUser` runs before it. */
export const userCleanupGuardRule: Rule = {
  id: "runtime/user-cleanup-guard",
  check(ctx) {
    const findings: Finding[] = [];
    for (const def of httpPipelines(ctx)) {
      const names = bareNames(pipelineSteps(def.steps));
      for (const step of CLEANUP_STEPS) {
        const at = names.indexOf(step);
        if (at === -1 || names.slice(0, at).includes("authn.requireAbsentUser")) continue;
        findings.push({
          id: `runtime/user-cleanup-guard:${def.name}:${step}`,
          rule: "runtime/user-cleanup-guard",
          severity: "warning",
          tier: "source",
          where: locationOf(ctx, def.name),
          message: `pipeline "${def.name}" runs ${step} on an HTTP route without authn.requireAbsentUser before it; the step acts on whatever id params.id holds, so an active user's audit trail or revisions can be rewritten through it`,
          suggestion: hasModule(ctx, "authn-multi")
            ? `add authn.requireAbsentUser before ${step}, and emit an event after the repair that a pipeline records with audit.recordActor`
            : `check by hand that params.id names no existing user before ${step}; authn.requireAbsentUser belongs to authn-multi`,
          fix: { kind: "manual" },
          docs: upgradingDocs("runtime-user-cleanup-guard"),
        });
      }
    }
    return findings;
  },
};

export const HARDENING_RULES: readonly Rule[] = [anonymousReadOnlyRule, queryBodyMemberRule, sortFieldGrantRule, userCleanupGuardRule];
