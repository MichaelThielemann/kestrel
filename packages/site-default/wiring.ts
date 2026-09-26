import type { ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import type { Introspection } from "@michaelthielemann/kestrel/defineModule";
import { logWarn, type Logger } from "@michaelthielemann/kestrel/logger";
import type { Route } from "./routes.ts";

const WRITE = /^content\.(create|update|remove|removeTranslation):([^?]+)/;
const READ = /^site\.(resolve|resolveLinks|route|attachPaths|previewPath):([^?]+)(?:\?(.*))?$/;

/** Boot errors for a routed type whose model cannot carry a path. */
export function checkRoutedModel(routes: Record<string, Route>, model: ContentModel, logger: Logger): void {
  const problems: string[] = [];
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
    if (field?.type === "slug" && field.unique === true) {
      logWarn(logger, `site/default: "${type}.${route.slugField}" is unique; the public path is what must be unique, and a unique slug rejects the same slug in two places without naming the occupant`, { type });
    }
  }
  if (problems.length > 0) throw new Error(`site/default: ${problems.join("; ")}`);
}

/** Boot errors for a pipeline that writes a routed type without keeping its paths, or reads one with rules that contradict its route. */
export function checkPathWiring(manifest: ReturnType<Introspection["describe"]>, routes: Record<string, Route>): void {
  const problems: string[] = [];
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
    });
  }
  if (problems.length > 0) throw new Error(`site/default: ${problems.join("; ")}`);
}
