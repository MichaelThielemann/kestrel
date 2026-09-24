import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_FILE = join(HERE, "..", "..", "..", "docs", "upgrading.md");

function cutoverSection(markdown: string): string {
  const start = markdown.indexOf("## Cutover");
  const end = markdown.indexOf("\n## ", start + 1);
  return markdown.slice(start, end === -1 ? undefined : end);
}

describe("the cutover docs state the real drain condition", () => {
  it("names events.readQueueStatus with pending and running at 0 as the condition for stepping back to events-direct", () => {
    const section = cutoverSection(readFileSync(DOCS_FILE, "utf8"));
    expect(section).toContain("events.readQueueStatus");
    expect(section).toMatch(/pending.*running.*(0|zero)|running.*pending.*(0|zero)/s);
  });

  it("does not claim the pipeline-less data findings alone mean the queue is drained", () => {
    const section = cutoverSection(readFileSync(DOCS_FILE, "utf8"));
    const stepFive = section.slice(section.indexOf("5."));
    expect(stepFive).not.toMatch(/queue-unfanned.*queue-dead-unassigned.*report nothing/s);
  });
});
