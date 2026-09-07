import { ok } from "@michaelthielemann/kestrel/result";
import type { Renderer, RenderInput, RenderOutput } from "@michaelthielemann/kestrel-contracts/renderer";

export interface Config {
  titleField: string;
  siteName: string;
}

function escape(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export function renderHtml(config: Config, input: RenderInput): string {
  const title = input.document[config.titleField];
  const heading = typeof title === "string" ? title : input.path;
  return [
    "<!doctype html>",
    `<html lang="${escape(input.locale ?? "")}">`,
    `<head><meta charset="utf-8"><title>${escape(heading)} – ${escape(config.siteName)}</title></head>`,
    `<body><main><h1>${escape(heading)}</h1><pre>${escape(JSON.stringify(input.document, null, 2))}</pre></main></body>`,
    "</html>",
    "",
  ].join("\n");
}

export function createRendererPlain(config: Config): Renderer {
  return {
    formats: () => ["html"],
    async render(input) {
      if (input.format !== "html") throw new Error(`renderer/plain: unsupported format "${input.format}"`);
      return ok<RenderOutput>({ data: renderHtml(config, input), contentType: "text/html; charset=utf-8", extension: "html" });
    },
  };
}
