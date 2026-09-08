import TurndownService from "turndown";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Content, ContentDocument, ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { isErr, ok, type KestrelError, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Logger } from "@michaelthielemann/kestrel/logger";

export interface LlmsSettingsConfig {
  type: string;
  titleField: string;
  descriptionField: string;
}

export interface LlmsConfig {
  siteUrl?: string | undefined;
  full: boolean;
  settings: LlmsSettingsConfig;
  titleField: string;
  seoField: string;
  headings: Record<string, string>;
}

export interface LlmsEntry {
  title: string;
  url: string;
  description?: string;
}

export interface LlmsSection {
  heading: string;
  entries: LlmsEntry[];
}

export interface LlmsFullPage extends LlmsEntry {
  body: string;
}

export interface LlmsFullSection {
  heading: string;
  pages: LlmsFullPage[];
}

export const LLMS_KEY = "llms.txt";
export const LLMS_FULL_KEY = "llms-full.txt";
export const LLMS_CONTENT_TYPE = "text/plain; charset=utf-8";

// Pages sit at `###` under their section, so a body's own <h1> starts at `####`.
const BODY_HEADING_OFFSET = 3;

// Editor-authored text: a newline would forge a second document line, a leading marker a heading.
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeBlock(value: string): string {
  return value.replace(/^([#>\-*+]|\d+\.|```)/, "\\$1");
}

function linkText(value: string): string {
  return oneLine(value).replace(/[[\]]/g, "\\$&");
}

export function buildLlmsTxt(opts: { siteName: string; siteDescription?: string; sections: LlmsSection[] }): string {
  const lines: string[] = [`# ${oneLine(opts.siteName)}`];
  if (opts.siteDescription) lines.push("", `> ${escapeBlock(oneLine(opts.siteDescription))}`);
  for (const section of opts.sections) {
    if (section.entries.length === 0) continue;
    lines.push("", `## ${oneLine(section.heading)}`, "");
    for (const e of section.entries) lines.push(`- [${linkText(e.title)}](${e.url})${e.description ? `: ${oneLine(e.description)}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

export function buildLlmsFullTxt(opts: { siteName: string; siteDescription?: string; sections: LlmsFullSection[] }): string {
  const blocks: string[] = [`# ${oneLine(opts.siteName)}`];
  if (opts.siteDescription) blocks.push(`> ${escapeBlock(oneLine(opts.siteDescription))}`);
  for (const section of opts.sections) {
    if (section.pages.length === 0) continue;
    blocks.push(`## ${oneLine(section.heading)}`);
    for (const page of section.pages) {
      blocks.push(`### ${oneLine(page.title)}`, `Source: ${page.url}`);
      if (page.description) blocks.push(escapeBlock(oneLine(page.description)));
      if (page.body) blocks.push(page.body);
    }
  }
  return `${blocks.join("\n\n")}\n`;
}

// Greedy to the last </main> so a nested <main> does not cut the body short.
export function extractMain(html: string): string | null {
  const main = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(html);
  if (main) return main[1] ?? "";
  return null;
}

function bodyOf(html: string): string {
  return /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
}

interface Attributed {
  nodeName: string;
  getAttribute(name: string): string | null;
}

const REMOVED = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "CANVAS", "SVG", "BUTTON", "FORM", "INPUT", "SELECT", "TEXTAREA"]);

export function absolutize(url: string | null, siteUrl: string | undefined): string | null {
  if (!url) return null;
  const value = url.trim();
  if (value === "" || value.startsWith("#") || /^javascript:/i.test(value)) return null;
  if (siteUrl && value.startsWith("/") && !value.startsWith("//")) return `${siteUrl}${value}`;
  return value;
}

export function htmlToMarkdown(html: string, options: { siteUrl?: string; headingOffset?: number } = {}): string {
  const offset = options.headingOffset ?? 0;
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", hr: "---", emDelimiter: "*" });
  td.remove((node) => REMOVED.has(boundaryCast<Attributed>(node, "dom").nodeName.toUpperCase()));
  td.addRule("heading", {
    filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
    replacement: (content, node) => {
      const level = Math.min(6, Number(boundaryCast<Attributed>(node, "dom").nodeName.charAt(1)) + offset);
      return `\n\n${"#".repeat(level)} ${content.trim()}\n\n`;
    },
  });
  td.addRule("link", {
    filter: (node) => boundaryCast<Attributed>(node, "dom").nodeName === "A",
    replacement: (content, node) => {
      const href = absolutize(boundaryCast<Attributed>(node, "dom").getAttribute("href"), options.siteUrl);
      return href ? `[${content}](${href})` : content;
    },
  });
  td.addRule("image", {
    filter: "img",
    replacement: (_content, node) => {
      const el = boundaryCast<Attributed>(node, "dom");
      const src = absolutize(el.getAttribute("src"), options.siteUrl);
      return src ? `![${el.getAttribute("alt") ?? ""}](${src})` : "";
    },
  });
  return td.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
}

export interface LlmsSource {
  type: string;
  path: string;
  locale: string;
  docId: string;
  html(): Promise<Result<string | null, KestrelError>>;
}

export interface LlmsDeps {
  content: Content;
  blobs: Blobstore;
  logger: Logger;
  prefix: string;
  fallback: boolean;
  defaultLocale: string | undefined;
  hasLocales: boolean;
  types: string[];
  sources(type: string): Promise<Result<LlmsSource[], KestrelError>>;
}

export function validateLlmsConfig(config: LlmsConfig, model: ContentModel, formats: string[]): void {
  const settings = model.types[config.settings.type];
  if (!settings) return;
  if (settings.kind !== "single") throw new Error(`delivery/static: llms.settings.type "${config.settings.type}" must be a single type`);
  if (!(config.settings.titleField in settings.fields)) throw new Error(`delivery/static: field "${config.settings.titleField}" does not exist on "${config.settings.type}"`);
  if (config.full && !formats.includes("html")) throw new Error('delivery/static: llms.full needs "html" in formats');
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export async function exportLlms(config: LlmsConfig, deps: LlmsDeps): Promise<Result<{ entries: number; full: boolean }, KestrelError>> {
  const siteUrl = config.siteUrl?.replace(/\/+$/, "");
  const localeOptions = (locale: string) => (locale === "" ? {} : { locale, fallback: deps.fallback });
  let settingsDoc: ContentDocument | null = null;
  if (config.settings.type in deps.content.model().types) {
    const read = await deps.content.get(config.settings.type, undefined, deps.hasLocales && deps.defaultLocale !== undefined ? { locale: deps.defaultLocale, fallback: deps.fallback } : {});
    if (isErr(read)) return read;
    settingsDoc = read.value;
  }
  const siteName = text(settingsDoc?.[config.settings.titleField]) ?? (siteUrl ? new URL(siteUrl).host : "Website");
  const siteDescription = text(settingsDoc?.[config.settings.descriptionField]);

  const sections: LlmsSection[] = [];
  const fullSections: LlmsFullSection[] = [];
  let entries = 0;
  let missingMain = false;
  for (const type of deps.types) {
    const heading = config.headings[type] ?? type;
    const pages: LlmsFullPage[] = [];
    const sources = await deps.sources(type);
    if (isErr(sources)) return sources;
    for (const source of sources.value) {
      const read = await deps.content.get(type, source.docId, localeOptions(source.locale));
      if (isErr(read)) return read;
      const doc = read.value;
      if (!doc) continue;
      const seo = doc[config.seoField];
      const meta = seo && typeof seo === "object" ? (seo as Record<string, unknown>) : {};
      if (meta.noindex === true) continue;
      const description = text(meta.description);
      const entry: LlmsEntry = { title: text(meta.title) ?? text(doc[config.titleField]) ?? source.path, url: `${siteUrl ?? ""}${source.path}`, ...(description === undefined ? {} : { description }) };
      let body = "";
      if (config.full) {
        const stored = await source.html();
        if (isErr(stored)) return stored;
        const html = stored.value;
        if (html === null) {
          deps.logger.error("delivery/static: rendered output missing for llms-full.txt", { type, id: source.docId, locale: source.locale, path: source.path });
        } else {
          const main = extractMain(html);
          if (main === null) missingMain = true;
          body = htmlToMarkdown(main ?? bodyOf(html), { ...(siteUrl === undefined ? {} : { siteUrl }), headingOffset: BODY_HEADING_OFFSET });
        }
      }
      pages.push({ ...entry, body });
    }
    pages.sort((a, b) => a.url.localeCompare(b.url));
    entries += pages.length;
    sections.push({ heading, entries: pages.map((p) => ({ title: p.title, url: p.url, ...(p.description === undefined ? {} : { description: p.description }) })) });
    fullSections.push({ heading, pages });
  }
  if (missingMain) deps.logger.info("delivery/static: rendered output without <main>, llms-full.txt uses the whole body");

  const header = { siteName, ...(siteDescription === undefined ? {} : { siteDescription }) };
  const written = await deps.blobs.put(`${deps.prefix}${LLMS_KEY}`, new TextEncoder().encode(buildLlmsTxt({ ...header, sections })), { contentType: LLMS_CONTENT_TYPE });
  if (isErr(written)) return written;
  const fullFile = config.full
    ? await deps.blobs.put(`${deps.prefix}${LLMS_FULL_KEY}`, new TextEncoder().encode(buildLlmsFullTxt({ ...header, sections: fullSections })), { contentType: LLMS_CONTENT_TYPE })
    : await deps.blobs.remove(`${deps.prefix}${LLMS_FULL_KEY}`);
  if (isErr(fullFile)) return fullFile;
  return ok({ entries, full: config.full });
}
