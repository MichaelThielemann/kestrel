import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fakeFailure, fakeJson, passesCreatedAts, type FakeCloudFoundry, type FakeCfApp } from "./fakeCloudFoundry.fixture.ts";

/** One package the fake created from a directory. */
export interface FakePackage {
  guid: string;
  app: string;
  dir: string;
}

/** A crash or failed start the fake reports as an audit event of an app. */
export interface FakeCrash {
  app: string;
  type: string;
  created_at: string;
  data: { exit_description?: string; reason?: string };
}

/** Packages, staging and crash events of a {@link FakeCloudFoundry}, registered through its routes and commands. */
export interface FakeStaging {
  packages: FakePackage[];
  /** Droplets staged, in order. */
  droplets: string[];
  /** The standard error a staging attempt fails with, or null. */
  failStaging: string | null;
  /** The health check type the web process reports, by app name; `port` when absent. */
  healthChecks: Map<string, string>;
  crashes: FakeCrash[];
}

/**
 * Registers `cf create-package <app> -p <dir>`, `cf stage-package <app> --package-guid <guid>`, the web process with
 * its health check and audit events with crashes on `cf`. Staging never changes the app's state or droplet.
 */
export function installStaging(cf: FakeCloudFoundry): FakeStaging {
  const staging: FakeStaging = { packages: [], droplets: [], failStaging: null, healthChecks: new Map(), crashes: [] };
  const appNamed = (name: string): FakeCfApp | undefined => cf.all.find((app) => app.name === name && app.org === cf.org && app.space === cf.space);
  cf.commands.set("create-package", (args) => {
    const app = appNamed(args[0] ?? "");
    const dir = args[args.indexOf("-p") + 1] ?? "";
    if (app === undefined) return fakeFailure(`App '${args[0] ?? ""}' not found.\n`);
    if (!args.includes("-p") || !existsSync(dir)) return fakeFailure("Incorrect Usage: the app path does not exist\n");
    const guid = randomUUID();
    staging.packages.push({ guid, app: app.name, dir });
    return { code: 0, stdout: `Uploading and creating bits package for app ${app.name} in org ${cf.org} / space ${cf.space} as operator...\nPackage with guid '${guid}' created.\nOK\n`, stderr: "" };
  });
  cf.commands.set("stage-package", (args) => {
    const app = appNamed(args[0] ?? "");
    const pkg = args[args.indexOf("--package-guid") + 1] ?? "";
    if (app === undefined) return fakeFailure(`App '${args[0] ?? ""}' not found.\n`);
    if (!staging.packages.some((p) => p.guid === pkg && p.app === app.name)) return fakeFailure(`Package '${pkg}' not found.\n`);
    if (staging.failStaging !== null) return { code: 1, stdout: `Staging package for ${app.name}...\n   -----> Building\nFAILED\n`, stderr: `${staging.failStaging}\n` };
    const droplet = randomUUID();
    staging.droplets.push(droplet);
    return { code: 0, stdout: `Staging package for ${app.name} in org ${cf.org} / space ${cf.space} as operator...\n   -----> Building\nPackage staged\n\ndroplet guid:     ${droplet}\nstate:            staged\ncreated:          Sun 15 Nov 01:00:00 UTC 2026\n\nOK\n`, stderr: "" };
  });
  cf.routes.push(({ method, url, app }) => {
    if (method !== "GET") return undefined;
    if (app !== undefined && url.pathname === `/v3/apps/${app.guid}/processes/web`) return fakeJson({ type: "web", instances: app.instances, health_check: { type: staging.healthChecks.get(app.name) ?? "port", data: {} } });
    if (url.pathname !== "/v3/audit_events") return undefined;
    const target = cf.all.find((a) => a.guid === url.searchParams.get("target_guids"));
    if (target === undefined) return fakeJson({ resources: [] });
    const crashes = staging.crashes.filter((c) => c.app === target.name).map(({ type, created_at, data }) => ({ type, created_at, data }));
    const events = [...crashes, ...target.events.map((e) => ({ ...e, data: {} }))].filter((e) => passesCreatedAts(url, e.created_at));
    return fakeJson({ resources: events.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)) });
  });
  return staging;
}
