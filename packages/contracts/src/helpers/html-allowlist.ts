/** The tags HTML kept by the sanitizer may contain. */
export const HTML_ALLOWED_TAGS: readonly string[] = [
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "code", "em", "strong", "b", "i", "u", "s", "sub", "sup", "small", "mark",
  "ul", "ol", "li", "dl", "dt", "dd", "a", "img", "figure", "figcaption", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "span", "div",
];

/** The attributes kept per tag; `*` holds those every tag may carry. */
export const HTML_ALLOWED_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ["href", "title", "target", "rel", "data-kestrel-broken"],
  img: ["src", "alt", "title", "width", "height", "loading"],
  th: ["colspan", "rowspan", "scope"],
  td: ["colspan", "rowspan"],
  "*": ["id", "class", "lang", "dir"],
};

/** The URL schemes an `href` may use; a reference without a scheme is relative and always allowed unless it is protocol-relative. */
export const HTML_ALLOWED_SCHEMES: readonly string[] = ["http", "https", "mailto", "tel", "kestrel"];

/** The URL schemes an `img` `src` may use. `data:` is allowed here and nowhere else. */
export const HTML_IMG_SCHEMES: readonly string[] = ["http", "https", "data"];

/** The ids kept: an ASCII letter, then up to 63 ASCII letters, digits, `-` or `_`. Any other `id` is dropped, so stored content cannot take an id that starts like a framework's own (`__…`). */
export const HTML_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const URL_ATTRIBUTES: ReadonlySet<string> = new Set(["href", "src"]);

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

function trimControl(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  return value.slice(start, end);
}

/**
 * Whether the sanitizer keeps `value` as the `attribute` (`href` or `src`) of `tagName`. The value is read the way a
 * browser reads a URL: surrounding control characters and spaces and every tab and line break are ignored, so
 * `java<tab>script:` is the scheme `javascript`. A reference starting with two slashes or backslashes names another
 * host and is refused; a reference without a scheme is relative and kept.
 */
export function isAllowedHtmlUrl(tagName: string, attribute: string, value: string): boolean {
  const cleaned = trimControl(value).replace(/[\t\n\r]/g, "");
  if (/^[\\/]{2}/.test(cleaned)) return false;
  const scheme = SCHEME.exec(cleaned)?.[1]?.toLowerCase();
  if (scheme === undefined) return true;
  const imageSource = tagName.toLowerCase() === "img" && attribute.toLowerCase() === "src";
  return (imageSource ? HTML_IMG_SCHEMES : HTML_ALLOWED_SCHEMES).includes(scheme);
}

function forcedRel(rel: string | undefined): string {
  const others = (rel ?? "").toLowerCase().split(/\s+/).filter((token) => token !== "" && token !== "opener" && token !== "noopener" && token !== "noreferrer");
  return ["noopener", "noreferrer", ...new Set(others)].join(" ");
}

function opensInOtherContext(target: string): boolean {
  return target !== "" && target.toLowerCase() !== "_self";
}

/**
 * The attributes of one element after the rules every sanitizer path applies on top of the tag and attribute
 * lists: an `id` that does not match {@link HTML_ID_PATTERN} is dropped, an `href` or `src` that
 * {@link isAllowedHtmlUrl} refuses is dropped, and a link whose `target` is not `_self` gets `rel="noopener
 * noreferrer"` (`opener` removed, other tokens kept). Names are compared without regard to case; the order of the
 * attributes is kept and a new `rel` comes last.
 */
export function normalizeHtmlAttributes(tagName: string, attribs: Readonly<Record<string, string>>): Record<string, string> {
  const tag = tagName.toLowerCase();
  const kept = new Map<string, string>();
  for (const [name, value] of Object.entries(attribs)) {
    const lower = name.toLowerCase();
    if (lower === "id" && !HTML_ID_PATTERN.test(value)) continue;
    if (URL_ATTRIBUTES.has(lower) && !isAllowedHtmlUrl(tag, lower, value)) continue;
    kept.set(name, value);
  }
  if (tag === "a") {
    const entries = [...kept];
    const target = entries.find(([name]) => name.toLowerCase() === "target")?.[1];
    if (target !== undefined && opensInOtherContext(target)) {
      const existing = entries.find(([name]) => name.toLowerCase() === "rel");
      kept.set(existing?.[0] ?? "rel", forcedRel(existing?.[1]));
    }
  }
  return Object.fromEntries(kept);
}
