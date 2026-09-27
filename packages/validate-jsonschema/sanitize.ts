import { declaresType, isSchemaNode, resolveSchema, typeTag, type SchemaNode } from "@michaelthielemann/kestrel-contracts/helpers/json-schema";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import sanitizeHtml from "sanitize-html";

/** The ids the HTML sanitizer keeps: an ASCII letter, then up to 63 ASCII letters, digits, `-` or `_`. Any other `id` is dropped, so stored content cannot take an id that starts like a framework's own (`__…`). */
export const HTML_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function withoutBadId(attribs: Record<string, string>): Record<string, string> {
  if (attribs.id === undefined || HTML_ID_PATTERN.test(attribs.id)) return attribs;
  return Object.fromEntries(Object.entries(attribs).filter(([name]) => name !== "id"));
}

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
    "*": (tagName: string, attribs: Record<string, string>) => {
      const kept = withoutBadId(attribs);
      return { tagName, attribs: tagName === "a" && kept.target === "_blank" ? { ...kept, rel: "noopener noreferrer" } : kept };
    },
  },
};

export function sanitize(html: string): string {
  return sanitizeHtml(html, HTML_ALLOWLIST);
}

type Node = SchemaNode;

function pickBranch(root: Node, branches: unknown[], value: unknown): Node | undefined {
  const schemas = branches.map((b) => resolveSchema(root, b));
  const tag = isSchemaNode(value) ? value.type : undefined;
  if (schemas.some((schema) => typeTag(schema) !== undefined)) return schemas.find((schema) => typeTag(schema) !== undefined && typeTag(schema) === tag);
  return schemas.find((schema) => schema !== undefined && declaresType(schema, value));
}

export function sanitizeBySchema(root: Node, schema: unknown, value: unknown): unknown {
  const s = resolveSchema(root, schema);
  if (!s) return value;
  if (Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) {
    const branch = pickBranch(root, boundaryCast<unknown[]>(s.oneOf ?? s.anyOf, "json"), value);
    return branch ? sanitizeBySchema(root, branch, value) : value;
  }
  if (typeof value === "string") return s.format === "html" ? sanitize(value) : value;
  if (Array.isArray(value)) {
    if (s.items === undefined) return value;
    return value.map((v) => sanitizeBySchema(root, s.items, v));
  }
  if (isSchemaNode(value)) {
    const properties = boundaryCast<Record<string, unknown> | undefined>(s.properties, "json") ?? {};
    const out: Node = {};
    for (const [k, v] of Object.entries(value)) {
      const child = properties[k] ?? (typeof s.additionalProperties === "object" ? s.additionalProperties : undefined);
      out[k] = child === undefined ? v : sanitizeBySchema(root, child, v);
    }
    return out;
  }
  return value;
}
