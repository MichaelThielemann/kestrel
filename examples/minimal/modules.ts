import { pipelineDefiner, type StepCatalogue } from "@michaelthielemann/kestrel";
import blobstoreFilesystem from "@michaelthielemann/kestrel-blobstore-filesystem";
import replicationSqlite from "@michaelthielemann/kestrel-replication-sqlite";
import persistenceSqlite from "@michaelthielemann/kestrel-persistence-sqlite";
import sanitizeSvg from "@michaelthielemann/kestrel-sanitize-svg";
import mediaDefault from "@michaelthielemann/kestrel-media-default";
import imagesDefault from "@michaelthielemann/kestrel-images-default";
import authnMulti from "@michaelthielemann/kestrel-authn-multi";
import authzRoles from "@michaelthielemann/kestrel-authz-roles";
import contentDefault from "@michaelthielemann/kestrel-content-default";
import siteDefault from "@michaelthielemann/kestrel-site-default";
import referencesDefault from "@michaelthielemann/kestrel-references-default";
import linksDefault from "@michaelthielemann/kestrel-links-default";
import revisionsDefault from "@michaelthielemann/kestrel-revisions-default";
import validateJsonschema from "@michaelthielemann/kestrel-validate-jsonschema";
import migrationsDefault from "@michaelthielemann/kestrel-migrations-default";
import rendererPlain from "@michaelthielemann/kestrel-renderer-plain";
import deliveryStatic from "@michaelthielemann/kestrel-delivery-static";
import redirectsDefault from "@michaelthielemann/kestrel-redirects-default";
import auditPersistence from "@michaelthielemann/kestrel-audit-persistence";
import eventsInmemory from "@michaelthielemann/kestrel-events-inmemory";
import ratelimitMemory from "@michaelthielemann/kestrel-ratelimit-memory";
import insightsDefault from "@michaelthielemann/kestrel-insights";

const modules = [
  blobstoreFilesystem,
  replicationSqlite,
  persistenceSqlite,
  sanitizeSvg,
  mediaDefault,
  imagesDefault,
  authnMulti,
  authzRoles,
  contentDefault,
  siteDefault,
  referencesDefault,
  linksDefault,
  revisionsDefault,
  validateJsonschema,
  migrationsDefault,
  rendererPlain,
  deliveryStatic,
  redirectsDefault,
  auditPersistence,
  eventsInmemory,
  ratelimitMemory,
  insightsDefault,
] as const;

export default modules;
export type KnownStep = StepCatalogue<typeof modules>;
export const definePipeline = pipelineDefiner<KnownStep>();
