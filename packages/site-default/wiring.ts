import type { ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import type { Introspection } from "@michaelthielemann/kestrel/defineModule";
import { logWarn, type Logger } from "@michaelthielemann/kestrel/logger";
import type { RoutesConfig } from "./routes.ts";

const WRITE = /^content\.(create|update|remove|removeTranslation):([^?]+)/;
const RESOLVE = /^site\.resolve:([^?]+)(?:\?(.*))?$/;
const RESOLVE_LINKS = /^site\.resolveLinks:[^?]+(?:\?(.*))?$/;
const RULE_ARGUMENTS = new Set(["home", "slugField", "fallback", "prefixPrimary"]);
const READ = /^site\.(resolve|resolveLinks|route|attachPaths|previewPath|readTree):([^?]+)(?:\?(.*))?$/;

/** Boot errors for a routed type whose model cannot carry a path. */
export function checkRoutedModel(config: RoutesConfig, model: ContentModel, logger: Logger): void {
  const problems: string[] = [];
  const routes = config.routes;
  for (const [type, route] of Object.entries(routes)) {
    const definition = model.types[type];
    if (!definition) {
      problems.push(`routes.${type}: the content model has no type "${type}"`);
      continue;
    }
    if (definition.kind !== "multi") problems.push(`routes.${type}: "${type}" is a single type; only multi types have paths`);
    const raw = definition.fields[route.slugField];
    const field = typeof raw === "string" ? { type: raw } : raw;
    if (field?.type !== "slug") problems.push(`routes.${type}.slugField: "${type}.${route.slugField}" must be a slug field`);
    for (const name of Object.keys(route.liveWhen)) if (!(name in definition.fields)) problems.push(`routes.${type}.liveWhen: "${type}" has no field "${name}"`);
    if (route.parentField !== null) {
      const rawParent = definition.fields[route.parentField];
      const parent = typeof rawParent === "string" ? { type: rawParent } : rawParent;
      if (type !== config.mountTarget) problems.push(`routes.${type}.parentField: only the mount target type (${config.mountTarget}) may have parents`);
      if (parent?.type !== "ref" || parent.to !== type || parent.localized === true) problems.push(`routes.${type}.parentField: "${type}.${route.parentField}" must be a non-localized ref to ${type}`);
    }
    if (route.mount && definition.kind !== "multi") problems.push(`routes.${type}.mount: only multi types can be mounted`);
    if (route.mount && type === config.mountTarget) problems.push(`routes.${type}.mount: the mount target type cannot be mounted`);
    const nested = route.parentField !== null || route.mount;
    if (field?.type === "slug" && field.unique === true && nested) {
      problems.push(`routes.${type}: "${type}.${route.slugField}" must not be unique; it would reject the same slug under two different parents without naming the occupant`);
    } else if (field?.type === "slug" && field.unique === true) {
      logWarn(logger, `site/default: "${type}.${route.slugField}" is unique; the public path is what must be unique, and a unique slug rejects the same slug in two places without naming the occupant`, { type });
    }
  }
  const mountable = Object.entries(routes).filter(([, r]) => r.mount).map(([t]) => t);
  if (mountable.length > 0) {
    if (!routes[config.mountTarget]) problems.push(`mountTarget: "${config.mountTarget}" is not routed`);
    if (!config.mounts) problems.push(`routes.${mountable[0] ?? ""}.mount needs "mounts": the single type and field that store the assignment`);
    else if (model.types[config.mounts.type]?.kind !== "single" || !(config.mounts.field in (model.types[config.mounts.type]?.fields ?? {}))) problems.push(`mounts: "${config.mounts.type}.${config.mounts.field}" must be a field of a single type`);
  }
  if (problems.length > 0) throw new Error(`site/default: ${problems.join("; ")}`);
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function condition(expected: unknown): [string, unknown] | undefined {
  if (typeof expected !== "object" || expected === null || Array.isArray(expected)) return undefined;
  const entries = Object.entries(expected);
  return entries.length === 1 ? entries[0] : undefined;
}

function agrees(expected: unknown, actual: string): boolean {
  if (isScalar(expected)) return String(expected) === actual;
  const [operator, operand] = condition(expected) ?? [];
  if (operator === "eq" && isScalar(operand)) return String(operand) === actual;
  if (operator === "ne" && isScalar(operand)) return String(operand) !== actual;
  if (operator === "in" && Array.isArray(operand) && operand.every(isScalar)) return operand.some((value) => String(value) === actual);
  return true;
}

function requirement(field: string, expected: unknown): string {
  return isScalar(expected) ? `${field}=${String(expected)}` : `${field} matching ${JSON.stringify(expected)}`;
}

/**
 * Boot errors for a pipeline that writes a routed type without keeping its paths, reads one with rules that contradict its route,
 * or resolves one without the route's `liveWhen` filter. A resolve step after `authn.requireUser` serves a signed-in preview and may stay unfiltered.
 */
export function checkPathWiring(manifest: ReturnType<Introspection["describe"]>, config: RoutesConfig): void {
  const problems: string[] = [];
  const routes = config.routes;
  const mountsSet = config.mounts === null ? null : `content.set:${config.mounts.type}`;
  for (const pipeline of manifest.pipelines) {
    const steps = pipeline.steps;
    steps.forEach((step, i) => {
      const write = WRITE.exec(step.spec);
      const writtenType = write?.[2];
      if (writtenType !== undefined && routes[writtenType]) {
        const index = `site.indexPath:${writtenType}`;
        if (step.atomic === undefined) {
          problems.push(`pipeline "${pipeline.name}": ${step.spec} must run in an atomic group that ends with ${index}`);
        } else {
          let end = i;
          while (steps[end + 1]?.atomic === step.atomic) end++;
          const last = steps[end];
          if (last?.spec !== index) problems.push(`pipeline "${pipeline.name}": the atomic group with ${step.spec} must end with ${index} (it ends with ${last?.spec ?? "nothing"})`);
          else if (steps[end + 1]?.spec !== "site.announcePaths") problems.push(`pipeline "${pipeline.name}": site.announcePaths must follow the atomic group that ends with ${index}`);
        }
      }
      if (mountsSet !== null && (step.spec === mountsSet || step.spec.startsWith(`${mountsSet}?`))) {
        let end = i;
        while (step.atomic !== undefined && steps[end + 1]?.atomic === step.atomic) end++;
        if (step.atomic === undefined || steps[end]?.spec !== "site.indexMounts") problems.push(`pipeline "${pipeline.name}": ${step.spec} must run in an atomic group that ends with site.indexMounts`);
        else if (steps[end + 1]?.spec !== "site.announcePaths") problems.push(`pipeline "${pipeline.name}": site.announcePaths must follow the atomic group that ends with site.indexMounts`);
      }
      const read = READ.exec(step.spec);
      const readType = read?.[2];
      const route = readType === undefined ? undefined : routes[readType];
      if (route) {
        const args = new URLSearchParams(read?.[3] ?? "");
        const slugField = args.get("slugField");
        const home = args.get("home");
        if (slugField !== null && slugField !== route.slugField) problems.push(`pipeline "${pipeline.name}": ${step.spec} names slugField "${slugField}", but routes.${readType}.slugField is "${route.slugField}"`);
        if (home !== null && home !== route.home) problems.push(`pipeline "${pipeline.name}": ${step.spec} names home "${home}", but routes.${readType}.home is ${route.home === null ? "unset" : `"${route.home}"`}`);
      }
      const preview = steps.slice(0, i).some((earlier) => earlier.spec === "authn.requireUser");
      const resolve = RESOLVE.exec(step.spec);
      const resolveRoute = resolve?.[1] === undefined ? undefined : routes[resolve[1]];
      if (resolve && resolveRoute && !preview) {
        const args = new URLSearchParams(resolve[2] ?? "");
        const missing = Object.entries(resolveRoute.liveWhen).flatMap(([field, expected]) => {
          const actual = args.get(field);
          return actual !== null && agrees(expected, actual) ? [] : [requirement(field, expected)];
        });
        if (missing.length > 0) problems.push(`pipeline "${pipeline.name}": ${step.spec} must carry ${missing.join("&")}, the route's liveWhen, or it serves documents the route does not publish`);
      }
      const links = RESOLVE_LINKS.exec(step.spec);
      if (links && !preview) {
        const filtered = [...new URLSearchParams(links[1] ?? "").keys()].some((key) => !RULE_ARGUMENTS.has(key));
        const example = Object.values(routes).flatMap((r) => Object.entries(r.liveWhen))[0];
        if (!filtered && example !== undefined) problems.push(`pipeline "${pipeline.name}": ${step.spec} must carry a filter such as ${isScalar(example[1]) ? requirement(example[0], example[1]) : `${example[0]}=<value>`}, or it links to documents the routes do not publish`);
      }
    });
  }
  if (problems.length > 0) throw new Error(`site/default: ${problems.join("; ")}`);
}
