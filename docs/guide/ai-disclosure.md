# AI disclosure (EU AI Act Art. 50)

Kestrel lets an editor record how a media asset was produced, and hands that metadata to your templates — it never publishes a disclosure on its own.

## The `aiSourceType` and `aiNote` columns

Every media asset has two optional, non-localized columns. The admin editor exposes them on image assets
only; a video, PDF or other non-image asset carries the same columns but is classified through the API (see
[Recording it from the API](#recording-it-from-the-api) below).

| `aiSourceType` | meaning |
|---|---|
| `trainedAlgorithmicMedia` | Fully AI-generated |
| `compositeWithTrainedAlgorithmicMedia` | AI-generated content composited into real media (the Art. 50 "deepfake" case) |
| `algorithmicallyEnhanced` | AI-enhanced / algorithmically edited real media |
| *(unset — the default)* | No disclosure recorded — `aiDisclosure` resolves to `null`, so nothing renders |

`aiNote` is free text alongside it (the tool used, the prompt, whatever the editor wants to record). Both
are top-level columns, not per-locale `translations` entries: how a photo was made does not change per
translation.

**Off by default.** Turn it on in `kestrel.config.ts`:

```ts
export default { aiDisclosure: { enabled: true } } satisfies KestrelConfig
```

(env override: `KESTREL_AI_DISCLOSURE`). With the flag on, the media viewer gains a source-type select and
a note field on image assets; with it off, the admin shows nothing extra and a save from the viewer never
touches the columns. The flag gates the admin UI and the upload scan only: with it off, the admin controls
disappear, but the columns stay readable and stay writable through the API — `ResolvedMedia.aiDisclosure`
is always resolved regardless of the flag.

The two columns are additive and nullable; see [schema-lifecycle.md](./schema-lifecycle.md) for how a
schema change like this reaches an existing database.

## Recording it from the API

Outside the admin viewer, the disclosure travels through the same endpoints as everything else:

- **Upload** (`multipart/form-data`): send `aiSourceType` and/or `aiNote` alongside `file`. An unknown
  `aiSourceType` value 400s (`ValidationFailed`).
- **Update**: the media update body accepts the same two keys. Only keys actually present in the body are
  written — omitting a key leaves it unchanged, and an empty-string `aiNote` normalizes to `null`.

This is the path for importing content, migrating an existing library, or scripting a bulk classification.

## What Kestrel deliberately does NOT do

- **No pixel watermarking or label burn-in.** No server-side compositing, no EXIF/XMP writing, no C2PA
  manifest signing.
- **No automatic public markup.** Kestrel never injects a `<meta>` tag, JSON-LD or a visible badge into a
  published page on its own — a silently-added claim in the wrong place, language or style is worse than
  none.

You remain the Art. 50 deployer. Kestrel stores and manages the metadata and hands it to you; how (or
whether) you disclose on your site is your decision and your legal responsibility.

## Upload-time signal scan

While the flag is on, each upload is scanned for signals that a file was AI-produced, and what is found is
quoted into `aiNote` (prefixed `Detected at upload:`). What it reads:

- **IPTC/XMP `DigitalSourceType`** — the generator's own declaration, in the same vocabulary as the column.
- **C2PA content credentials** — detected structurally, presence only (a JUMBF store, read from the
  container-specific chunk each format uses).
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
   or re-encoding, and container support is uneven — EXIF is read from JPEG, PNG and AVIF; WebP and GIF only
   yield the XMP packet (plus, for WebP, the C2PA chunk); the PNG generation-chunk check is PNG-only.

## Reading the disclosure in your own templates

Every resolved media relation carries it, so nothing about the badge below is required:

```vue
<script setup lang="ts">
const { data } = await useFetch('/api/pages/readOne/1?depth=1')
</script>

<template>
  <figure>
    <KestrelImg :media="data.$media.hero" :widths="[640, 1280]" />
    <figcaption v-if="data.$media.hero?.aiDisclosure">
      {{ data.$media.hero.aiDisclosure.note ?? aiSourceTypeLabel(data.$media.hero.aiDisclosure.sourceType) }}
    </figcaption>
  </figure>
</template>
```

`aiDisclosure` is `{ sourceType, note }` when a source type is set, and `null` otherwise — a note without a
source type is only evidence, so it never resolves to a half-filled object.

## The optional `KestrelImg` badge

If you would rather not build your own element, `<KestrelImg>` can render one — opt-in, and unstyled:

```vue
<KestrelImg :media="hero" :widths="[640, 1280]" ai-badge />
```

It renders only when `aiSourceType` is set — a note-only asset (including every asset the upload scan
pre-filled with `Detected at upload: …`) has no disclosure yet and shows no badge, until an editor
classifies it. When it does render, it emits a single
`<span class="kestrel-img__ai-badge" data-ai-source-type="…">` inside the `<picture>`, whose text is the
`aiNote` (falling back to a short English label). Kestrel gives the badge layout only — absolute placement
in the picture's lower-inline-start corner and `pointer-events: none` — and no color, background, border,
radius or font, so it is invisible until your stylesheet designs it. It also restyles the `<picture>` that
contains a badge, to `position: relative; display: inline-block` — worth knowing if your own CSS expects
`picture` to stay a plain block:

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

The rules Kestrel ships are deliberately unscoped, so a plain `.kestrel-img__ai-badge` selector in your
own CSS wins.

## See also

- [media.md](./media.md) — uploads, image processing, and the storage drivers this feature sits alongside.
- [configuration.md](./configuration.md) — where `aiDisclosure` and other `kestrel.config.ts` keys live.
- [querying.md](./querying.md) — how `?depth` resolves media relations, including `aiDisclosure`.
- [schema-lifecycle.md](./schema-lifecycle.md) — how an additive schema change like these two columns reaches an existing database.
