import TurndownService from "turndown";
import type { ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";

export interface LlmsSettingsConfig {
  type: string;
  titleField: string;
  descriptionField: string;
}

export interface LlmsConfig {
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

export const BODY_HEADING_OFFSET = 3;

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

export interface LlmsFullContent {
  siteName: string;
  siteDescription?: string;
  sections: LlmsFullSection[];
}

/** llms-full.txt in consecutive pieces, one or a few per page; their concatenation is the file. */
export function* llmsFullPieces(opts: LlmsFullContent): Generator<string> {
  yield `# ${oneLine(opts.siteName)}`;
  if (opts.siteDescription) yield `\n\n> ${escapeBlock(oneLine(opts.siteDescription))}`;
  for (const section of opts.sections) {
    if (section.pages.length === 0) continue;
    yield `\n\n## ${oneLine(section.heading)}`;
    for (const page of section.pages) {
      yield `\n\n### ${oneLine(page.title)}\n\nSource: ${page.url}`;
      if (page.description) yield `\n\n${escapeBlock(oneLine(page.description))}`;
      if (page.body) yield `\n\n${page.body}`;
    }
  }
  yield "\n";
}

export function buildLlmsFullTxt(opts: LlmsFullContent): string {
  return [...llmsFullPieces(opts)].join("");
}

export function extractMain(html: string): string | null {
  const main = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(html);
  if (main) return main[1] ?? "";
  return null;
}

export function bodyOf(html: string): string {
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

export function validateLlmsConfig(config: LlmsConfig, model: ContentModel, formats: string[]): void {
  const settings = model.types[config.settings.type];
  if (!settings) return;
  if (settings.kind !== "single") throw new Error(`delivery/static: llms.settings.type "${config.settings.type}" must be a single type`);
  if (!(config.settings.titleField in settings.fields)) throw new Error(`delivery/static: field "${config.settings.titleField}" does not exist on "${config.settings.type}"`);
  if (config.full && !formats.includes("html")) throw new Error('delivery/static: llms.full needs "html" in formats');
}
