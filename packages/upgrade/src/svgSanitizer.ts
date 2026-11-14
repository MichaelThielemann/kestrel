import { zodSchemaProblem } from "@michaelthielemann/kestrel";
import { createContext, isStepFactory, type Step, type StepFactory } from "@michaelthielemann/kestrel/context";
import { stepPrefix, type ModuleDefinition } from "@michaelthielemann/kestrel/defineModule";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { err, isErr, ok, type Result } from "@michaelthielemann/kestrel/result";
import { isRecord } from "./guards.ts";

const PREFIX = "sanitize";
const KEY = "svg";

/** The step whose module cleans the stored 5.x SVGs during `kestrel upgrade migrate`. */
export const SANITIZE_SVG_STEP = `${PREFIX}.${KEY}`;

/** Cleans the bytes of one stored SVG; `Err` holds the reason the step refuses the file. */
export type SvgSanitizer = (file: { filename: string; contentType: string; data: Uint8Array }) => Promise<Result<Uint8Array, string>>;

/** One module entry of the project, with its effective config and a way to load its definition. */
export interface ConfiguredModule {
  use: string;
  config: unknown;
  definition: () => Promise<ModuleDefinition>;
}

/**
 * What {@link projectSvgSanitizer} found: the sanitizer and the module entry it comes from. `broken`
 * says why the entry that registers `sanitize.svg` could not be set up offline and what to change; `unloaded` names the
 * entries that did not load, or whose steps could not be learned offline, while no sanitizer was found among the others.
 */
export interface ProjectSvgSanitizer {
  sanitize?: SvgSanitizer;
  from?: string;
  broken?: string;
  unloaded?: string;
}

const SVG = "image/svg+xml";

function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

function isSvg(contentType: string): boolean {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() === SVG;
}

const SVG_NAMESPACE = /\sxmlns[ \t\n\r]*=[ \t\n\r]*(["'])http:\/\/www\.w3\.org\/2000\/svg\1/;

function rootInSvgNamespace(data: Uint8Array): boolean {
  const text = new TextDecoder("utf-8").decode(data);
  const start = text.indexOf("<svg");
  if (start === -1 || /<[A-Za-z]/.test(text.slice(0, start)) || !/[ \t\n\r/>]/.test(text.charAt(start + 4))) return false;
  const end = text.indexOf(">", start);
  return end !== -1 && SVG_NAMESPACE.test(text.slice(start, end));
}

function offlineDeps(root: string) {
  return {
    get(contract: { name: string }): never {
      throw new Error(`needs the contract ${contract.name}, which kestrel upgrade migrate does not set up`);
    },
    find: () => undefined,
    logger: silentLogger,
    root,
    eventTriggers: [],
  };
}

function registersSvg(definition: ModuleDefinition): boolean | undefined {
  if (definition.describe === undefined) return undefined;
  try {
    const described: unknown = definition.describe(undefined);
    return isRecord(described) ? Object.hasOwn(described, KEY) : undefined;
  } catch {
    return undefined;
  }
}

type SetUp = { step: Step | StepFactory | undefined } | { broken: string; unknown: string };

async function setUpOffline(root: string, entry: ConfiguredModule, definition: ModuleDefinition): Promise<SetUp> {
  const schemaProblem = zodSchemaProblem(definition.configSchema);
  if (schemaProblem !== undefined) return { broken: `${schemaProblem}, so kestrel would not set the module up; install the project's 6.x dependencies first`, unknown: `has a config schema kestrel does not read (${schemaProblem})` };
  const parsed = definition.configSchema.safeParse(entry.config);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.length === 0 ? "the config" : issue.path.join(".")}: ${issue.message}`).join("; ");
    return { broken: `its config does not parse (${issues}), and kestrel would not set the module up with it either; correct the config of that module entry`, unknown: `has a config that does not parse (${issues})` };
  }
  try {
    const instance = await definition.setup(parsed.data, offlineDeps(root));
    return { step: definition.steps === undefined ? undefined : definition.steps(instance)[KEY] };
  } catch (thrown) {
    return { broken: `it could not be set up offline: ${messageOf(thrown)}; migrate cleans the 5.x SVGs with that step, so make it set up without other modules`, unknown: `could not be set up offline: ${messageOf(thrown)}` };
  }
}

/**
 * The `sanitize.svg` step of the project, set up offline with the module's own config, as the
 * function the media storage migration cleans each 5.x SVG with. The first module entry whose
 * module registers the step is used; its `setup()` gets no contract, so a module that needs one
 * is `broken`, as is one whose config schema or config start-up would refuse. A `sanitize` module
 * whose `describe()` lists no `svg` step is neither parsed nor set up. One whose steps are known only
 * after its `setup()` and that cannot be set up offline is listed under `unloaded`. Without such an entry there is no sanitizer.
 * The sanitizer refuses a file the step answers with a root element outside the SVG namespace.
 */
export async function projectSvgSanitizer(root: string, modules: readonly ConfiguredModule[]): Promise<ProjectSvgSanitizer> {
  const problems: string[] = [];
  for (const entry of modules) {
    let definition: ModuleDefinition;
    try {
      definition = await entry.definition();
    } catch (thrown) {
      problems.push(`${entry.use} could not be loaded: ${messageOf(thrown)}`);
      continue;
    }
    if (stepPrefix(definition.name) !== PREFIX || definition.steps === undefined) continue;
    const registers = registersSvg(definition);
    if (registers === false) continue;
    const setUp = await setUpOffline(root, entry, definition);
    if ("broken" in setUp) {
      if (registers === true) return { from: entry.use, broken: setUp.broken };
      problems.push(`${entry.use} ${setUp.unknown}`);
      continue;
    }
    const { step } = setUp;
    if (step === undefined || isStepFactory(step)) continue;
    const run = step;
    const sanitize: SvgSanitizer = async (file) => {
      try {
        const ctx = createContext({ trigger: { kind: "cron", name: "kestrel upgrade migrate" }, files: [{ field: "file", ...file }] });
        const result = await run(ctx);
        if (isErr(result)) return err(result.error.message);
        const files = result.value.files;
        if (files.length !== 1 || !isSvg(files[0]!.contentType)) return err(`${SANITIZE_SVG_STEP} did not answer one SVG`);
        if (!rootInSvgNamespace(files[0]!.data)) return err(`${SANITIZE_SVG_STEP} answered an SVG whose root element is not in the SVG namespace (xmlns="http://www.w3.org/2000/svg"), which no browser shows as an image`);
        return ok(files[0]!.data);
      } catch (thrown) {
        return err(`${SANITIZE_SVG_STEP} threw: ${messageOf(thrown)}`);
      }
    };
    return { sanitize, from: entry.use };
  }
  return problems.length === 0 ? {} : { unloaded: problems.join("; ") };
}
