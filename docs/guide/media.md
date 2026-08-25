# Media and images

Uploading and serving files: allowed formats, size and MIME limits, responsive image variants via `<KestrelImg>`, and where files are stored (local disk or S3).

## Allowed formats

Uploads are validated by magic-byte sniffing — the filename and the browser-reported MIME type are never trusted. The default allow-list covers images (png, jpg, webp, gif, avif, svg), documents (pdf, docx, xlsx, pptx, odt, ods, odp), video (mp4, webm, mov) and audio (mp3, ogg, opus, wav, flac, m4a):

| Extension | MIME |
|---|---|
| png | `image/png` |
| jpg | `image/jpeg` |
| webp | `image/webp` |
| gif | `image/gif` |
| avif | `image/avif` |
| svg | `image/svg+xml` |
| pdf | `application/pdf` |
| docx | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| xlsx | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| pptx | `application/vnd.openxmlformats-officedocument.presentationml.presentation` |
| odt | `application/vnd.oasis.opendocument.text` |
| ods | `application/vnd.oasis.opendocument.spreadsheet` |
| odp | `application/vnd.oasis.opendocument.presentation` |
| mp4 | `video/mp4` |
| webm | `video/webm` |
| mov | `video/quicktime` |
| mp3 | `audio/mpeg` |
| ogg | `audio/ogg` |
| opus | `audio/ogg; codecs=opus` (note the space) |
| wav | `audio/wav` |
| flac | `audio/flac` |
| m4a | `audio/x-m4a` **and** `audio/mp4` — both are needed, since different encoders report either |

- **Magic-byte sniffing:** every upload is inspected with [file-type](https://github.com/sindresorhus/file-type); the client-provided MIME and extension are ignored.
- **SVG sanitization:** SVG files pass through an XML sanitizer before storage to strip active content.
- **Intentionally excluded:** executable/active web types (`text/html`, `application/javascript`, `application/wasm`) are never in the default list, and plain-text formats (`text/plain`, `text/csv`) are excluded because they have no magic bytes to sniff.
- **Only sniffable formats can be enabled:** the allow-list is enforced *after* sniffing. If `file-type` cannot identify the bytes, the upload is rejected regardless of the allow-list — the one exception is SVG, which magic-byte sniffing reports as generic XML; Kestrel promotes that to `image/svg+xml` itself by checking that the root element is `<svg>`.

## Configuring the allow-list and size limit

`allowedMimes` (config) / `KESTREL_MEDIA_ALLOWED_MIME` (env) is a comma-separated list of MIME types that **replaces** the built-in default entirely (the table above), with the usual `env → config → default` precedence. An empty value (the default) keeps the built-in set.

```ts
// kestrel.config.ts
export default { media: { allowedMimes: 'image/png,image/jpeg,application/pdf' } } satisfies KestrelConfig
```

```bash
KESTREL_MEDIA_ALLOWED_MIME=image/png,image/jpeg,application/pdf
```

A rejected upload returns `415 Unsupported media type: <detected-mime>` — copy the detected MIME into your list to allow it. Adding a type like `application/zip` or `text/html` expands the attack surface; evaluate the risk for your deployment before doing so.

`maxBytes` (config) / `KESTREL_MEDIA_MAX_BYTES` (env) controls the maximum upload size (default `26214400` bytes = 25 MiB). Raise it for video uploads:

```ts
export default { media: { maxBytes: 104857600 } } satisfies KestrelConfig // 100 MiB
```

```bash
KESTREL_MEDIA_MAX_BYTES=104857600  # 100 MiB
```

## Image processing and `<KestrelImg>`

Only png, jpeg, webp and avif receive derived variants on ingest. GIF is stored and served as-is like any non-raster format — deriving WebP from it would flatten the animation to a static first frame, so it is deliberately excluded. On ingest, each derivable image yields a thumbhash placeholder, EXIF-corrected intrinsic dimensions, and one output per registered variant × format: a fixed crop is clamped to the source size (never upscaled), and a proportional width wider than the source is skipped outright rather than clamped, so no oversized srcset candidate is generated for it.

Which variants exist is **usage-driven** once the variant registry has something in it: a size/format is derived because some `<KestrelImg>` in the site declares it, and the registry only fills in from a full publish or `nuxt generate`. Before that first run — and whenever the registry is unmigrated or empty — every raster upload falls back to the config `widths` ladder instead: 5 webp widths by default. The responsive-image component both renders a `<picture>` from a media's derivatives and declares which sizes/formats that usage needs:

```vue
<KestrelImg
  :media="page.hero"
  :widths="[320, 640, 960, 1280]"
  :formats="['webp', 'jpeg']"
  sizes="(min-width: 768px) 50vw, 100vw"
  priority
/>
```

| Prop | Meaning |
|---|---|
| `media` | the resolved media object (from a media / relation field) |
| `widths` | a proportional responsive set — each width → a `w<width>` variant |
| `crop` | a fixed box `{ width, height, fit? }` → a `c<width>x<height>` variant |
| `preset` | one or more named config presets, by name (`string \| string[]`) |
| `formats` | output formats to emit, most-modern first (default `['webp']`) |
| `sizes` | the `<img sizes>` attribute; `"auto"` (or `"auto, <fallback>"`) is honoured |
| `priority` | marks the LCP image — eager + `fetchpriority="high"`, and drops `sizes="auto"` |

Multiple usages accumulate: the registry is a single site-wide set of name×format specs, not tracked per media asset, and every distinct `<name>.<format>` any usage declares becomes a variant derived for *every* raster upload. `widths`, `crop` and `preset` can be combined in one call, each crossed with `formats`. The only narrowing that happens per asset is skipping a proportional width wider than the source, and clamping a fixed crop to it, as above.

A width `320` derives as `w320`; a crop `320×320` derives as `c320x320` (a non-`cover` fit appends, e.g. `c320x320-contain`). `sizes="auto"` lets the browser pick the srcset candidate from the image's rendered width, but only on **lazy** images — on an eager (`priority`) image the keyword is dropped and only the fallback is used. A lazy image with no explicit `sizes` defaults to `auto, 100vw`.

## Config: presets and quality

Encode quality and named presets live in the `media.image` block of `kestrel.config.ts` (see [configuration.md](./configuration.md)), with the usual `KESTREL_* env → config → default` precedence per field:

```ts
// kestrel.config.ts
export default {
  media: {
    image: {
      widths: [320, 640, 960, 1280, 1920], // legacy proportional ladder → desugars into w<width> webp presets
      webpQuality: 78,                      // 1-100 (default 78)
      jpegQuality: 80,                      // 1-100 (default 80)
      variants: [                           // named presets referenced by <KestrelImg :preset>
        { name: 'thumb', width: 320, height: 320, fit: 'cover', formats: ['webp', 'jpeg'] },
        { name: 'hero', width: 1600, formats: ['webp'] },
      ],
    },
  },
} satisfies KestrelConfig
```

| Setting | Env fallback | Default |
|---|---|---|
| `media.image.widths` | `KESTREL_MEDIA_IMAGE_WIDTHS` (csv) | `[320, 640, 960, 1280, 1920]` |
| `media.image.webpQuality` | `KESTREL_MEDIA_IMAGE_WEBP_QUALITY` | `78` |
| `media.image.jpegQuality` | `KESTREL_MEDIA_IMAGE_JPEG_QUALITY` | `80` |
| `media.image.variants` | — (config-only) | — |

`variants` is the one image setting with no `KESTREL_*` env override — a structured list doesn't round-trip a scalar/CSV env var, so it must live in the committed config. The upload handler reads the resolved policy from `runtimeConfig.media.imagePolicy`, so a config/env change takes effect on the next server start — for `image.variants` (presets), which are always unioned into the registry. `image.widths` only backs the fallback ladder used before the registry has anything in it; once a publish has populated the registry, editing `widths` changes nothing until a `<KestrelImg :widths>` usage re-registers those names.

Derivatives are emitted as WebP, plus a JPEG fallback when a usage asks for one. `.avif` is accepted as an upload format but is never emitted as a derivative output.

## Keeping variants in sync: the backfill task

Because variants are usage-driven, the set evolves with the code — a full publish reconciles which sizes/formats are currently in use, but existing media rows may still lack derivatives for a newly added usage. Run the `media:backfill` task to catch them up:

```bash
# dev (append ?check=true for a dry run — the dev task route reads its payload from the query string)
curl 'http://localhost:3000/_nitro/tasks/media:backfill?check=true'

# prod: runTask('media:backfill', { payload: { check: true } }) or a cron scheduledTask
```

The admin API exposes the same operation, authenticated as an admin session (it runs under the same admin auth as the rest of `/api/media`):

```bash
curl -X POST http://localhost:3000/api/media/backfill \
  -H 'content-type: application/json' -H 'cookie: <admin session cookie>' \
  -d '{"check": true}'
```

Both accept `{ check: true }` for a dry run that reports the plan (rows / would-generate / would-prune) without writing. Backfill also prunes each row's own derivatives that are no longer registered — but only when it can trust the active set came from the live registry; if the registry is unmigrated, unreadable, empty, or holds nothing that survives validation, the run falls back to generating from config and skips pruning rather than risk deleting derivatives it can't confirm are unused. In dev, a missing width or crop variant is derived on demand so the editor preview is never blocked waiting for a backfill — its shape is parsed straight from the `w<width>` / `c<w>x<h>` name. A newly added named `preset`, whose shape lives only in config, still needs a backfill before its preview appears.

## Storage location and serving

The uploads directory is configured once in `kestrel.config.ts` (see [configuration.md](./configuration.md)), and that one path is used for both writing and serving — they can never drift:

```ts
// kestrel.config.ts
export default { media: { uploadDir: 'storage/uploads' } } satisfies KestrelConfig
```

Resolution precedence: `KESTREL_MEDIA_LOCAL_DIR` (env) → `kestrel.media.uploadDir` → `<root>/.data/uploads` (default). The resolved path feeds `runtimeConfig.media.local.dir` (where the local driver writes) and the Nitro `publicAssets` entry that serves them at `/uploads` in dev and bakes them into the `nuxt generate` artifact. In production the same files are served by your web server or CDN at the same `/uploads` prefix (`kestrel.media.baseUrl` / `KESTREL_MEDIA_BASE_URL` overrides the prefix).

`nuxt generate` bakes the whole uploadDir into `.output/public/uploads` by default. A build-side prune step then lists that baked directory and deletes only the files it finds unreferenced *and* owned by the media registry — every original and derivative key the registry tracks — collecting references from the generated HTML, CSS, JSON payloads and JS chunks (a JS chunk is scanned too, since a media URL can be emitted only from client code, e.g. a background image). Files under the same prefix that the media library doesn't own (blobs an extension writes itself) are always kept. The whole prune step is skipped if the media registry can't be read.

## Storage drivers

Media storage is abstracted behind a small driver interface, selected by `media.driver`:

| Driver | Stores objects in | Serves them via |
|---|---|---|
| `local` (default) | the local `uploadDir` | Nitro `/uploads` static serving (dev) / the generated artifact / your web server |
| `s3` | an S3-compatible bucket (AWS S3, Cloudflare R2, MinIO) | the bucket / a CDN in front of it (`publicBaseUrl`) |

When `driver: 's3'`, the `/uploads` static route is not registered — the bucket (or CDN) serves the files directly, at `<publicBaseUrl>/<prefix>/<key>`.

### S3 driver

Configure the non-secret settings in `kestrel.config.ts` (or the `KESTREL_S3_*` env fallbacks) and supply credentials via the environment only:

```ts
// kestrel.config.ts
export default {
  media: {
    driver: 's3',
    s3: {
      bucket: 'my-bucket',                       // required
      region: 'eu-central-1',                    // default 'us-east-1'; 'auto' for Cloudflare R2
      endpoint: '',                              // e.g. 'https://<account>.r2.cloudflarestorage.com' (omit for AWS)
      prefix: 'media',                           // optional key prefix
      publicBaseUrl: 'https://cdn.example.com',  // required — where the bucket/CDN serves objects
    },
  },
} satisfies KestrelConfig
```

```bash
# credentials — env-only, never committed, and read once at module setup (not per request)
export KESTREL_S3_ACCESS_KEY_ID=…
export KESTREL_S3_SECRET_ACCESS_KEY=…
export KESTREL_S3_SESSION_TOKEN=…   # optional (STS temporary credentials)
```

Because they're read at module setup, a prebuilt server needs `NUXT_MEDIA_S3_ACCESS_KEY_ID` / `NUXT_MEDIA_S3_SECRET_ACCESS_KEY` (`_SESSION_TOKEN`) instead — see [configuration.md](./configuration.md) for the full precedence and env mapping.

`bucket`, `publicBaseUrl` and both credentials are required — without any one of them the driver refuses every request with `S3 media driver is not configured: bucket, publicBaseUrl, and credentials (KESTREL_S3_ACCESS_KEY_ID / _SECRET_ACCESS_KEY) are required`.

S3 has no real directories — "folders" are just shared key prefixes tracked in the `folders` database table, not in the store, so creating an empty folder writes no object at all. Deleting a folder deletes every object key under `folder/` (the prefix always carries a trailing slash, so deleting `a/` never touches a sibling like `ab/`).

### Exposing the bucket

Kestrel builds each object's URL as `<publicBaseUrl>/<prefix>/<key>`, but it never sets a per-object ACL — it deliberately omits `x-amz-acl`, because modern buckets have ACLs disabled ("Bucket owner enforced"), where a `public-read` ACL is rejected outright. You make objects reachable at the bucket/CDN level instead, then set `publicBaseUrl` to match:

- **Public bucket (simplest).** Turn off "Block Public Access" and attach a read-only bucket policy scoped to your `prefix/*`; `publicBaseUrl` → `https://my-bucket.s3.<region>.amazonaws.com` (or your CDN domain).
- **Private bucket + CloudFront (recommended on AWS).** Keep "Block Public Access" on, put CloudFront in front with an Origin Access Control (OAC), and grant the distribution `s3:GetObject` in the bucket policy; `publicBaseUrl` → the CloudFront domain.
- **Cloudflare R2.** Enable the bucket's public access (the `r2.dev` URL) or attach a custom domain; `publicBaseUrl` → that domain (for SigV4 writes set `region: 'auto'` and `endpoint: 'https://<account>.r2.cloudflarestorage.com'`).

With bucket, `publicBaseUrl` and credentials configured but the bucket not made publicly readable at the bucket/CDN level, uploads succeed but every `<img src>` / `srcset` returns 403 — the single most common first-S3-deploy mistake.

## See also

- [configuration.md](./configuration.md) — the full `media.*` config keys, env precedence, and S3 credential handling.
- [ai-disclosure.md](./ai-disclosure.md) — the `aiSourceType` / `aiNote` columns, upload-time signal scan, and the `<KestrelImg ai-badge>` element.
- [../internals/data-model.md](../internals/data-model.md) — the `media_settings` variant registry and how scan/manual provenance is tracked.
- [../internals/publishing.md](../internals/publishing.md) — the prerender scan that reconciles registered variants during a full publish.
