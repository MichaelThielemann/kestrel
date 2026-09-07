# examples/nginx-njs
Reference configuration to copy and adapt – not a Kestrel package, not published. Shows how an
NGINX reverse proxy in front of a static bucket periodically fetches `redirects.json` and serves
30x responses before the origin is even requested.

## How it works

- Two `js_periodic` handlers (njs ≥ 0.8.1) write the fetched list into a `js_shared_dict_zone`
  (shared memory, visible to all workers).
- Cold-start burst: `@redirects_poll_cold` polls every 2s until the first well-formed response
  (`ready`), then becomes a no-op; `@redirects_poll` keeps polling in steady state (two locations,
  since `js_periodic` has no stop/restart API).
- If a fetch fails or the response isn't an array, the last-known-good list is left unchanged.
  `[]` is a valid state ("no redirects") and does overwrite the old list.
- `location /` walks the list, first matching pattern wins, `$n` is substituted from the capture
  groups; no match → `internalRedirect("@origin")`.
- `absolute_redirect off;` makes nginx emit `Location` exactly as authored (`/new/x`) instead of
  absolutizing it with the request's scheme/host – important behind a TLS-terminating edge.

## Configuration

- `REDIRECTS_URL`: full URL to the artifact, e.g. `https://<bucket-origin>/site/redirects.json`
  (`site/` = the `prefix` of `redirects-default`/`delivery-static`, see
  [`../../packages/redirects-default/README.md`](../../packages/redirects-default/README.md)).
  `ngx.fetch` does not resolve hostnames via `/etc/hosts` – adjust `resolver` in
  `nginx.conf.template` (Docker: `127.0.0.11`).
- `REDIRECTS_INTERVAL_MS` (default `60000`): steady-state interval in ms, substituted via
  `envsubst`.
- `ORIGIN_UPSTREAM` (default `origin:3000`): target of `proxy_pass` in `@origin`, via an nginx
  variable rather than a literal – otherwise startup fails if the host isn't resolvable yet.
- The artifact should be served with `Cache-Control: public, max-age=0, must-revalidate`.

## Smoke test

```
podman build -t kestrel-nginx-njs examples/nginx-njs
podman run --rm -e REDIRECTS_URL=http://<origin>:4000/redirects.json -p 8080:8080 kestrel-nginx-njs
curl -i localhost:8080/old/x   # expected: 30x + Location: /new/x
```

An automated Podman integration test is a follow-up.
