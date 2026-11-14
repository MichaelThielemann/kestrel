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
- `location /` walks the list with an indexed loop (njs has no `for...of`, see
  [njs compatibility](https://nginx.org/en/docs/njs/compatibility.html)), first matching `from`
  wins, `$n` is substituted from its wildcards; no match → `internalRedirect("@origin")`. The
  list comes from Kestrel's compiler and is guaranteed `{ from, pattern, target, status }`, so the
  handler checks no item shapes.
- The handler matches `from` with the same linear algorithm as `redirects.lookup` (see
  [`../../packages/redirects-default/README.md`](../../packages/redirects-default/README.md)), not the
  `pattern` regex, so no request path can make a rule expensive; a path longer than 2048 characters
  goes to the origin unmatched. A rule without `from` (a list published before `from` existed, or a field
  grant that leaves it out) is matched by its `pattern` instead.
- For a 3xx code the second argument of `r.return()` is the redirect URL and sets `Location`
  internally; setting `r.headersOut.Location` beforehand has no effect, because nginx's built-in
  redirect response generation overwrites it.
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
- `RESERVED_PATHS` (default `/admin,/api,/media`): comma-separated path prefixes the handler never
  redirects, the path itself and everything below it; they go to the origin whatever the list says, so
  no rule can shadow the admin routes. Keep it equal to `reservedPaths` of `redirects-default`, which
  refuses a rule that could match one of them. It reaches the handler through the `env` directive in
  `nginx.conf.template`.
- `ORIGIN_UPSTREAM` (default `origin`): host (and port, default 443) of the origin that `@origin`
  proxies to over `https://`, via an nginx variable rather than a literal – otherwise startup fails if
  the host isn't resolvable yet. The origin's certificate is verified against the system CAs
  (`proxy_ssl_verify on`) with the host as SNI name, and the proxy passes `Host`, `X-Forwarded-For`
  and `X-Forwarded-Proto`, so the origin sees the client address when it trusts one proxy hop.
  Admin tokens, session cookies and login passwords cross this hop: keep it on TLS unless the origin
  listens on the same machine (loopback), and only then switch the scheme to `http://`.
- `REDIRECTS_URL` should be `https://` as well; `ngx.fetch` verifies the certificate against the
  same CA bundle (`js_fetch_trusted_certificate`).
- The artifact should be served with `Cache-Control: public, max-age=0, must-revalidate`.

## Smoke test

```
podman build -t kestrel-nginx-njs examples/nginx-njs
podman run --rm -e REDIRECTS_URL=https://<bucket-origin>/site/redirects.json -e ORIGIN_UPSTREAM=<origin-host> -p 8080:8080 kestrel-nginx-njs
curl -i localhost:8080/old/x   # expected: 30x + Location: /new/x
```
