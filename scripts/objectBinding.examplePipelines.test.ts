import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanExamplePipelines } from "./objectBinding.examplePipelines.ts";

describe("scanExamplePipelines", () => {
  it("flattens an atomic group into its bare step names, in order", () => {
    const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-example-pipelines-"));
    try {
      const pipelinesDir = join(root, "demo", "pipelines");
      mkdirSync(pipelinesDir, { recursive: true });
      writeFileSync(
        join(pipelinesDir, "createPage.ts"),
        `import { definePipeline } from "../modules.ts";
export default definePipeline({
  name: "createPage",
  steps: ["authn.requireUser", { atomic: ["content.create:pages", "references.index:pages"] }, "events.emit:page.created"],
});
`,
      );
      const pipelines = scanExamplePipelines(root);
      expect(pipelines).toEqual([{ file: join(pipelinesDir, "createPage.ts"), name: "createPage", steps: ["authn.requireUser", "content.create", "references.index", "events.emit"] }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
