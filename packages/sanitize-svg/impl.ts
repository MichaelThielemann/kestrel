import sanitizeHtml from "sanitize-html";

const FILTER_PRIMITIVES = [
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feDropShadow",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
  "feSpecularLighting",
  "feSpotLight",
  "fePointLight",
  "feDistantLight",
  "feTile",
  "feTurbulence",
];

const ALLOWED_TAGS = [
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "defs",
  "use",
  "symbol",
  "clipPath",
  "mask",
  "linearGradient",
  "radialGradient",
  "stop",
  "pattern",
  "marker",
  "title",
  "desc",
  "filter",
  ...FILTER_PRIMITIVES,
];

const ALLOWED_ATTRIBUTES = [
  "id",
  "class",
  "viewBox",
  "width",
  "height",
  "x",
  "y",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "x1",
  "y1",
  "x2",
  "y2",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "transform",
  "clip-path",
  "mask",
  "filter",
  "fill-rule",
  "clip-rule",
  "font-family",
  "font-size",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "gradientTransform",
  "patternUnits",
  "xmlns",
  "xmlns:xlink",
  "preserveAspectRatio",
  "marker-start",
  "marker-mid",
  "marker-end",
  "href",
  "xlink:href",
];

const HREF_ATTRIBUTES = new Set(["href", "xlink:href"]);

function dropExternalHrefs(tagName: string, attribs: sanitizeHtml.Attributes): sanitizeHtml.Tag {
  const attribs2: sanitizeHtml.Attributes = {};
  for (const [name, value] of Object.entries(attribs)) {
    if (HREF_ATTRIBUTES.has(name) && !value.startsWith("#")) continue;
    attribs2[name] = value;
  }
  return { tagName, attribs: attribs2 };
}

function options(): sanitizeHtml.IOptions {
  return {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { "*": ALLOWED_ATTRIBUTES },
    allowedSchemes: [],
    transformTags: { "*": dropExternalHrefs },
    parser: { lowerCaseTags: false, lowerCaseAttributeNames: false },
  };
}

export function sanitizeSvg(svg: string): string {
  const cleaned = sanitizeHtml(svg, options()).trim();
  const start = cleaned.indexOf("<svg");
  if (start === -1) throw new Error("sanitize/svg: no svg root element");
  return cleaned.slice(start);
}

export function isSvg(contentType: string): boolean {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "image/svg+xml";
}
