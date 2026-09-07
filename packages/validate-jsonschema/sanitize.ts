import sanitizeHtml from "sanitize-html";

export const HTML_ALLOWLIST = {
  allowedTags: [
    "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "code", "em", "strong", "b", "i", "u", "s", "sub", "sup", "small", "mark",
    "ul", "ol", "li", "dl", "dt", "dd", "a", "img", "figure", "figcaption", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "span", "div",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel", "data-kestrel-broken"],
    img: ["src", "alt", "title", "width", "height", "loading"],
    th: ["colspan", "rowspan", "scope"],
    td: ["colspan", "rowspan"],
    "*": ["id", "class", "lang", "dir"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel", "kestrel"],
  allowedSchemesByTag: { img: ["http", "https", "data"] },
  allowedSchemesAppliedToAttributes: ["href", "src"],
  allowProtocolRelative: false,
  disallowedTagsMode: "discard" as const,
  transformTags: {
    a: (tagName: string, attribs: Record<string, string>) => ({ tagName, attribs: attribs.target === "_blank" ? { ...attribs, rel: "noopener noreferrer" } : attribs }),
  },
};

export function sanitize(html: string): string {
  return sanitizeHtml(html, HTML_ALLOWLIST);
}

type Node = Record<string, unknown>;

function resolveRef(root: Node, node: unknown): Node | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const n = node as Node;
  if (typeof n.$ref !== "string") return n;
  if (!n.$ref.startsWith("#/")) return undefined;
  return n.$ref.slice(2).split("/").reduce<unknown>((o, k) => (typeof o === "object" && o !== null ? (o as Node)[k] : undefined), root) as Node | undefined;
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// A tagged union (block nodes) is selected by properties.type.const; a plain
// `anyOf: [schema, {type:"null"}]` wrapper has no discriminator and is selected by type.
function pickBranch(root: Node, branches: unknown[], value: unknown): Node | undefined {
  const schemas = branches.map((b) => resolveRef(root, b));
  const tag = typeof value === "object" && value !== null ? (value as Node).type : undefined;
  let tagged = false;
  for (const schema of schemas) {
    const constant = ((schema?.properties as Node | undefined)?.type as Node | undefined)?.const;
    if (constant === undefined) continue;
    tagged = true;
    if (constant === tag) return schema;
  }
  if (tagged) return undefined;
  const kind = jsonType(value);
  return schemas.find((schema) => schema?.type === kind);
}

export function sanitizeBySchema(root: Node, schema: unknown, value: unknown): unknown {
  const s = resolveRef(root, schema);
  if (!s) return value;
  if (Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) {
    const branch = pickBranch(root, (s.oneOf ?? s.anyOf) as unknown[], value);
    return branch ? sanitizeBySchema(root, branch, value) : value;
  }
  if (typeof value === "string") return s.format === "html" ? sanitize(value) : value;
  if (Array.isArray(value)) {
    if (s.items === undefined) return value;
    return value.map((v) => sanitizeBySchema(root, s.items, v));
  }
  if (typeof value === "object" && value !== null) {
    const properties = (s.properties as Record<string, unknown> | undefined) ?? {};
    const out: Node = {};
    for (const [k, v] of Object.entries(value as Node)) {
      const child = properties[k] ?? (typeof s.additionalProperties === "object" ? s.additionalProperties : undefined);
      out[k] = child === undefined ? v : sanitizeBySchema(root, child, v);
    }
    return out;
  }
  return value;
}
