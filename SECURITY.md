# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately**, not as a public issue.

- GitHub → **Security → Report a vulnerability** (private advisory) on this repository.

Include the affected version, what an attacker can achieve, and the smallest reproduction you have. A
proof-of-concept is welcome but not required — a precise description of the code path is usually enough.

Reports are acknowledged on a best-effort basis. Fixes are published as a normal release, with the
advisory made public once a fixed version is available.

This is a free project maintained by one person outside any commercial activity. There is no paid support
and no guaranteed response time; please size your expectations accordingly.

## Supported versions

Only the **latest released minor** receives security fixes. There are no long-term-support branches.

## Scope

In scope: the published packages (`@michaelthielemann/kestrel` and the `@michaelthielemann/kestrel-galleries-*`
extensions) as used according to the documentation.

Out of scope, because they are documented design decisions rather than defects — see
[README](./README.md#what-kestrel-is--and-isnt) and [configuration.md](./docs/configuration.md):

- **Uploaded files are not access-controlled.** With `media.driver: 'local'` they are served from the app
  origin by Nitro's static handler, which runs ahead of every middleware; the admin guard protects the
  media *library*, not the bytes. Restrict them at the reverse proxy or use a private S3 bucket.
- **The IP allow-list does not cover static assets** (`/_nuxt/**`, and `/uploads` on the local driver) for
  the same reason. It is a stage-level convenience, not a substitute for a proxy-level restriction.
- **The editing origin is assumed to be non-public.** Kestrel publishes static HTML; the admin app itself
  is not designed to be exposed to the open internet without a network-level gate in front of it.
- Findings that require an already-authenticated admin acting deliberately — there is exactly one admin
  user, and it is fully privileged by design.

Reports about these are still welcome as ordinary issues if you think the documentation is wrong or the
default is a poor one, but they will not be treated as vulnerabilities.
