# Media uploads

## Allowed formats

The following file types are accepted by default. Uploads are validated by magic-byte sniffing — the filename and the browser-reported MIME are never trusted.

| Category | Extension | MIME type |
|---|---|---|
| Image | png | `image/png` |
| Image | jpg | `image/jpeg` |
| Image | webp | `image/webp` |
| Image | gif | `image/gif` |
| Image | avif | `image/avif` |
| Image | svg | `image/svg+xml` |
| Document | pdf | `application/pdf` |
| Document | docx | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| Document | xlsx | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| Document | pptx | `application/vnd.openxmlformats-officedocument.presentationml.presentation` |
| Document | odt | `application/vnd.oasis.opendocument.text` |
| Document | ods | `application/vnd.oasis.opendocument.spreadsheet` |
| Document | odp | `application/vnd.oasis.opendocument.presentation` |
| Video | mp4 | `video/mp4` |
| Video | webm | `video/webm` |
| Video | mov | `video/quicktime` |
| Audio | mp3 | `audio/mpeg` |
| Audio | ogg (Vorbis) | `audio/ogg` |
| Audio | opus | `audio/ogg; codecs=opus` |
| Audio | wav | `audio/wav` |
| Audio | flac | `audio/flac` |
| Audio | m4a | `audio/x-m4a` (and `audio/mp4`) |

## Security model

- **Magic-byte sniffing:** every upload is inspected with [file-type](https://github.com/sindresorhus/file-type). The client-provided MIME type and file extension are ignored.
- **SVG sanitization:** SVG files pass through an XML sanitizer before storage to strip active content.
- **Intentionally excluded types:** executable and active web types (`text/html`, `application/javascript`, `application/x-shockwave-flash`, `application/wasm`) are never in the default list — they would enable XSS from the media origin. Plain-text formats (`text/plain`, `text/csv`, `text/markdown`) are excluded because they have no magic bytes and cannot be reliably sniffed.
- **Only sniffable formats can be enabled:** `KESTREL_MEDIA_ALLOWED_MIME` is enforced after sniffing. If `file-type` cannot identify the bytes, the upload is rejected regardless of the allow-list.

## Configuring the allow-list

Set `KESTREL_MEDIA_ALLOWED_MIME` to a comma-separated list of MIME types to **replace** the built-in default entirely. An empty value (the default) keeps the built-in set above.

```
KESTREL_MEDIA_ALLOWED_MIME=image/png,image/jpeg,application/pdf
```

A rejected upload returns `415 Unsupported media type: <detected-mime>`. Copy the detected MIME from that message into your list to allow it.

**Example — add fonts and zip archives to the default set:**

```
KESTREL_MEDIA_ALLOWED_MIME=image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.oasis.opendocument.text,application/vnd.oasis.opendocument.spreadsheet,application/vnd.oasis.opendocument.presentation,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/ogg,audio/ogg; codecs=opus,audio/wav,audio/flac,audio/x-m4a,audio/mp4,font/woff2,application/zip
```

> Adding `application/zip` or `text/html` expands the attack surface — evaluate the risk for your deployment.

## File size limit

Set `KESTREL_MEDIA_MAX_BYTES` to control the maximum upload size (default: 26 214 400 bytes = 25 MiB). Raise this for video uploads.

```
KESTREL_MEDIA_MAX_BYTES=104857600  # 100 MiB
```

## Image processing

Only raster images (png, jpeg, webp, gif, avif) receive derived variants on ingest. All other formats are stored and served as-is; the media library displays an extension badge for non-image files. On ingest each raster image yields a thumbhash placeholder, EXIF-corrected intrinsic dimensions, and one output per **registered variant × format** (each clamped to the source width — never upscaled), all recorded in the `derivatives` manifest keyed `<name>.<format>`.

Which variants exist is **usage-driven**: a size/format is derived only because some `<KestrelImg>` in the site declares it — *"not in the code ⇒ not generated"*. There is no fixed global ladder.

### Declaring variants — `<KestrelImg>`

The engine's responsive-image component renders a `<picture>` from a media's derivatives **and** declares (to the generate-time scan) which sizes and formats that usage needs:

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
| `preset` | one or more **named config presets**, by name (`string \| string[]`) |
| `formats` | output formats to emit, preference order most-modern first (default `['webp']`) |
| `sizes` | the `<img sizes>` attribute; `"auto"` (or `"auto, <fallback>"`) is honoured |
| `priority` | marks the LCP image — eager + `fetchpriority="high"`, and drops `sizes="auto"` |

**Multiple usages accumulate.** Different pages/components may request different sizes and formats of the same media; every distinct `<name>.<format>` a usage declares becomes a variant. `widths`, `crop` and `preset` can be combined in one call, each crossed with `formats`.

**Derived-name scheme:** a width `320` → `w320`; a crop `320×320` → `c320x320` (a non-`cover` fit is appended, e.g. `c320x320-contain`). The manifest key is `<name>.<format>` (e.g. `w320.webp`, `c320x320.jpeg`); the stored object key is `<original-key>-<name>.<format>`.

**`sizes="auto"` graceful degradation:** `auto` lets the browser pick the srcset candidate from the image's rendered width, but only on **lazy** images — on an eager (`priority`) image the keyword is dropped and only the fallback is used (`auto, 100vw` → `100vw`). Non-supporting browsers ignore `auto` and fall through to the fallback too. A lazy image with no explicit `sizes` defaults to `auto, 100vw`.

### Config: presets & quality

Encode quality and **named presets** live in the `media.image` block of `kestrel.config.ts` (see [configuration.md](./configuration.md)), with the usual `KESTREL_* env → config → default` precedence **per field**:

```ts
// kestrel.config.ts
export default {
  media: {
    image: {
      widths: [320, 640, 960, 1280, 1920], // legacy proportional ladder → desugars into `w<width>` webp presets
      webpQuality: 78,                      // 1–100 (default 78)
      jpegQuality: 80,                      // 1–100 (default 80)
      variants: [                           // named presets referenced by <KestrelImg :preset>
        { name: 'thumb', width: 320, height: 320, fit: 'cover', formats: ['webp', 'jpeg'] },
        { name: 'hero', width: 1600, formats: ['webp'] },
      ],
    },
  },
} satisfies KestrelConfig
```

| Setting | Env fallback | Default | Notes |
|---|---|---|---|
| `media.image.widths` | `KESTREL_MEDIA_IMAGE_WIDTHS` (csv, e.g. `320,640,1280`) | `[320, 640, 960, 1280, 1920]` | Legacy proportional ladder; desugars into `w<width>` single-webp presets. Non-positive / non-numeric entries are dropped. |
| `media.image.webpQuality` | `KESTREL_MEDIA_IMAGE_WEBP_QUALITY` | `78` | Integer in `[1, 100]`; out-of-range / garbage falls back. |
| `media.image.jpegQuality` | `KESTREL_MEDIA_IMAGE_JPEG_QUALITY` | `80` | Integer in `[1, 100]`; out-of-range / garbage falls back. |
| `media.image.variants` | — (**config-only**) | — | Named `{ name, width, height?, fit?, position?, formats? }` presets, referenced by `<KestrelImg :preset>`. |

> **`variants` is config-only** — the one image setting with no `KESTREL_*` env override. A structured list doesn't round-trip a scalar / CSV env var, so it must live in the committed config; the quality scalars keep their env overrides.

The upload handler reads the resolved policy from `runtimeConfig.media.imagePolicy`, so a config/env change takes effect on the next server start.

### The variant registry (`media_settings`)

The *effective* set of variants to derive is not read straight from config — it lives in a runtime, scan-populated **registry**: the `media_settings` singleton row (a `nav: false` hidden collection, mutable at runtime). The config presets above are only the **fallback**, used while the registry is still empty.

- The **upload** path derives exactly the currently-registered set — **narrow generation**: a new upload gets only what the site is known to use, not a fixed ladder.
- Each registry entry carries provenance — `source: 'scan'` (auto-discovered) or `'manual'` / `pinned` (hand-authored). A manual/pinned entry survives the scan reconcile and wins a name collision with a scanned one.

### Variant lifecycle

Because variants are usage-driven, the set evolves with the code. Four moments keep the derivatives in sync:

1. **Upload** derives the **currently-registered** set from the registry (narrow generation).
2. A **full publish / `nuxt generate`** runs the **prerender scan**: every `<KestrelImg>` render stashes its declared specs, and at the end of the publish they are reconciled into the registry — scan entries replaced with exactly what was rendered, manual/pinned kept. This is how a newly-added or removed usage registers / deregisters a variant. *(Safety: a run that discovers nothing leaves the registry untouched rather than wiping it.)*
3. **Backfill** catches up **existing** media to newly-registered sizes/formats (the scan updates the registry, but old uploads still lack the new derivatives). Run the `media:backfill` task (dev: `GET /_nitro/tasks/media:backfill`; prod: `runTask('media:backfill', …)` or a cron `scheduledTask`) or the admin `POST /api/media/backfill`. Both accept `{ check: true }` for a dry-run that reports the plan (rows / would-generate / would-prune) without writing. Backfill also **prunes** each row's own deregistered derivatives — but only when the active set came from the **registry**. If the registry is unmigrated, unreadable, empty, or holds nothing that survives validation, the active set is the config fallback standing in for it; that run generates as usual, prunes nothing, reports `pruneWithheld: true` and logs a warning. Pruning against a stand-in would read every registered derivative the fallback happens not to name as deregistered and delete it, and `pruned: 0` on its own cannot tell "nothing was deregistered" from "could not tell what is registered".
4. **Dev** derives any missing variant **on demand**, so the editor preview is never blocked waiting for a backfill.

> **Formats: WebP + JPEG.** Derivatives are emitted as WebP, plus a JPEG fallback when a usage asks for one (`:formats="['webp', 'jpeg']"`). The old AVIF *output* was dropped (nothing rendered referenced it); `.avif` is still accepted as an **upload** format. Variants are no longer a single fixed WebP ladder — a usage may declare multiple proportional `widths`, fixed `crop`s, and both `webp` + `jpeg`, and only those ship.

## EU AI Act (Art. 50) disclosure

Two optional, non-localized columns on every media asset let an editor record **how it was produced**:

| `aiSourceType` | meaning |
|---|---|
| `trainedAlgorithmicMedia` | Fully AI-generated |
| `compositeWithTrainedAlgorithmicMedia` | AI-generated content composited into real media (the Art. 50 "deepfake" case) |
| `algorithmicallyEnhanced` | AI-enhanced / algorithmically edited real media |
| *(unset — the default)* | No disclosure recorded; renders exactly as before the feature existed |

`aiNote` is free text alongside it (the tool used, the prompt, whatever the editor wants to record). Both
are **top-level columns, not per-locale** `translations` entries: how a photo was made does not change per
translation.

**Off by default.** Turn it on in `kestrel.config.ts`:

```ts
export default { aiDisclosure: { enabled: true } } satisfies KestrelConfig
```

(env override: `KESTREL_AI_DISCLOSURE`). With the flag on, the media viewer gains a source-type select and
a note field on image assets; with it off, the admin shows nothing extra and a save from the viewer never
touches the columns. The flag gates the **admin UI and the upload scan only** — `ResolvedMedia.aiDisclosure`
is always resolved, so switching the flag back off keeps existing data, it just stops being editable.

Consumers upgrading an existing project need a **`db:migrate`**: the two columns are additive and nullable,
and an unset value behaves exactly as before.

### What Kestrel deliberately does NOT do

- **No pixel watermarking or label burn-in.** No server-side compositing, no EXIF/XMP writing, no C2PA
  manifest signing.
- **No automatic public markup.** Kestrel never injects a `<meta>` tag, JSON-LD or a visible badge into a
  published page on its own — a silently-added claim in the wrong place, language or style is worse than
  none.

You remain the Art. 50 **deployer**. Kestrel stores and manages the metadata and hands it to you; *how* (or
whether) you disclose on your site is your decision and your legal responsibility.

### Upload-time signal scan

While the flag is on, each upload is scanned for signals that a file was AI-produced, and what is found is
quoted into `aiNote` (prefixed `Detected at upload:`). What it reads:

- **IPTC/XMP `DigitalSourceType`** — the generator's own declaration, in the same vocabulary as the column.
- **C2PA content credentials** — detected **structurally, presence only** (a JUMBF store: a PNG `caBX`
  chunk, a JPEG `APP11` segment, a WebP `C2PA` chunk).
- **EXIF `Software` / `ProcessingSoftware`** naming a known generator (Midjourney, DALL·E, Adobe Firefly,
  Stable Diffusion, Leonardo.Ai, NightCafe, Bing Image Creator, Google ImageFX, Imagen, FLUX.1, Ideogram).
  An ordinary "Adobe Photoshop" is not a match.
- **PNG text chunks** keyed `parameters` / `prompt` / `workflow` (the Automatic1111 / Forge / ComfyUI
  families), including the compressed `zTXt` and `iTXt` forms.

Four things about it are load-bearing:

1. **It fills `aiNote` only — never `aiSourceType`.** The legal classification stays a deliberate human
   decision; a mislabeled or forged upstream file must not become Kestrel's own asserted classification.
2. **It never overwrites text a person wrote** — not an `aiNote` sent with the upload, and not one already
   on the row a re-upload replaces.
3. **C2PA presence is not verification.** No signature is checked and no trust list is consulted (that
   needs the full C2PA SDK, which Kestrel does not ship), so the evidence line says `unverified`.
4. **Absence of a signal is not proof of non-AI origin.** Metadata is stripped by re-saving, screenshotting
   or re-encoding, and container support is uneven — EXIF is read from JPEG/PNG/TIFF/HEIC, while for WebP
   only the XMP packet and the C2PA chunk are found.

### Reading the disclosure in your own templates

Every resolved media relation carries it, so nothing about the badge below is required:

```vue
<script setup lang="ts">
const { data } = await useFetch('/api/pages/1?populate=true')
</script>

<template>
  <figure>
    <KestrelImg :media="data.hero" :widths="[640, 1280]" />
    <figcaption v-if="data.hero?.aiDisclosure">
      {{ data.hero.aiDisclosure.note ?? 'AI-generated' }}
    </figcaption>
  </figure>
</template>
```

`aiDisclosure` is `{ sourceType, note }` when a source type is set, and `null` otherwise — a note without a
source type is only evidence, so it never resolves to a half-filled object.

### The optional `KestrelImg` badge

If you would rather not build your own element, `<KestrelImg>` can render one — **opt-in, and unstyled**:

```vue
<KestrelImg :media="hero" :widths="[640, 1280]" ai-badge />
```

It emits a single `<span class="kestrel-img__ai-badge" data-ai-source-type="…">` inside the `<picture>`,
whose text is the `aiNote` (falling back to a short English label). Kestrel gives it **layout only** —
absolute placement in the picture's lower-inline-start corner and `pointer-events: none` — and no color,
background, border, radius or font, so it is invisible until your stylesheet designs it:

```css
.kestrel-img__ai-badge {
  margin: 0.5rem;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  background: rgb(0 0 0 / 0.6);
  color: #fff;
  font-size: 0.75rem;
}
/* or key off the classification: */
.kestrel-img__ai-badge[data-ai-source-type='trainedAlgorithmicMedia'] { background: rebeccapurple; }
```

The rules Kestrel ships are deliberately **unscoped**, so a plain `.kestrel-img__ai-badge` selector in your
own CSS wins.

## Storage location & serving

The uploads directory is configured **once** in `kestrel.config.ts` (see [configuration.md](./configuration.md)),
and that one path is used for **both** writing and serving — they can never drift:

```ts
// kestrel.config.ts
export default { media: { uploadDir: 'storage/uploads' } } satisfies KestrelConfig
```

Resolution precedence (the `kestrel` module in `core`): `KESTREL_MEDIA_LOCAL_DIR` (env) →
`kestrel.media.uploadDir` → `<root>/.data/uploads` (default).

The resolved path feeds `runtimeConfig.media.local.dir` (where the local driver **writes**) **and** the Nitro
`publicAssets` entry that **serves** them at `/uploads` in dev and bakes them into the `nuxt generate`
artifact. In production the same files are served by NGINX/S3 at the same `/uploads` prefix
(`kestrel.media.baseUrl` / `KESTREL_MEDIA_BASE_URL` overrides the prefix).

### Published-media prune (build-side)

`nuxt generate`'s `copyPublicAssets` bakes the **whole** uploadDir into `.output/public/uploads` — which
would ship images of deleted or unpublished pages to production. To avoid that leak a build-side prune runs
after prerender: it scans the generated HTML / CSS / payload for `media.baseUrl` references and **deletes
every unreferenced file** from `.output/public/<baseUrl>/**`, so the deploy carries only what the published
pages actually reference.

It prunes the **bake only** — the media library (`.data/uploads` for the local driver, or the bucket) keeps
every original and derivative untouched. Keep-on-doubt: any key seen in *any* generated `.html` / `.css` /
`.json` is kept, so a wrong prune costs at most a re-generate (no data loss).

## Storage drivers

Media storage is abstracted behind a small driver contract (`put` / `copy` / `delete` / `exists` /
`ensureDir` / `removeDir` / `publicUrl`), selected by `media.driver`:

| Driver | Stores objects in | Serves them via |
|---|---|---|
| `local` (default) | the local `uploadDir` | Nitro `/uploads` static serving (dev) / the generated artifact / your web server |
| `s3` | an S3-compatible bucket (AWS S3, Cloudflare R2, MinIO) | the bucket / a CDN in front of it (`publicBaseUrl`) |

When `driver: 's3'`, the `/uploads` static route is **not** registered — the bucket (or CDN) serves the
files directly, so `publicUrl()` returns `${publicBaseUrl}/${prefix}/${key}`.

### S3 driver

A slim SigV4-over-`fetch` implementation ([`aws4fetch`](https://github.com/mhart/aws4fetch),
path-style addressing) — no AWS SDK. Configure the non-secret settings in `kestrel.config.ts` (or the
`KESTREL_S3_*` env fallbacks) and supply the **credentials via the environment only**:

```ts
// kestrel.config.ts
export default {
  media: {
    driver: 's3',
    s3: {
      bucket: 'my-bucket',
      region: 'eu-central-1',                    // 'auto' for Cloudflare R2
      endpoint: '',                              // e.g. 'https://<account>.r2.cloudflarestorage.com' (omit for AWS)
      prefix: 'media',                           // optional key prefix
      publicBaseUrl: 'https://cdn.example.com',  // where the bucket/CDN serves objects
    },
  },
} satisfies KestrelConfig
```

```sh
# credentials — env-only, never committed
export KESTREL_S3_ACCESS_KEY_ID=…
export KESTREL_S3_SECRET_ACCESS_KEY=…
export KESTREL_S3_SESSION_TOKEN=…   # optional (STS temporary credentials)
```

See [configuration.md](./configuration.md) for the full precedence and env mapping.

**Flat keyspace.** S3 has no real directories — "folders" are just shared key prefixes. Two
consequences differ from the local filesystem:

- `ensureDir` is a **no-op**. Empty folders cannot exist as objects; folder structure is tracked in the
  `folders` database table, not in the store.
- `removeDir` lists every object under the folder's `prefix/` (paginated `ListObjectsV2`) and
  batch-deletes them. The prefix always carries a trailing slash so deleting `a/` never touches a
  sibling like `ab/`, and an empty folder argument is a guarded no-op (it can never list/delete the
  whole bucket).

### Exposing the bucket

`publicUrl()` returns `${publicBaseUrl}/${prefix}/${key}` — but Kestrel never sets a per-object ACL. It
deliberately omits `x-amz-acl`, because modern buckets have ACLs **disabled** ("Bucket owner enforced"),
where a `public-read` ACL is rejected outright. You make objects reachable at the **bucket / CDN** level
instead, then set `publicBaseUrl` to match. Pick one:

- **Public bucket (simplest).** Turn off "Block Public Access" and attach a read-only bucket policy scoped
  to your `prefix/*`:

  ```json
  {
    "Version": "2012-10-17",
    "Statement": [{
      "Sid": "PublicReadMedia",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::my-bucket/media/*"
    }]
  }
  ```
  `publicBaseUrl` → `https://my-bucket.s3.<region>.amazonaws.com` (or your CDN domain).

- **Private bucket + CloudFront (recommended on AWS).** Keep "Block Public Access" on, put CloudFront in
  front with an **Origin Access Control (OAC)**, and grant the distribution `s3:GetObject` in the bucket
  policy (with an `AWS:SourceArn` condition). `publicBaseUrl` → the CloudFront domain.

- **Cloudflare R2.** Enable the bucket's public access (the `r2.dev` URL) or, better, attach a **custom
  domain**; `publicBaseUrl` → that domain. (For the SigV4 writes set `region: 'auto'` and
  `endpoint: 'https://<account>.r2.cloudflarestorage.com'`.)

Without one of these, uploads succeed but every `<img src>` / `srcset` returns 403 — the single most
common first-S3-deploy mistake.
