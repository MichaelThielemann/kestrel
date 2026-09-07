#!/usr/bin/env bash
# Builds and packs every package, installs the tarballs into a throwaway consumer project
# outside the workspace, boots it and runs a few requests. Fails on the first problem.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${SMOKE_DIR:-$(mktemp -d)}"
PORT="${SMOKE_PORT:-3123}"
SCOPE="@michaelthielemann/kestrel"
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
    { use: "$SCOPE-persistence-sqlite", config: { file: "./data/smoke.db" } },
    { use: "$SCOPE-authn-single", config: { username: "admin", passwordHash: "$HASH", roles: ["admin"] } },
    { use: "$SCOPE-authz-roles", config: { roles: { admin: ["*"] }, anonymous: ["pages.read"] } },
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
export default definePipeline({ name: "createPage", steps: ["authn.requireUser", "authz.require:pages.write", "content.create:pages"] });
TS
cat > pipelines/listPages.ts <<TS
import { definePipeline } from "$SCOPE/definePipeline";
export default definePipeline({ name: "listPages", steps: ["authn.identifyUser", "authz.require:pages.read", "content.list:pages"] });
TS

echo "== install (npm, no workspace)"
npm install --no-audit --no-fund --loglevel=error
test -x node_modules/.bin/kestrel

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
echo "== ok: consumer installed from tarballs, booted, login/create/list/401 verified ($WORK)"
