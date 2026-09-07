import { pipelineDefiner, type StepCatalogue } from "@michaelthielemann/kestrel";
import authnSingle from "@michaelthielemann/kestrel-authn-single";
import authzRoles from "@michaelthielemann/kestrel-authz-roles";
import contentDefault from "@michaelthielemann/kestrel-content-default";
import eventsInmemory from "@michaelthielemann/kestrel-events-inmemory";
import migrationsDefault from "@michaelthielemann/kestrel-migrations-default";
import persistenceSqlite from "@michaelthielemann/kestrel-persistence-sqlite";
import siteDefault from "@michaelthielemann/kestrel-site-default";

/** Same order as `config.modules`; boot pairs the two lists positionally. */
const modules = [eventsInmemory, persistenceSqlite, authnSingle, authzRoles, contentDefault, siteDefault, migrationsDefault] as const;

export default modules;
export type KnownStep = StepCatalogue<typeof modules>;
export const definePipeline = pipelineDefiner<KnownStep>();
