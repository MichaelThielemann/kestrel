import { createServer } from "node:http";
import { createApp, createRouter, eventHandler, toNodeListener } from "h3";
import { boot } from "@michaelthielemann/kestrel";
import { createKestrelHandler } from "@michaelthielemann/kestrel-h3";
import config from "../embedded/kestrel.config.ts";
import modules from "../embedded/modules.ts";
import countPages from "../embedded/pipelines/countPages.ts";
import createPage from "../embedded/pipelines/createPage.ts";
import login from "../embedded/pipelines/login.ts";
import resolvePage from "../embedded/pipelines/resolvePage.ts";

const kestrel = await boot({ config, modules, pipelines: [login, createPage, resolvePage, countPages] });
await kestrel.start();

const app = createApp();
const router = createRouter();
router.get("/", eventHandler(() => ({ host: "h3", hint: "POST /api/login, then POST /api/pages with Authorization: Bearer <token>; GET /api/site/en" })));
app.use(router);
app.use("/api", createKestrelHandler(kestrel, { mountPath: "/api" }));

const server = createServer(toNodeListener(app));
server.listen(Number(process.env.PORT ?? 3100), "127.0.0.1", () => console.log("h3 host with embedded kestrel on http://127.0.0.1:" + String(process.env.PORT ?? 3100)));
process.once("SIGTERM", () => { server.close(); void kestrel.stop(); });
