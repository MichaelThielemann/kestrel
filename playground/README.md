# Kestrel playground

A minimal example site that consumes Kestrel as a meta-layer (`extends: ['@michaelthielemann/kestrel']`) and defines its own
`products` collection. Doubles as a manual fixture for the meta-layer + consumer-collection path.

```bash
pnpm install                 # from the repo root (workspace links kestrel in)

# auth (env-only) — see docs/consuming-kestrel.md
export KESTREL_SESSION_SECRET=$(openssl rand -base64 32)
export KESTREL_ADMIN_PASSWORD_HASH=$(node ../scripts/hash-password.mjs "kestrel")
export KESTREL_SECURE_COOKIES=false

pnpm --filter kestrel-playground dev
```

On boot the schema engine creates Kestrel's built-in tables **and** `products` in `.data/playground.sqlite`
(no migrations). Admin at <http://localhost:3000/admin> (password `kestrel`).

## Testing the secure gallery + proofing extensions

The playground composes both opt-in extensions (`kestrel-galleries-secure` + `…-proofing`). It defines a
plain **multi** `galleries` collection (Pruvious-style: a record FORM with `title`, `slug`, a `secureGallery`
field, and a Public/Not-public `status`). The customer reaches a published gallery via the consumer's own
route `app/pages/g/[slug].vue`, which reads the (ZK-safe) manifest from `server/api/public-gallery` (opened
to anonymous read for ONE published gallery via the core access grant seam).

1. **Editor:** admin → **Galleries** → new gallery. Fill the **form**: a title (the `slug` auto-generates
   from it — the field shows the `/galleries/` prefix and you can override it), set **status = published**.
   In the **Secure gallery** field, **Suggest** (or type) a password, then **Add images** — or **drag photos
   / whole folders** onto the drop zone (a dropped folder becomes the nested structure). Each image is
   encrypted in the browser before upload. Save.
2. **Customer:** open <http://localhost:3000/galleries/your-slug> → enter the password → photos decrypt.
   Click a colour flag / type a comment on a photo — it's sealed + submitted (watch the "Saved" status).
   Shareable form: append `#key=<password>` to the URL.
3. **Photographer review:** admin → <http://localhost:3000/review> → pick the gallery → enter the same
   password → each customer's colour/comment marks are overlaid on the photos.

> The proofing back-channel (`POST /api/galleries-secure-proofing/submit`) + the `public-gallery` read need
> the running server — they are NOT part of a pure-static (`nuxt generate`) deployment. The base secure
> gallery embedded as a block in a static page IS fully static (the scenario the base README documents).
