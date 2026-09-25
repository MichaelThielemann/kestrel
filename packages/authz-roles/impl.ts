import type { Identity } from "@michaelthielemann/kestrel-contracts/authn";
import type { Authz, AuthzError } from "@michaelthielemann/kestrel-contracts/authz";
import type { Detach, Introspection, Manifest, PipelineManifest } from "@michaelthielemann/kestrel";
import { ok, type Result } from "@michaelthielemann/kestrel/result";
import { resolveOutputSchema } from "@michaelthielemann/kestrel/schema";
import { answerShape, declaredPath, fieldTree, itemSchemas, parseFieldsArgument, uncoveredMember, type AnswerShape, type FieldTree } from "./fields.ts";

/** Field paths per resource: which members of an answer a caller keeps. */
export type FieldGrants = Record<string, string[]>;

export interface Config {
  roles: Record<string, string[]>;
  roleClaim: string;
  anonymous: string[];
  /** What a caller without an identity keeps of each resource's answers. */
  anonymousFields?: FieldGrants;
  /** Per role, what a caller holding it keeps of each resource's answers; a role without a grant for a resource keeps everything. */
  fields?: Record<string, FieldGrants>;
}

function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

function union(...lists: ReadonlyArray<readonly string[]>): string[] {
  return [...new Set(lists.flat())];
}

export type PipelineVerdict = "granted" | "denied" | "unknown";

export function matches(granted: string, permission: string): boolean {
  if (granted === "*" || granted === permission) return true;
  if (granted.endsWith(".*")) return permission.startsWith(granted.slice(0, -1));
  return false;
}

export function rolesOf(identity: Identity, claim: string): string[] {
  const value = identity.claims[claim];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

export function anonymousCan(config: Config, permission: string): boolean {
  return config.anonymous.some((granted) => matches(granted, permission));
}

/**
 * Throws on the first pipeline that runs a step declaring `anonymous: "required"` without letting an
 * anonymous caller through: an authn step other than `authz.require` requires a signed-in caller, the
 * pipeline has no `authz.require` step whose permission could be checked, or its `authz.require`
 * permissions are not all granted to `anonymous`.
 */
export function assertAnonymousAccess(config: Config, manifest: Pick<Manifest, "pipelines">): void {
  for (const pipeline of manifest.pipelines) {
    const flagged = pipeline.steps.find((step) => step.description.anonymous === "required");
    if (!flagged) continue;
    const authnGate = pipeline.steps.find((step) => step.description.security === "required" && step.name !== "authz.require");
    if (authnGate) {
      throw new Error(`authz/roles: pipeline "${pipeline.name}" runs ${flagged.name}, whose output is also published without an access check, but ${authnGate.name} requires a signed-in caller`);
    }
    const required = requiredPermissions(pipeline);
    if (required.length === 0) {
      throw new Error(`authz/roles: pipeline "${pipeline.name}" runs ${flagged.name}, whose output is also published without an access check, but has no authz.require step – gate it with authz.require:<permission> so that boot can check anonymous callers hold that permission`);
    }
    const missing = required.find((permission) => !anonymousCan(config, permission));
    if (missing !== undefined) {
      throw new Error(`authz/roles: pipeline "${pipeline.name}" runs ${flagged.name}, whose output is also published without an access check, but anonymous callers lack "${missing}" – grant it in "anonymous" or stop publishing that step's output`);
    }
  }
}

/** The permissions of one pipeline's `authz.require:<perm>` steps, deduplicated, in step order. Steps inside an atomic group count like any other. */
export function requiredPermissions(pipeline: PipelineManifest): string[] {
  const seen = new Set<string>();
  const permissions: string[] = [];
  for (const step of pipeline.steps) {
    if (step.name !== "authz.require") continue;
    const colon = step.spec.indexOf(":");
    if (colon === -1) continue;
    const permission = step.spec.slice(colon + 1);
    if (seen.has(permission)) continue;
    seen.add(permission);
    permissions.push(permission);
  }
  return permissions;
}

/**
 * The field paths `identity` keeps of `resource`: without an identity the `anonymousFields` grant, `undefined`
 * when there is none; with one, `"all"` when one of its configured roles has no field grant for the resource,
 * otherwise the union of its roles' grants and the anonymous one. An identity without a configured role keeps
 * the anonymous grant, or everything where there is none.
 */
export function fieldSet(config: Config, identity: Identity | undefined, resource: string): "all" | readonly string[] | undefined {
  const anonymous = own(config.anonymousFields, resource);
  if (identity === undefined) return anonymous;
  const roles = [...new Set(rolesOf(identity, config.roleClaim))].filter((role) => Object.hasOwn(config.roles, role));
  if (roles.length === 0) return anonymous ?? "all";
  const grants = roles.map((role) => own(own(config.fields, role), resource));
  if (grants.some((grant) => grant === undefined)) return "all";
  return union(...grants.map((grant) => grant ?? []), anonymous ?? []);
}

/** The restricted answers of `resource` per audience label: `anonymous` for the anonymous grant, `role:<name>` for each role with a field grant (joined with the anonymous grant). A role without one is left out: it receives the whole answer. */
export function answersOf(config: Config, resource: string): Record<string, string[]> {
  const anonymous = own(config.anonymousFields, resource);
  const answers: Array<[string, string[]]> = anonymous === undefined ? [] : [["anonymous", [...anonymous]]];
  for (const role of Object.keys(config.roles)) {
    const grant = own(own(config.fields, role), resource);
    if (grant !== undefined) answers.push([`role:${role}`, union(grant, anonymous ?? [])]);
  }
  return Object.fromEntries(answers);
}

function writesResult(step: PipelineManifest["steps"][number]): boolean {
  return step.description.writes.some((path) => path.replace(/\?$/, "").split(".")[0] === "result");
}

/**
 * The pipelines whose answer goes to a caller without an identity: an HTTP trigger runs them, no step other
 * than `authz.require` declares `security: "required"`, `anonymous` grants every `authz.require` permission,
 * some step writes `result`, and no step up to the first one that does writes `identity` unconditionally
 * (a login answers the caller it signs in).
 */
export function anonymousPipelines(config: Config, manifest: Pick<Manifest, "pipelines" | "triggers">): PipelineManifest[] {
  const routed = new Set(manifest.triggers.http.map((route) => route.pipeline));
  return manifest.pipelines.filter((pipeline) => {
    if (!routed.has(pipeline.name)) return false;
    if (pipeline.steps.some((step) => step.description.security === "required" && step.name !== "authz.require")) return false;
    if (!requiredPermissions(pipeline).every((permission) => anonymousCan(config, permission))) return false;
    const firstWrite = pipeline.steps.findIndex(writesResult);
    if (firstWrite === -1) return false;
    return !pipeline.steps.slice(0, firstWrite + 1).some((step) => step.description.writes.includes("identity"));
  });
}

interface FieldCut {
  pipeline: PipelineManifest;
  resource: string;
  shape: AnswerShape;
  fold: ReturnType<typeof resolveOutputSchema>;
  terminals: Array<PipelineManifest["steps"][number]>;
}

const SHAPE_WORDS: Record<AnswerShape, string> = { item: "one item", list: "a list ({ items, total })", array: "an array", file: "a file" };

function cutOf(pipeline: PipelineManifest, problems: string[]): FieldCut | undefined {
  const last = pipeline.steps.length - 1;
  const misplaced = pipeline.steps.findIndex((step, index) => step.name === "authz.fields" && index !== last);
  if (misplaced !== -1) {
    problems.push(`authz/roles: pipeline "${pipeline.name}" runs ${pipeline.steps[misplaced + 1]!.spec} after ${pipeline.steps[misplaced]!.spec} – authz.fields must be the last step`);
    return undefined;
  }
  const step = pipeline.steps[last];
  if (step?.name !== "authz.fields") return undefined;
  const target = parseFieldsArgument(step.spec.slice("authz.fields:".length));
  if (target === undefined) return undefined;
  const before = pipeline.steps.slice(0, last);
  const fold = resolveOutputSchema(before.map((s) => s.description));
  const expected = answerShape(fold, before.some((s) => s.description.binary === true));
  if (expected === undefined) {
    problems.push(`authz/roles: pipeline "${pipeline.name}" ends with ${step.spec}, but its declared output is a union of different shapes, which one step cannot cut`);
  } else if (expected !== target.shape) {
    problems.push(`authz/roles: pipeline "${pipeline.name}" ends with ${step.spec}, but its declared output is ${SHAPE_WORDS[expected]} – write authz.fields:${target.resource}?shape=${expected}`);
  }
  return { pipeline, resource: target.resource, shape: target.shape, fold, terminals: before.filter((s) => s.description.terminalOutput !== undefined) };
}

function expectedShape(pipeline: PipelineManifest): AnswerShape {
  const descriptions = pipeline.steps.map((s) => s.description);
  return answerShape(resolveOutputSchema(descriptions), descriptions.some((d) => d.binary === true)) ?? "item";
}

function grantPathProblem(cuts: readonly FieldCut[], path: string): string | undefined {
  let hint: string | undefined;
  for (const cut of cuts) {
    if (cut.shape === "file") {
      if (/^headers\.[^.[\]]+$/.test(path)) return undefined;
      hint ??= 'name each header as "headers.<name>"';
      continue;
    }
    const schemas = [...itemSchemas(cut.fold, cut.shape), ...cut.terminals.map((s) => s.description.terminalOutput!)];
    const found = declaredPath(schemas, path);
    if (found.declared) return undefined;
    hint ??= found.hint;
  }
  return hint ?? "";
}

function terminalProblem(cut: FieldCut, tree: FieldTree): string | undefined {
  for (const step of cut.terminals) {
    const uncovered = uncoveredMember(step.description.terminalOutput!, tree);
    if (uncovered === undefined) continue;
    const head = `authz/roles: pipeline "${cut.pipeline.name}" can end at ${step.spec} before authz.fields:${cut.resource}, and that answer`;
    if (uncovered.kind === "ungranted") return `${head} carries "${uncovered.path}", which anonymousFields.${cut.resource} does not grant`;
    return `${head} is an open object at ${uncovered.path === "" ? "the root" : uncovered.path}, which no grant can bound`;
  }
  return undefined;
}

/**
 * Every way the booted pipelines and the field grants contradict each other, one message each: a step after
 * `authz.fields`, a shape parameter the declared output contradicts, an anonymously answered pipeline that does
 * not end with `authz.fields` or whose resource has no anonymous grant, an early answer (`terminalOutput`) the
 * anonymous grant does not cover, a grant naming a field no pipeline of its resource declares, and a grant for
 * a resource no pipeline cuts.
 */
export function fieldGrantProblems(config: Config, manifest: Pick<Manifest, "pipelines" | "triggers">): string[] {
  const problems: string[] = [];
  const cuts = new Map<string, FieldCut[]>();
  for (const pipeline of manifest.pipelines) {
    const cut = cutOf(pipeline, problems);
    if (cut === undefined) continue;
    cuts.set(cut.resource, [...(cuts.get(cut.resource) ?? []), cut]);
  }
  for (const pipeline of anonymousPipelines(config, manifest)) {
    const cut = [...cuts.values()].flat().find((c) => c.pipeline === pipeline);
    if (cut === undefined) {
      if (pipeline.steps.every((step) => step.name !== "authz.fields")) {
        problems.push(`authz/roles: pipeline "${pipeline.name}" answers anonymous callers but does not end with authz.fields:<resource>?shape=${expectedShape(pipeline)} – end it with the step, so that its answer carries only the fields anonymous callers may see`);
      }
      continue;
    }
    const grant = own(config.anonymousFields, cut.resource);
    if (grant === undefined) {
      problems.push(`authz/roles: pipeline "${pipeline.name}" answers anonymous callers and ends with authz.fields:${cut.resource}, but anonymousFields grants nothing for "${cut.resource}"`);
      continue;
    }
    const terminal = terminalProblem(cut, fieldTree(grant));
    if (terminal !== undefined) problems.push(terminal);
  }
  const grants: Array<[string, FieldGrants]> = [["anonymousFields", config.anonymousFields ?? {}], ...Object.entries(config.fields ?? {}).map(([role, grant]): [string, FieldGrants] => [`fields.${role}`, grant])];
  for (const [label, byResource] of grants) {
    for (const [resource, paths] of Object.entries(byResource)) {
      const resourceCuts = cuts.get(resource);
      if (resourceCuts === undefined) {
        problems.push(`authz/roles: ${label} grants fields of "${resource}", but no pipeline ends with authz.fields:${resource}`);
        continue;
      }
      for (const path of paths) {
        const hint = grantPathProblem(resourceCuts, path);
        if (hint === undefined) continue;
        problems.push(`authz/roles: ${label}.${resource} names "${path}", which no pipeline ending with authz.fields:${resource} declares${hint === "" ? "" : ` – ${hint}`}`);
      }
    }
  }
  return problems;
}

export interface AuthzRoles extends Authz {
  canAnonymous(permission: string): boolean;
  /** The field tree `identity` keeps of `resource`, `"all"`, or `undefined` for an anonymous caller without a grant; see {@link fieldSet}. */
  fieldsFor(identity: Identity | undefined, resource: string): "all" | FieldTree | undefined;
  /** See {@link answersOf}. */
  answersOf(resource: string): Record<string, string[]>;
  attach(kestrel: Introspection): Detach;
  /** Per booted pipeline: `granted` when the caller passes every `authz.require` step, `denied` when it fails one, `unknown` when the pipeline has none. Without an identity the `anonymous` grants decide, as in `authz.require`; a signed-in caller holds its roles' grants and the `anonymous` ones. */
  describePipelineAccess(identity: Identity | undefined): Record<string, PipelineVerdict>;
  listRoles(): string[];
}

/** `can` grants a permission to a signed-in caller whose roles grant it, and to every signed-in caller when `anonymous` grants it: what an anonymous caller may do, a signed-in one may do too. */
export function createAuthzRoles(config: Config): AuthzRoles {
  const roles = new Map(Object.entries(config.roles));
  const trees = new Map<string, FieldTree>();
  let gates: ReadonlyMap<string, readonly string[]> | undefined;

  function holds(identity: Identity, permission: string): boolean {
    return anonymousCan(config, permission) || rolesOf(identity, config.roleClaim).some((role) => (roles.get(role) ?? []).some((granted) => matches(granted, permission)));
  }

  return {
    async can(identity, permission): Promise<Result<boolean, AuthzError>> {
      return ok(holds(identity, permission));
    },
    canAnonymous(permission) {
      return anonymousCan(config, permission);
    },
    fieldsFor(identity, resource) {
      const paths = fieldSet(config, identity, resource);
      if (paths === "all" || paths === undefined) return paths;
      const key = JSON.stringify([...paths].sort());
      let tree = trees.get(key);
      if (tree === undefined) {
        tree = fieldTree(paths);
        trees.set(key, tree);
      }
      return tree;
    },
    answersOf(resource) {
      return answersOf(config, resource);
    },
    attach(kestrel) {
      const manifest = kestrel.describe();
      assertAnonymousAccess(config, manifest);
      gates = new Map(manifest.pipelines.map((p): [string, readonly string[]] => [p.name, requiredPermissions(p)]));
      return () => {
        gates = undefined;
      };
    },
    describePipelineAccess(identity): Record<string, PipelineVerdict> {
      if (!gates) throw new Error("authz/roles: not attached to a booted instance");
      return Object.fromEntries(
        [...gates].map(([name, required]): [string, PipelineVerdict] => {
          if (required.length === 0) return [name, "unknown"];
          const passes = identity ? required.every((permission) => holds(identity, permission)) : required.every((permission) => anonymousCan(config, permission));
          return [name, passes ? "granted" : "denied"];
        }),
      );
    },
    listRoles(): string[] {
      return [...roles.keys()];
    },
  };
}
