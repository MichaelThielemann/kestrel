import { boot, matchRoute } from "@michaelthielemann/kestrel";
import config from "./kestrel.config.ts";
import modules from "./modules.ts";
import countPages from "./pipelines/countPages.ts";
import createPage from "./pipelines/createPage.ts";
import listMigrations from "./pipelines/listMigrations.ts";
import login from "./pipelines/login.ts";
import resolvePage from "./pipelines/resolvePage.ts";

const kestrel = await boot({
  config,
  modules,
  pipelines: [login, createPage, resolvePage, countPages, listMigrations],
});
await kestrel.start();

const session = await kestrel.run("login", { trigger: { kind: "http", name: "embedded" }, payload: { username: "editor", password: "kestrel-demo" } });
if (session.status !== 200) throw new Error("login failed");
const headers = { authorization: `Bearer ${(session.result as { token: string }).token}` };

const denied = await kestrel.run("createPage", { trigger: { kind: "http", name: "embedded" }, payload: { slug: "home", title: "Startseite", status: "published" } });
console.log("createPage without a session:", denied.status);

const created = await kestrel.run("createPage", { trigger: { kind: "http", name: "embedded" }, headers, payload: { slug: "home", title: "Startseite", status: "published" } });
console.log("created:", created.status, created.result);

const match = matchRoute(kestrel.triggers.http, "GET", "/site/en");
if (!match) throw new Error("no route");
const page = await kestrel.run(match.route.pipeline, { trigger: { kind: "http", name: "GET /site/en" }, params: match.params, headers: {} });
console.log("resolved /site/en:", page.status, page.result);

await kestrel.stop();
