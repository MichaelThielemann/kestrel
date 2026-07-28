import { computed, ref, onMounted, watch, toValue, type MaybeRefOrGetter } from 'vue'
import { thumbhashToDataUrl } from '../utils/thumbhash'

/**
 * Blur-up image loading state for an `<img>` painted over a thumbhash placeholder. Returns the bits a
 * renderer binds: the element ref, the placeholder background style (shown until the raster paints), and
 * an `onLoad` handler that drives a one-shot "sharpen-in".
 *
 * Degradation is deliberate: `animate`/`loaded`/`placeholder` are false/null on the server and the
 * initial client render (so hydration matches and no-JS just shows the image — width/height reserve the
 * box, so no layout shift). `animate` is set ONLY on a genuine async load, not for an image that was
 * already `complete` at mount (a cached revisit), so a cached image doesn't flash a blur every time.
 *
 * The thumbhash placeholder is decoded CLIENT-SIDE only. `thumbHashToDataURL` inflates the ~30-byte
 * thumbhash string (already shipped in the payload) into a ~6 KB PNG data URL; inlining that in SSR
 * bloats the HTML by hundreds of KB on an image-dense page. Decoding after mount keeps the blur-up for
 * JS clients while shipping a lean document (measured: −305 KB HTML on a 69-image page).
 */
export function useBlurUp(thumbhash: MaybeRefOrGetter<string | null | undefined>) {
  const imgEl = ref<HTMLImageElement | null>(null)
  const loaded = ref(false)
  const animate = ref(false)
  const placeholder = ref<string | null>(null) // null on SSR + first client render; decoded on mount

  const placeholderStyle = computed(() => {
    if (!placeholder.value || loaded.value) return undefined
    return {
      backgroundImage: `url(${placeholder.value})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat',
    }
  })

  function onLoad() {
    // A real (async) decode — the only case that should animate. A cached image is caught by the
    // `complete` check below and flips `loaded` without arming `animate`.
    if (!loaded.value) animate.value = true
    loaded.value = true
  }
  onMounted(() => {
    // A cached image is already painted → skip the placeholder entirely (no blur flash). Otherwise
    // decode the thumbhash now (client-only) so the blur shows until the raster arrives.
    if (imgEl.value?.complete) loaded.value = true
    else placeholder.value = thumbhashToDataUrl(toValue(thumbhash))
  })

  // A reactive media swap (the public BlockRenderer is reused in the admin live preview and keys blocks
  // by id, so editing an image reuses this instance instead of remounting) must restart the blur-up for
  // the new image — re-decode the new placeholder. Not immediate, so the server/first-client render is
  // untouched (no hydration impact).
  watch(() => toValue(thumbhash), (h) => { loaded.value = false; animate.value = false; placeholder.value = thumbhashToDataUrl(h) })

  return { imgEl, loaded, animate, placeholderStyle, onLoad }
}
