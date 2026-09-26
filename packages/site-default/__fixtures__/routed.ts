import { randomUUID } from "node:crypto";
import { createContentDefault } from "@michaelthielemann/kestrel-content-default/impl";
import type { Content, ContentDocument, ContentError, ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { err, isErr, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import type { Events } from "@michaelthielemann/kestrel-contracts/events";
import { SITE_TEST_MODEL } from "@michaelthielemann/kestrel-contracts/site.contract.test";
import { createFakePersistence, type FakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { silentLogger, type Logger } from "@michaelthielemann/kestrel/logger";
/* eslint-disable no-restricted-imports -- a fixture of this package builds on the package's own files */
import { createSiteDefault, type SiteDefault } from "../impl.ts";
import { createSitePaths, type SitePaths } from "../paths.ts";
import { routeWith, routesConfig, type Move, type Route, type RoutesConfig } from "../routes.ts";
/* eslint-enable no-restricted-imports */

export const PAGES_ROUTE: Route = routeWith({ home: "home", liveWhen: { status: "published" } });

export interface RoutedSite {
  site: SiteDefault;
  paths: SitePaths;
  content: Content;
  raw: Content;
  db: FakePersistence;
  emitted: Move[][];
  events: Events & { failNext(): void };
}

export interface RoutedOptions {
  model?: ContentModel;
  routes?: Record<string, Route>;
  prefixPrimary?: boolean;
  reservedPaths?: string[];
  db?: FakePersistence;
  now?: () => number;
  logger?: Logger;
  config?: Partial<Omit<RoutesConfig, "routes">>;
}

export function recordingEvents(emitted: Move[][]): Events & { failNext(): void } {
  let fail = false;
  return {
    async emit(_name, data) {
      if (fail) {
        fail = false;
        throw new Error("events: injected failure");
      }
      emitted.push(boundaryCast<Move[]>(data.moves, "json"));
    },
    on: () => () => {},
    failNext() {
      fail = true;
    },
  };
}

/** `content` whose writes to routed types run with the path index in one scope, then announce, as a routed pipeline does. */
export function routedContent(raw: Content, paths: SitePaths, db: FakePersistence): Content {
  const grouped = async (type: string, write: () => Promise<Result<ContentDocument, ContentError>>, idOf: (doc: ContentDocument) => string): Promise<Result<ContentDocument, ContentError>> => {
    if (!paths.route(type)) return write();
    const runId = randomUUID();
    let answer: Result<ContentDocument, ContentError> | undefined;
    const outcome = await db.scope({ pipeline: "test", group: 1 }, async () => {
      answer = await write();
      if (isErr(answer)) return "rollback";
      const indexed = await paths.index(type, idOf(answer.value), runId);
      if (isErr(indexed)) {
        answer = err(indexed.error);
        return "rollback";
      }
      return "commit";
    });
    if (outcome.kind === "failed") throw new Error(outcome.error.message);
    if (outcome.verdict === "commit") await paths.announce(runId);
    return answer!;
  };
  return {
    model: () => raw.model(),
    validate: (...args) => raw.validate(...args),
    get: (...args) => raw.get(...args),
    list: (...args) => raw.list(...args),
    set: (...args) => raw.set(...args),
    create: (type, data, options) => grouped(type, () => raw.create(type, data, options), (d) => d.id),
    update: (type, id, patch, options) => grouped(type, () => raw.update(type, id, patch, options), () => id),
    removeTranslation: (type, id, locale) => grouped(type, () => raw.removeTranslation(type, id, locale), () => id),
    async remove(type, id) {
      if (!paths.route(type)) return raw.remove(type, id);
      const runId = randomUUID();
      let answer: Result<void, ContentError> | undefined;
      const outcome = await db.scope({ pipeline: "test", group: 1 }, async () => {
        answer = await raw.remove(type, id);
        if (isErr(answer)) return "rollback";
        const indexed = await paths.index(type, id, runId);
        if (isErr(indexed)) {
          answer = err(indexed.error);
          return "rollback";
        }
        return "commit";
      });
      if (outcome.kind === "failed") throw new Error(outcome.error.message);
      if (outcome.verdict === "commit") await paths.announce(runId);
      return answer!;
    },
  };
}

export async function routedSite(options: RoutedOptions = {}): Promise<RoutedSite> {
  const db = options.db ?? createFakePersistence();
  const raw = await createContentDefault(options.model ?? SITE_TEST_MODEL, db);
  const emitted: Move[][] = [];
  const events = recordingEvents(emitted);
  const config: RoutesConfig = routesConfig({ routes: options.routes ?? { pages: PAGES_ROUTE }, prefixPrimary: options.prefixPrimary ?? false, reservedPaths: options.reservedPaths ?? [], ...options.config });
  const paths = await createSitePaths(config, { content: raw, db, events, logger: options.logger ?? silentLogger, ...(options.now === undefined ? {} : { now: options.now }) });
  return { site: createSiteDefault(raw, paths), paths, content: routedContent(raw, paths, db), raw, db, emitted, events };
}
