#!/usr/bin/env bash
# Builds and packs every package, installs the tarballs into a throwaway consumer project
# outside the workspace, boots it and runs a few requests. Fails on the first problem.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${SMOKE_DIR:-$(mktemp -d)}"
PORT="${SMOKE_PORT:-3123}"
SCOPE="@michaelthielemann/kestrel"
BEFORE="${SMOKE_BEFORE:-$(node -e 'process.stdout.write(new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString())')}"
NPM_INSTALL=(npm install --no-audit --no-fund --loglevel=error --ignore-scripts --before="$BEFORE")
mkdir -p "$WORK/tarballs" "$WORK/consumer/pipelines"

echo "== build"
(cd "$ROOT" && pnpm build)

echo "== pack into $WORK/tarballs"
for dir in "$ROOT"/packages/*/; do
  (cd "$dir" && pnpm pack --pack-destination "$WORK/tarballs" >/dev/null)
done
ls "$WORK/tarballs"

echo "== consumer project"
HASH="$(cd "$ROOT" && node -e 'import("./packages/authn-single/impl.ts").then(m => process.stdout.write(m.hashPassword("smoke")))')"
cd "$WORK/consumer"
deps=""
for tgz in "$WORK"/tarballs/*.tgz; do
  name="$(tar -xzOf "$tgz" package/package.json | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).name))")"
  deps="$deps\"$name\": \"file:$tgz\","
done
cat > package.json <<JSON
{ "name": "smoke-consumer", "private": true, "type": "module", "dependencies": { ${deps%,} } }
JSON
cat > kestrel.config.ts <<TS
import { defineConfig } from "$SCOPE/defineConfig";

export default defineConfig({
  modules: [
    { use: "$SCOPE-events-inmemory", config: {} },
    { use: "$SCOPE-events-direct", config: {} },
    { use: "$SCOPE-persistence-sqlite", config: { file: "./data/smoke.db" } },
    { use: "$SCOPE-authn-single", config: { username: "admin", passwordHash: "$HASH", roles: ["admin"] } },
    { use: "$SCOPE-authz-roles", config: { roles: { admin: ["*"] }, anonymous: ["pages.read"], anonymousFields: { pages: ["id", "slug", "title"] } } },
    { use: "$SCOPE-content-default", config: { types: { pages: { kind: "multi", fields: { slug: { type: "slug", required: true, unique: true }, title: { type: "text", required: true } } } } } },
  ],
  triggers: [
    { http: "POST /login", pipeline: "login" },
    { http: "POST /pages", pipeline: "createPage" },
    { http: "GET /pages", pipeline: "listPages" },
  ],
  http: { port: $PORT },
});
TS
cat > pipelines/login.ts <<TS
import { definePipeline } from "$SCOPE/definePipeline";
export default definePipeline({ name: "login", steps: ["authn.login", "events.emit:auth.loggedIn"] });
TS
cat > pipelines/createPage.ts <<TS
import { definePipeline } from "$SCOPE/definePipeline";
export default definePipeline({ name: "createPage", steps: ["authn.requireUser", "authz.requireRole", "authz.require:pages.write", "content.create:pages"] });
TS
cat > pipelines/listPages.ts <<TS
import { definePipeline } from "$SCOPE/definePipeline";
export default definePipeline({ name: "listPages", steps: ["authn.identifyUser", "authz.require:pages.read", "content.list:pages", "authz.fields:pages?shape=list"] });
TS

echo "== install (npm, no workspace, no install scripts, registry state as of $BEFORE)"
"${NPM_INSTALL[@]}"
test -x node_modules/.bin/kestrel
test -x node_modules/.bin/kestrel-cli

echo "== check"
./node_modules/.bin/kestrel check

cat > "$WORK/load-trace.mjs" <<'JS'
import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    appendFileSync(process.env.KESTREL_LOAD_TRACE, result.url + "\n");
    return result;
  },
});
JS
FORBIDDEN='kestrel-cli/dist/(inspectProject|inspect/|commands/)|kestrel-upgrade|kestrel-openapi|@babel/|jiti'

echo "== start loads only the project's core"
: > "$WORK/start-trace.txt"
KESTREL_LOAD_TRACE="$WORK/start-trace.txt" node --disable-warning=ExperimentalWarning --import "$WORK/load-trace.mjs" node_modules/.bin/kestrel > traced.log 2>&1 &
TRACED=$!
for _ in $(seq 1 30); do grep -q "kestrel started" traced.log 2>/dev/null && break; sleep 0.2; done
grep -q "kestrel started" traced.log || { cat traced.log; kill $TRACED 2>/dev/null; exit 1; }
kill $TRACED
wait $TRACED || true
grep -q "kestrel/dist/boot.js" "$WORK/start-trace.txt"
if grep -E "$FORBIDDEN" "$WORK/start-trace.txt" | grep -v 'kestrel-cli/dist/commands/start\.js$'; then echo "start loaded the modules above"; exit 1; fi

echo "== boot"
./node_modules/.bin/kestrel > server.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do grep -q "kestrel started" server.log 2>/dev/null && break; sleep 0.2; done
grep -q "kestrel started" server.log || { cat server.log; exit 1; }

echo "== requests"
B="http://127.0.0.1:$PORT"
TOKEN="$(curl -sf -X POST "$B/login" -H 'content-type: application/json' -d '{"username":"admin","password":"smoke"}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).token))")"
test -n "$TOKEN"
curl -sf -X POST "$B/pages" -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" -d '{"slug":"home","title":"Home"}' >/dev/null
TOTAL="$(curl -sf "$B/pages" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).total))")"
test "$TOTAL" = "1"
STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/pages" -H 'content-type: application/json' -d '{"slug":"x","title":"x"}')"
test "$STATUS" = "401"

echo "== check through a separately installed CLI, the layout npx and pnpm dlx produce"
kill $SERVER 2>/dev/null || true
mkdir -p "$WORK/dlx" "$WORK/dlx-project"
cli_tarballs=""
for tgz in "$WORK"/tarballs/*.tgz; do
  name="$(tar -xzOf "$tgz" package/package.json | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).name))")"
  case "$name" in
    "$SCOPE"|"$SCOPE-contracts"|"$SCOPE-cli"|"$SCOPE-upgrade"|"$SCOPE-openapi") cli_tarballs="$cli_tarballs $tgz" ;;
  esac
done
(cd "$WORK/dlx" && echo '{ "name": "dlx", "private": true }' > package.json && "${NPM_INSTALL[@]}" $cli_tarballs)
cd "$WORK/dlx-project"
ln -s "$WORK/consumer/node_modules" node_modules
cp "$WORK/consumer/package.json" package.json
cat > kestrel.config.ts <<TS
import { defineConfig } from "$SCOPE/defineConfig";

export default defineConfig({
  modules: [
    { use: "$SCOPE-blobstore-s3", config: { bucket: "smoke-bucket", region: "eu-west-1" } },
    { use: "$SCOPE-persistence-sqlite", config: { file: "./data/smoke.db" } },
    { use: "$SCOPE-media-default", config: {} },
  ],
  triggers: [],
});
TS
: > "$WORK/dlx-trace.txt"
KESTREL_LOAD_TRACE="$WORK/dlx-trace.txt" node --disable-warning=ExperimentalWarning --import "$WORK/load-trace.mjs" "$WORK/dlx/node_modules/$SCOPE-cli/dist/cli.js" check --root "$WORK/dlx-project"
grep -q "dlx-project/node_modules/$SCOPE/dist/boot.js\|consumer/node_modules/$SCOPE/dist/boot.js" "$WORK/dlx-trace.txt"
grep -q "consumer/node_modules/$SCOPE/dist/load.js" "$WORK/dlx-trace.txt"
test ! -e "$WORK/dlx-project/data"

echo "== ok: consumer installed from tarballs, checked, started without inspection code, booted, login/create/list/401 verified, checked through a separate CLI install ($WORK)"
