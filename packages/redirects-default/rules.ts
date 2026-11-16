import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { compileWildcardPath, matchWildcardPath, type MatchMeter } from "./match.ts";

/**
 * One entry of the published artifact. `from` is the canonical wildcard path (leading slash, no trailing
 * slash, `*` and `**`); `pattern` is the equivalent anchored regex SOURCE string, path-only.
 */
export interface RedirectRule {
  from: string;
  pattern: string;
  target: string;
  status: number;
}

/** The statuses the editor offers. 301/302 cover SEO; 307/308 preserve the method on non-GET requests. */
export const REDIRECT_STATUSES = ["301", "302", "307", "308"] as const;

/** The most wildcards (`*` and `**` together) one `from` may hold. */
export const MAX_WILDCARDS = 8;

/** The longest `from`, in characters, after trimming. */
export const MAX_FROM_LENGTH = 512;

/** The most editor rules one list may hold. */
export const MAX_RULES = 1000;

/** A request path longer than this, in characters, matches no rule. */
export const MAX_LOOKUP_PATH_LENGTH = 2048;

/** The most redirects one request may pass through the editor rules; browsers give up after about as many. */
export const MAX_REDIRECT_HOPS = 20;

/**
 * The most matching work one loop check of the editor rules may take, counted as `MatchMeter` steps. A list that
 * needs more is refused as `too-complex`; the lists the editor offers stay far below it.
 */
export const MAX_LOOP_CHECK_STEPS = 20_000_000;

/**
 * The path prefixes a redirect source may not take unless the configuration says otherwise: the admin
 * routes, the API mount and the public media files.
 */
export const DEFAULT_RESERVED_PATHS: readonly string[] = ["/admin", "/api", "/media"];

/** What `compileRedirects` and `compilePublishableRedirects` check besides the shape of a row. */
export interface CompileOptions {
  /** Prefixes no source may match, the path itself and everything below it; none when absent. */
  reservedPaths?: readonly string[];
}

/** The field of a rule row a rejection is about. */
export type RedirectRuleField = "from" | "to" | "status";

/** Every `RedirectRuleReason`, in the order of the documentation; the closed set a client can switch on. */
export const REDIRECT_RULE_REASONS = [
  "blank",
  "too-long",
  "scheme-or-host",
  "query-or-fragment",
  "control-characters",
  "backslash",
  "dot-segments",
  "adjacent-double-wildcards",
  "too-many-wildcards",
  "reserved-path",
  "protocol-relative",
  "unsupported-scheme",
  "invalid-url",
  "embedded-credentials",
  "placeholder-in-host",
  "placeholder-out-of-range",
  "placeholder-syntax",
  "automatic-redirect-loop",
  "redirect-loop",
  "invalid-status",
  "not-a-list",
  "too-many-rules",
  "too-complex",
] as const;

/**
 * Why a rule or a rule list was rejected. The value is stable: a client can switch on it to show a
 * localized message instead of the English one.
 *
 * Source (`from`): `blank`, `too-long`, `scheme-or-host`, `query-or-fragment`, `control-characters`,
 * `backslash`, `dot-segments`, `adjacent-double-wildcards`, `too-many-wildcards`, `reserved-path`.
 * Target (`to`): `blank`, `control-characters`, `backslash`, `protocol-relative`, `unsupported-scheme`,
 * `invalid-url`, `embedded-credentials`, `placeholder-in-host`, `placeholder-out-of-range`,
 * `placeholder-syntax`, `automatic-redirect-loop`, `redirect-loop`. Status: `invalid-status`. Whole list: `not-a-list`,
 * `too-many-rules`, which is also the reason of each row beyond the limit when a list is published, and `too-complex`,
 * a list whose loop check would take more than `MAX_LOOP_CHECK_STEPS`.
 */
export type RedirectRuleReason = (typeof REDIRECT_RULE_REASONS)[number];

/**
 * The structured form of a rejection, as clients receive it in `details` and in the skipped rows of an export.
 * `row` is the 1-based position in the list. It is absent when saving a list that is rejected as a whole
 * (`not-a-list`, `too-many-rules`, `too-complex`); `field` is absent for those and for a row skipped as `too-many-rules`
 * because it lies beyond the limit. `path` is the offending path where one exists: the reserved prefix for
 * `reserved-path`, the source of the automatic redirect for `automatic-redirect-loop`, the target for `redirect-loop`.
 */
export interface RedirectRuleDetails {
  row?: number;
  field?: RedirectRuleField;
  reason: RedirectRuleReason;
  path?: string;
}

/** A rule the editor has to fix. The message names the 1-based row so it is actionable in the UI; the same facts are in `reason`, `field`, `path` and `row`. */
export class RedirectRuleError extends Error {
  readonly reason: RedirectRuleReason;
  readonly field: RedirectRuleField | undefined;
  readonly path: string | undefined;
  readonly row: number | undefined;

  constructor(message: string, info: RedirectRuleDetails) {
    super(message);
    this.name = "RedirectRuleError";
    this.reason = info.reason;
    this.field = info.field;
    this.path = info.path;
    this.row = info.row;
  }

  /** The structured facts of this rejection, without the keys that do not apply. */
  toDetails(): RedirectRuleDetails {
    return {
      ...(this.row === undefined ? {} : { row: this.row }),
      ...(this.field === undefined ? {} : { field: this.field }),
      reason: this.reason,
      ...(this.path === undefined ? {} : { path: this.path }),
    };
  }

  /** The same rejection located at the 1-based `row`, its message prefixed with `Row <row>: `. */
  atRow(row: number): RedirectRuleError {
    return new RedirectRuleError(`Row ${row}: ${this.message}`, { ...this.toDetails(), row });
  }
}

const ESCAPE = /[.*+?^${}()|[\]\\-]/g;
// eslint-disable-next-line no-control-regex -- deliberately rejects control characters headed for a Location header
const CONTROL = /[\u0000-\u001f\u007f]/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function escapeLiteral(s: string): string {
  return s.replace(ESCAPE, "\\$&");
}

const SEGMENT_CHAR = "[^/\\\\\\x00-\\x1f\\x7f]";
const PATH_CHAR = "[^\\\\\\x00-\\x1f\\x7f]";
const ONE_SEGMENT = `(${SEGMENT_CHAR}+)`;
const MANY_SEGMENTS = `(${SEGMENT_CHAR}${PATH_CHAR}*?)`;

function segmentRegex(segment: string): string {
  return segment.split("*").map(escapeLiteral).join("[^/]+");
}

function matchesReserved(from: string, reserved: string): boolean {
  const pattern = from.split("/").slice(1);
  const prefix = reserved.split("/").slice(1);
  for (const [i, wanted] of prefix.entries()) {
    const segment = pattern[i];
    if (segment === undefined) return false;
    const deep = segment.indexOf("**");
    if (deep !== -1) return new RegExp(`^${segmentRegex(segment.slice(0, deep))}`).test(wanted);
    if (!new RegExp(`^${segmentRegex(segment)}$`).test(wanted)) return false;
  }
  return true;
}

/** The first of `reservedPaths` that a canonical `path` (wildcards allowed) can match, or `undefined`. */
export function reservedPathOf(path: string, reservedPaths: readonly string[]): string | undefined {
  return reservedPaths.find((reserved) => matchesReserved(path, reserved));
}

/**
 * Validate an authored `from` and return its canonical form: leading slash, no trailing slash. Matching is
 * path-only and case-sensitive; an authored trailing slash is dropped and one is tolerated at match time, so
 * `/blog` and `/blog/` are the same rule. A `from` that can match a path in `reservedPaths` is refused.
 */
export function canonicalFrom(from: string, reservedPaths: readonly string[] = []): string {
  const raw = from.trim();
  if (!raw) throw new RedirectRuleError('"From" must not be blank', { field: "from", reason: "blank" });
  if (raw.length > MAX_FROM_LENGTH) throw new RedirectRuleError(`"From" is longer than ${MAX_FROM_LENGTH} characters`, { field: "from", reason: "too-long" });
  if (SCHEME.test(raw) || raw.startsWith("//")) {
    throw new RedirectRuleError('"From" matches the request path only — drop the scheme and host', { field: "from", reason: "scheme-or-host" });
  }
  if (/[?#]/.test(raw)) throw new RedirectRuleError('"From" must not contain a query string or fragment', { field: "from", reason: "query-or-fragment" });
  if (CONTROL.test(raw)) throw new RedirectRuleError('"From" must not contain control characters', { field: "from", reason: "control-characters" });
  if (raw.includes("\\")) throw new RedirectRuleError('"From" must not contain a backslash', { field: "from", reason: "backslash" });
  if (raw.split("/").some((seg) => seg === "..")) throw new RedirectRuleError('"From" must not contain ".."', { field: "from", reason: "dot-segments" });
  if (/\*\*\/?\*\*/.test(raw)) throw new RedirectRuleError('"From" has two `**` in a row — one already matches any number of segments', { field: "from", reason: "adjacent-double-wildcards" });
  const wildcards = wildcardCount(raw);
  if (wildcards > MAX_WILDCARDS) throw new RedirectRuleError(`"From" has ${wildcards} wildcards, at most ${MAX_WILDCARDS} are allowed`, { field: "from", reason: "too-many-wildcards" });
  const canonical = `/${raw.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  const taken = reservedPathOf(canonical, reservedPaths);
  if (taken !== undefined) throw new RedirectRuleError(`"From" can match the reserved path ${taken}, which the application serves itself`, { field: "from", reason: "reserved-path", path: taken });
  return canonical;
}

/** Translate an authored `from` into the anchored regex source that matches what `canonicalFrom` describes. */
export function patternToRegexSource(from: string): string {
  const path = canonicalFrom(from);
  if (path === "/") return "^/$";

  let body = "";
  let last = 0;
  for (const m of path.matchAll(/\*\*|\*/g)) {
    body += escapeLiteral(path.slice(last, m.index)) + (m[0] === "**" ? MANY_SEGMENTS : ONE_SEGMENT);
    last = m.index + m[0].length;
  }
  return `^${body + escapeLiteral(path.slice(last))}/?$`;
}

function wildcardCount(from: string): number {
  return (from.trim().match(/\*\*|\*/g) ?? []).length;
}

/** Anchors a literal, already-canonical path (no wildcards) the same way `patternToRegexSource` tolerates a trailing slash. */
export function exactPathPatternSource(path: string): string {
  return path === "/" ? "^/$" : `^${escapeLiteral(path)}/?$`;
}

/**
 * Normalize an authored `to` into a `Location` value. A path gets its leading slash; an absolute
 * http(s) URL is kept as written with its scheme in lower case (a moved domain is a legitimate target). Everything else is rejected —
 * a `javascript:`/`data:` scheme or a protocol-relative `//host` would turn a redirect into a hazard.
 */
export function normalizeTarget(to: string): string {
  const raw = to.trim();
  if (!raw) throw new RedirectRuleError('"To" must not be blank', { field: "to", reason: "blank" });
  if (CONTROL.test(raw)) throw new RedirectRuleError('"To" must not contain control characters', { field: "to", reason: "control-characters" });
  if (raw.includes("\\")) throw new RedirectRuleError('"To" must not contain a backslash', { field: "to", reason: "backslash" });
  if (raw.startsWith("//")) {
    throw new RedirectRuleError('"To" must not be protocol-relative — write the full https:// URL', { field: "to", reason: "protocol-relative" });
  }
  if (!SCHEME.test(raw)) return `/${raw.replace(/^\/+/, "")}`;

  if (!/^https?:\/\//i.test(raw)) throw new RedirectRuleError('"To" may only use http:// or https://', { field: "to", reason: "unsupported-scheme" });
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RedirectRuleError(`"To" is not a valid URL: ${raw}`, { field: "to", reason: "invalid-url" });
  }
  if (!url.host) throw new RedirectRuleError(`"To" is not a valid URL: ${raw}`, { field: "to", reason: "invalid-url" });
  if (url.username || url.password) throw new RedirectRuleError('"To" must not embed credentials', { field: "to", reason: "embedded-credentials" });
  return raw.replace(SCHEME, (scheme) => scheme.toLowerCase());
}

function assertPlaceholdersAfterHost(target: string): void {
  if (!SCHEME.test(target)) return;
  const firstPlaceholder = target.indexOf("$");
  if (firstPlaceholder === -1) return;
  const pathStart = target.indexOf("/", target.indexOf("://") + 3);
  if (pathStart === -1 || firstPlaceholder < pathStart) {
    throw new RedirectRuleError('"To" may only use $1, $2, … after the host — a placeholder in the host lets a visitor pick the destination', { field: "to", reason: "placeholder-in-host" });
  }
}

function readStatus(value: unknown): number {
  if (value === undefined || value === null || value === "") return 301;
  const s = typeof value === "string" || typeof value === "number" ? String(value) : typeof value;
  if (!(REDIRECT_STATUSES as readonly string[]).includes(s)) {
    throw new RedirectRuleError(`Status must be one of ${REDIRECT_STATUSES.join(", ")} (got ${s})`, { field: "status", reason: "invalid-status" });
  }
  return Number(s);
}

function readText(value: unknown, field: "from" | "to"): string {
  if (typeof value !== "string" || !value.trim()) throw new RedirectRuleError(`"${field === "from" ? "From" : "To"}" must not be blank`, { field, reason: "blank" });
  return value.trim();
}

/**
 * Rows → artifact entries, in authored order (order IS priority: the edge takes the first match).
 * An empty/absent field is zero redirects, a fully supported state — not an error. A row the edge could
 * not honour throws instead of being dropped, so a typo fails the save loudly.
 */
export function compileRedirects(rows: unknown, options: CompileOptions = {}): RedirectRule[] {
  if (rows === null || rows === undefined) return [];
  if (!Array.isArray(rows)) throw new RedirectRuleError("Redirect rules must be a list", { reason: "not-a-list" });
  if (rows.length > MAX_RULES) throw new RedirectRuleError(`at most ${MAX_RULES} redirect rules are allowed, got ${rows.length}`, { reason: "too-many-rules" });

  return rows.map((raw, i) => {
    try {
      const entry = boundaryCast<Record<string, unknown>>(raw ?? {}, "json");
      const from = readText(entry.from, "from");
      const target = normalizeTarget(readText(entry.to, "to"));
      const groups = wildcardCount(from);
      for (const [, n] of target.matchAll(/\$(\d+)/g)) {
        if (Number(n) < 1 || Number(n) > groups) {
          throw new RedirectRuleError(`"To" references $${n} but "From" has ${groups} wildcard(s)`, { field: "to", reason: "placeholder-out-of-range" });
        }
      }
      if (/\$\{/.test(target)) {
        throw new RedirectRuleError('"To" writes a placeholder as $1, $2, … — not ${1}', { field: "to", reason: "placeholder-syntax" });
      }
      assertPlaceholdersAfterHost(target);
      return { from: canonicalFrom(from, options.reservedPaths), pattern: patternToRegexSource(from), target, status: readStatus(entry.status) };
    } catch (err) {
      if (err instanceof RedirectRuleError) throw err.atRow(i + 1);
      throw err;
    }
  });
}

/**
 * The PUBLISHING counterpart of `compileRedirects`. Identical on data the save path accepted. The
 * difference only shows after an upgrade that tightened a rule: a row stored by an older version would
 * otherwise make this artifact unrenderable forever, taking every OTHER redirect down with it. Publishing
 * the rest and naming what was dropped is the lesser failure.
 *
 * A malformed `rows` still throws: that is a read bug, not a bad row, and `[]` would be a lie.
 * `skipped` holds one English line per dropped row; `skippedRules` the same rows in structured form, in the same order.
 */
export function compilePublishableRedirects(rows: unknown, options: CompileOptions = {}): { rules: RedirectRule[]; skipped: string[]; skippedRules: RedirectRuleDetails[] } {
  if (rows === null || rows === undefined) return { rules: [], skipped: [], skippedRules: [] };
  if (!Array.isArray(rows)) throw new RedirectRuleError("Redirect rules must be a list", { reason: "not-a-list" });

  const rules: RedirectRule[] = [];
  const skipped: string[] = [];
  const skippedRules: RedirectRuleDetails[] = [];
  rows.forEach((row, i) => {
    if (i >= MAX_RULES) {
      skipped.push(`Row ${i + 1}: beyond the limit of ${MAX_RULES} rules`);
      skippedRules.push({ row: i + 1, reason: "too-many-rules" });
      return;
    }
    try {
      rules.push(...compileRedirects([row], options));
    } catch (error) {
      if (!(error instanceof RedirectRuleError)) throw error;
      skipped.push(`Row ${i + 1}: ${error.message.replace(/^Row 1: /, "")}`);
      skippedRules.push({ ...error.toDetails(), row: i + 1 });
    }
  });
  return { rules, skipped, skippedRules };
}

/** The path a browser requests after a redirect to the path `target`: no query or fragment, no trailing slash. */
export function targetPath(target: string): string {
  const path = `/${(target.split(/[?#]/)[0] ?? "").replace(/^\/+/, "")}`;
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function rowList(rows: number[]): string {
  const sorted = [...new Set(rows)].sort((a, b) => a - b);
  return `${sorted.length === 1 ? "row" : "rows"} ${sorted.join(", ")}`;
}

/**
 * Refuse editor rules that redirect in a loop. From the source of every rule, a wildcard standing for one
 * sample segment, the rules are followed first match first, as `matchRedirect` does: a path target that
 * comes back to a path already passed, or a chain longer than `MAX_REDIRECT_HOPS`, throws `redirect-loop`
 * at the row whose target closes it, naming the paths and the rows involved. Absolute URL targets end a chain.
 * Each path is matched against the rules once; a list whose matching would take more than `MAX_LOOP_CHECK_STEPS`
 * throws `too-complex` for the whole list.
 */
export function assertNoRedirectLoop(rules: readonly RedirectRule[]): void {
  const matchers = rules.map((rule) => compileWildcardPath(rule.from));
  const meter: MatchMeter = { steps: 0 };
  const hops = new Map<string, { index: number; next: string } | null>();
  const hopFrom = (path: string): { index: number; next: string } | null => {
    const known = hops.get(path);
    if (known !== undefined) return known;
    let hop: { index: number; next: string } | null = null;
    if (path.length <= MAX_LOOKUP_PATH_LENGTH) {
      for (const [index, matcher] of matchers.entries()) {
        const captures = matcher(path, meter);
        if (meter.steps > MAX_LOOP_CHECK_STEPS) {
          throw new RedirectRuleError("Redirect rules are too complex to check for redirect loops: use fewer wildcard rules that can match the same paths, or shorter targets", { reason: "too-complex" });
        }
        if (!captures) continue;
        const target = fillTarget(rules[index]?.target ?? "", captures);
        hop = target.startsWith("/") ? { index, next: targetPath(target) } : null;
        break;
      }
    }
    hops.set(path, hop);
    return hop;
  };
  const remaining = new Map<string, number>();
  for (const rule of rules) {
    const passed = [targetPath(rule.from.replace(/\*\*|\*/g, "sample"))];
    const rows: number[] = [];
    let after = 0;
    for (;;) {
      const current = passed[passed.length - 1] ?? "/";
      const known = remaining.get(current);
      if (known !== undefined && rows.length + known <= MAX_REDIRECT_HOPS) {
        after = known;
        break;
      }
      const hop = hopFrom(current);
      if (!hop) break;
      const row = hop.index + 1;
      rows.push(row);
      const next = hop.next;
      const target = rules[hop.index]?.target ?? next;
      const back = passed.indexOf(next);
      if (back !== -1) {
        const loop = [...passed.slice(back), next];
        throw new RedirectRuleError(`"To" ${target} leads back to ${next}, a redirect loop: ${loop.join(" → ")} (${rowList(rows.slice(back))})`, { field: "to", reason: "redirect-loop", path: target }).atRow(row);
      }
      passed.push(next);
      if (rows.length > MAX_REDIRECT_HOPS) {
        throw new RedirectRuleError(`"To" ${target} leads on through more than ${MAX_REDIRECT_HOPS} redirects without ending: ${passed.slice(0, 3).join(" → ")} → … (${rowList(rows)})`, { field: "to", reason: "redirect-loop", path: target }).atRow(row);
      }
    }
    passed.forEach((path, i) => remaining.set(path, rows.length - i + after));
  }
}

function fillTarget(target: string, captures: readonly string[]): string {
  return target.replace(/\$(\d+)/g, (_, n: string) => captures[Number(n) - 1] ?? "");
}

/** The artifact body. An empty list is a valid document (`[]`), never an absent file. */
export function serializeRedirects(rules: RedirectRule[]): string {
  return JSON.stringify(rules);
}

/**
 * Reference implementation of the edge's match step — first rule that matches wins, `$n` substituted
 * from the captures. Kestrel serves redirects through `redirects.lookup` with exactly this function; an
 * edge handler reproduces it. Matching runs over `from` in time proportional to the path per rule; a path longer than
 * `MAX_LOOKUP_PATH_LENGTH` characters matches nothing.
 */
export function matchRedirect(rules: RedirectRule[], path: string): { target: string; status: number } | null {
  if (path.length > MAX_LOOKUP_PATH_LENGTH) return null;
  for (const rule of rules) {
    const captures = matchWildcardPath(rule.from, path);
    if (!captures) continue;
    return { target: fillTarget(rule.target, captures), status: rule.status };
  }
  return null;
}
