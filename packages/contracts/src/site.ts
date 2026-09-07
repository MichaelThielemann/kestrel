import { defineContract } from "@michaelthielemann/kestrel/defineContract";
import type { ContentDocument } from "./content.ts";
import type { KestrelError, Result } from "./errors.ts";
import type { Filter } from "./query.ts";

export interface SiteRules {
  home?: string;
  slugField?: string;
  prefixPrimary?: boolean;
  fallback?: boolean;
  filter?: Filter;
}

export type SiteError = KestrelError<"TRANSIENT">;

export interface Site {
  /** `path` as the `*path` route param delivers it, without a leading slash. `Ok(null)` when nothing is served there. */
  resolve(type: string, path: string, options?: { rules?: SiteRules }): Promise<Result<ContentDocument | null, SiteError>>;
  /** The inverse of `resolve`; `null` when the document has no slug. */
  pathOf(type: string, document: ContentDocument, options?: { locale?: string; rules?: SiteRules }): string | null;
  resolveLinks(type: string, document: ContentDocument, options?: { locale?: string; rules?: SiteRules }): Promise<Result<ContentDocument, SiteError>>;
}

export const SITE = defineContract<Site>()("site@1", ["resolve", "pathOf", "resolveLinks"]);
