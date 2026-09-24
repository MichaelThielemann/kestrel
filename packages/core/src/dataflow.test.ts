import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { boundaryCast } from "./cast.ts";
import { checkDataflow } from "./dataflow.ts";
import type { StepDescription } from "./defineModule.ts";
import { KestrelBootError } from "./errors.ts";
import { ok } from "./result.ts";
import type { ResolvedPipeline } from "./runner.ts";
import { parseRoute, type Route } from "./triggers/http.ts";

const PACKAGE_JSON = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");

describe("package exports", () => {
  it("does not publish ./dataflow, so checkDataflowCollecting stays out of the public surface", () => {
    const pkg = boundaryCast<{ exports: Record<string, unknown>; publishConfig: { exports: Record<string, unknown> } }>(
      JSON.parse(readFileSync(PACKAGE_JSON, "utf8")),
      "json",
    );
    expect(Object.keys(pkg.exports)).not.toContain("./dataflow");
    expect(Object.keys(pkg.publishConfig.exports)).not.toContain("./dataflow");
  });
});

const DECLARED: Record<string, Pick<StepDescription, "reads" | "writes">> = {
  "authn.identifyUser": { reads: [], writes: ["token?", "identity?"] },
  "authn.requireUser": { reads: [], writes: ["token", "identity"] },
  "authn.loadIdentity": { reads: ["identity"], writes: ["result"] },
  "authn.getUser": { reads: ["params.id"], writes: ["result"] },
  "content.create": { reads: [], writes: ["result"] },
  "content.update": { reads: ["params.id"], writes: ["result"] },
  "delivery.exportLlms": { reads: [], writes: ["result.llms"] },
  "delivery.publish": { reads: ["result.id"], writes: ["result"] },
  "images.attach": { reads: ["result"], writes: ["result.variants"] },
  "images.serve": { reads: ["params.id", "params.file"], writes: ["result"] },
  "media.upload": { reads: ["files"], writes: ["result"] },
  "probe.llms": { reads: ["result.llms"], writes: [] },
  "redirects.render": { reads: ["payload.rows"], writes: ["result"] },
  "site.resolve": { reads: ["params.path"], writes: ["result"] },
  "verify.user": { reads: [], writes: ["verifiedUser"] },
  "revisions.reassignAuthor": { reads: ["verifiedUser?"], writes: ["result"] },
  "probe.identity": { reads: ["identity?"], writes: [] },
  "probe.resultX": { reads: ["result.x?"], writes: [] },
  "probe.result": { reads: ["result?"], writes: [] },
  "content.replace": { reads: [], writes: ["result"] },
  "content.setX": { reads: [], writes: ["result.x"] },
};

function pipeline(name: string, steps: readonly string[]): ResolvedPipeline {
  return {
    name,
    steps: steps.map((step) => {
      const declared = DECLARED[step];
      if (!declared) throw new Error(`no declaration for "${step}"`);
      return { name: step, fn: async (ctx) => ok(ctx), description: { summary: step, ...declared } };
    }),
  };
}

function routes(pipelineName: string, ...specs: string[]): Route[] {
  return specs.map((spec) => parseRoute(spec, pipelineName));
}

describe("checkDataflow", () => {
  it("rejects a read of a value only an optional write may provide", () => {
    const p = pipeline("me", ["authn.identifyUser", "authn.loadIdentity"]);
    expect(() => checkDataflow(p, routes("me", "GET /me"), false, false)).toThrow(KestrelBootError);
    expect(() => checkDataflow(p, routes("me", "GET /me"), false, false)).toThrow(/\[pipelines\/me\] step "authn.loadIdentity" reads "identity" but no earlier step writes it \(earlier writes: none\)/);
  });

  it("accepts the same read after a step that writes it unconditionally", () => {
    const p = pipeline("me", ["authn.requireUser", "authn.loadIdentity"]);
    expect(() => checkDataflow(p, routes("me", "GET /me"), false, false)).not.toThrow();
  });

  it("lists the earlier writes in the error", () => {
    const p = pipeline("bad", ["content.create", "authn.loadIdentity"]);
    expect(() => checkDataflow(p, routes("bad", "POST /pages"), false, false)).toThrow(/\(earlier writes: result\)/);
  });

  it("rejects a params read in a cron-only pipeline and accepts it with an event trigger", () => {
    const p = pipeline("sweep", ["authn.getUser"]);
    expect(() => checkDataflow(p, [], true, false)).toThrow(/step "authn.getUser" reads "params.id"/);
    expect(() => checkDataflow(p, [], false, true)).not.toThrow();
  });

  it("accepts a params read a route binds and rejects one no route binds", () => {
    const p = pipeline("getUser", ["authn.getUser"]);
    expect(() => checkDataflow(p, routes("getUser", "GET /users/:id"), false, false)).not.toThrow();
    expect(() => checkDataflow(p, routes("getUser", "GET /users/:userId"), false, false)).toThrow(/reads "params.id"/);
  });

  it("only counts a param that every http route of the pipeline binds", () => {
    const p = pipeline("getUser", ["authn.getUser"]);
    expect(() => checkDataflow(p, routes("getUser", "GET /users/:id", "PATCH /users/:id"), false, false)).not.toThrow();
    expect(() => checkDataflow(p, routes("getUser", "GET /users/:id", "GET /me"), false, false)).toThrow(/reads "params.id"/);
  });

  it("takes a wildcard segment as a param", () => {
    const p = pipeline("site", ["site.resolve"]);
    expect(() => checkDataflow(p, routes("site", "GET /*path"), false, false)).not.toThrow();
  });

  it("accepts a params read in a pipeline with no trigger at all", () => {
    const p = pipeline("embedded", ["authn.getUser"]);
    expect(() => checkDataflow(p, [], false, false)).not.toThrow();
  });

  it("satisfies a dotted read with a write of its parent", () => {
    const p = pipeline("publish", ["content.create", "delivery.publish"]);
    expect(() => checkDataflow(p, routes("publish", "POST /pages"), false, false)).not.toThrow();
  });

  it("satisfies a bare read with a write of one of its keys", () => {
    const p = pipeline("llms", ["delivery.exportLlms", "images.attach"]);
    expect(() => checkDataflow(p, routes("llms", "GET /llms.txt"), false, false)).not.toThrow();
  });

  it("rejects a dotted read after nothing wrote the parent", () => {
    const p = pipeline("publish", ["delivery.publish"]);
    expect(() => checkDataflow(p, routes("publish", "POST /pages"), false, false)).toThrow(/reads "result.id"/);
  });

  it("a plain result write replaces earlier result.* writes", () => {
    const kept = pipeline("kept", ["content.create", "delivery.exportLlms", "probe.llms"]);
    expect(() => checkDataflow(kept, routes("kept", "POST /pages"), false, false)).not.toThrow();
    const replaced = pipeline("replaced", ["delivery.exportLlms", "content.create", "authn.loadIdentity"]);
    expect(() => checkDataflow(replaced, routes("replaced", "POST /pages"), false, false)).toThrow(/\(earlier writes: result\)/);
  });

  it("never checks payload reads", () => {
    const p = pipeline("render", ["redirects.render"]);
    expect(() => checkDataflow(p, [], true, false)).not.toThrow();
  });

  it("treats files, headers, ip and params as always present", () => {
    const p = pipeline("upload", ["media.upload"]);
    expect(() => checkDataflow(p, routes("upload", "POST /media"), false, false)).not.toThrow();
  });

  it("requires every param a step reads", () => {
    const p = pipeline("serve", ["images.serve"]);
    expect(() => checkDataflow(p, routes("serve", "GET /images/:id/:file"), false, false)).not.toThrow();
    expect(() => checkDataflow(p, routes("serve", "GET /images/:id"), false, false)).toThrow(/reads "params.file"/);
  });

  it("accepts an optional read of a key nothing in the pipeline writes", () => {
    const p = pipeline("reassign", ["revisions.reassignAuthor"]);
    expect(() => checkDataflow(p, routes("reassign", "POST /reassign"), false, false)).not.toThrow();
  });

  it("accepts an optional read of a key an earlier step writes", () => {
    const p = pipeline("reassign", ["verify.user", "revisions.reassignAuthor"]);
    expect(() => checkDataflow(p, routes("reassign", "POST /reassign"), false, false)).not.toThrow();
  });

  it("rejects an optional read of a key only a later step writes", () => {
    const p = pipeline("reassign", ["revisions.reassignAuthor", "verify.user"]);
    expect(() => checkDataflow(p, routes("reassign", "POST /reassign"), false, false)).toThrow(KestrelBootError);
    expect(() => checkDataflow(p, routes("reassign", "POST /reassign"), false, false)).toThrow(
      /\[pipelines\/reassign\] step "revisions.reassignAuthor" optionally reads "verifiedUser" but step "verify.user" writes it later/,
    );
  });

  it("accepts an optional read after an earlier optional write, even with a required writer later (real authn.identifyUser/requireUser shape)", () => {
    const p = pipeline("me", ["authn.identifyUser", "probe.identity", "authn.requireUser"]);
    expect(() => checkDataflow(p, routes("me", "GET /me"), false, false)).not.toThrow();
  });

  it("rejects a dotted optional read only a later bare write provides", () => {
    const p = pipeline("replace", ["probe.resultX", "content.replace"]);
    expect(() => checkDataflow(p, routes("replace", "POST /replace"), false, false)).toThrow(
      /\[pipelines\/replace\] step "probe.resultX" optionally reads "result.x" but step "content.replace" writes it later/,
    );
  });

  it("rejects a bare optional read only a later dotted write provides", () => {
    const p = pipeline("setX", ["probe.result", "content.setX"]);
    expect(() => checkDataflow(p, routes("setX", "POST /setX"), false, false)).toThrow(
      /\[pipelines\/setX\] step "probe.result" optionally reads "result" but step "content.setX" writes it later/,
    );
  });
});
