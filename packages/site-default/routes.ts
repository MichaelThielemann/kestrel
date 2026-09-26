import { createHash } from "node:crypto";
import type { ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import type { Filter } from "@michaelthielemann/kestrel-contracts/query";

/** How one routed type builds its public paths. */
export interface Route {
  /** The field holding the one-segment slug. */
  slugField: string;
  /** The top-level slug served at the locale's root, or `null` for none. */
  home: string | null;
  /** The filter a document must pass, with its own values in a locale, to be reachable there. */
  liveWhen: Filter;
  /** The field that names a document in conflict messages. */
  labelField: string;
}

/** The parsed route configuration of `site/default`. */
export interface RoutesConfig {
  routes: Record<string, Route>;
  prefixPrimary: boolean;
  reservedPaths: string[];
}

/** A change of one document's reachable path in one locale; `seq` is the global sequence number of the run that made it. */
export interface Move {
  type: string;
  id: string;
  locale: string;
  from: string | null;
  to: string | null;
  seq: number;
}

/** The event `site/default` raises with `{ moves }` after a run changed reachable paths. */
export const PATHS_MOVED = "site.pathsMoved";

/** The locale keys a routed document is indexed under: the model's locales, or the single key `""` without locales. */
export function localeKeys(model: ContentModel): string[] {
  return model.locales !== undefined && model.locales.length > 0 ? [...model.locales] : [""];
}

export function defaultLocaleKey(model: ContentModel): string {
  return model.defaultLocale ?? "";
}

/** A tail formatted as a public path: the locale prefix (none for the default locale unless `prefixPrimary`), then the tail's segments. */
export function formatPath(tail: string, locale: string, defaultLocale: string, prefixPrimary: boolean): string {
  const prefixed = locale !== "" && (prefixPrimary || locale !== defaultLocale);
  const segments = [...(prefixed ? [locale] : []), ...(tail === "" ? [] : tail.split("/"))];
  return `/${segments.join("/")}`;
}

/** A request path split into its locale key and tail; `null` when a required locale prefix is missing. */
export function splitTail(path: string, locales: readonly string[], defaultLocale: string, prefixPrimary: boolean): { locale: string; explicit: boolean; tail: string } | null {
  const segments = path.split("/").filter((s) => s !== "");
  const [first, ...rest] = segments;
  if (first !== undefined && locales.includes(first)) return { locale: first, explicit: true, tail: rest.join("/") };
  if (prefixPrimary && locales.length > 0) return null;
  return { locale: defaultLocale, explicit: false, tail: segments.join("/") };
}

export function tailOf(slug: string, route: Route): string {
  return route.home !== null && slug === route.home ? "" : slug;
}

export function reservedMatch(path: string, reservedPaths: readonly string[]): string | undefined {
  return reservedPaths.find((reserved) => path === reserved || path.startsWith(`${reserved}/`));
}

/** The hash of everything a stored path depends on besides the documents themselves. */
export function routesHash(config: RoutesConfig, model: ContentModel): string {
  const types = Object.fromEntries(
    Object.keys(config.routes)
      .sort()
      .map((type) => [type, model.types[type]?.fields[config.routes[type]?.slugField ?? "slug"] ?? null]),
  );
  const input = { routes: config.routes, locales: model.locales ?? [], defaultLocale: model.defaultLocale ?? null, prefixPrimary: config.prefixPrimary, reservedPaths: config.reservedPaths, types };
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
