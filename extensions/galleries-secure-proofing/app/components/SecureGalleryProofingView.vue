<script setup>
// CUSTOMER proofing view. Drives ONE base `useSecureGallery` instance (password → decrypted tree + `seal`),
// reuses the base recursive grid `<SecureGalleryNodes>` and overlays a colour-flag + comment control per
// photo via its `#image` slot. Marks are sealed + submitted (debounced) through `useProofing` — only
// ciphertext leaves the browser. `useSecureGallery`/`SecureGalleryNodes` (base layer), `useProofing`/
// `PROOFING_COLORS` (this layer) are auto-imported. Plain HTML + scoped CSS (public site, no admin tokens).
import { ref, watch } from 'vue'

const props = defineProps(['gallery', 'gallerySlug'])

const { state, error, tree, unlock, seal, open } = useSecureGallery(() => props.gallery, { autoFromHash: true })
const { marks, setMark, status, loadMine } = useProofing({ gallerySlug: props.gallerySlug, seal, open })
// On unlock, restore the customer's own previously-submitted marks (so a reload shows them again).
watch(state, (s) => { if (s === 'unlocked') loadMine() })

const password = ref('')
function submit() { if (password.value) unlock(password.value) }

const markOf = (blobKey) => marks.value[blobKey] ?? {}
function toggleColor(blobKey, color) {
  const cur = markOf(blobKey)
  setMark(blobKey, { ...cur, color: cur.color === color ? undefined : color })
}
function onComment(blobKey, e) {
  setMark(blobKey, { ...markOf(blobKey), comment: e.target.value })
}
const statusLabel = { saving: 'Saving…', saved: 'Saved', error: 'Save failed', idle: '' }
</script>

<template>
  <section class="sgp">
    <ClientOnly>
      <p v-if="!gallery" class="sgp__note">This gallery is empty.</p>
      <p v-else-if="state === 'unlocked' && !tree.length" class="sgp__note">This gallery is empty.</p>
      <template v-else-if="state === 'unlocked'">
        <p class="sgp__status" :class="`sgp__status--${status}`" role="status" aria-live="polite">{{ statusLabel[status] }}</p>
        <SecureGalleryNodes :nodes="tree">
          <template #image="{ image }">
            <figure class="sgp__item" :class="markOf(image.blobKey).color ? `sgp__item--${markOf(image.blobKey).color}` : ''">
              <img v-if="!image.failed" :src="image.src" :alt="image.name" :title="image.name" loading="lazy" />
              <span v-else class="sgp__fail">Could not decrypt this image.</span>
              <div class="sgp__flags">
                <button
                  v-for="c in PROOFING_COLORS" :key="c" type="button"
                  class="sgp__flag" :class="[`sgp__flag--${c}`, { 'is-on': markOf(image.blobKey).color === c }]"
                  :aria-label="`Flag ${c}`" :aria-pressed="markOf(image.blobKey).color === c"
                  @click="toggleColor(image.blobKey, c)"
                />
              </div>
              <textarea
                class="sgp__comment" rows="2" placeholder="Comment…" maxlength="2000"
                :value="markOf(image.blobKey).comment ?? ''" @input="onComment(image.blobKey, $event)"
              />
            </figure>
          </template>
        </SecureGalleryNodes>
      </template>
      <form v-else class="sgp__lock" @submit.prevent="submit">
        <p class="sgp__note">This gallery is protected. Enter the password to view and rate the photos.</p>
        <div class="sgp__row">
          <input v-model="password" type="password" class="sgp__input" placeholder="Password" aria-label="Password" autocomplete="current-password" :disabled="state === 'unlocking'" />
          <button type="submit" class="sgp__btn" :disabled="state === 'unlocking' || !password">{{ state === 'unlocking' ? 'Decrypting…' : 'View' }}</button>
        </div>
        <p v-if="error" class="sgp__error">{{ error }}</p>
      </form>
      <template #fallback>
        <p class="sgp__note">This gallery is protected. Enter the password to view and rate the photos.</p>
      </template>
    </ClientOnly>
  </section>
</template>

<style scoped>
.sgp { margin: 1.5rem 0; }
.sgp__note { color: #555; font-size: 0.95rem; }
.sgp__row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.sgp__input { padding: 0.5rem 0.75rem; border: 1px solid #ccc; border-radius: 0.375rem; font: inherit; }
.sgp__btn { padding: 0.5rem 1rem; border: 1px solid #ccc; border-radius: 0.375rem; background: #f5f5f5; cursor: pointer; font: inherit; }
.sgp__btn:disabled { opacity: 0.5; cursor: default; }
.sgp__error { color: crimson; font-size: 0.9rem; }
.sgp__status { min-height: 1.2em; font-size: 0.8rem; color: #595959; margin: 0 0 0.5rem; } /* ≈7:1 */
.sgp__status--error { color: #b91c1c; } /* red-700 ≈5.9:1 */
.sgp__item { margin: 0; border: 3px solid transparent; border-radius: 0.5rem; padding: 0.25rem; }
.sgp__item img { width: 100%; height: auto; border-radius: 0.375rem; display: block; }
.sgp__item--red { border-color: #e23; }
.sgp__item--yellow { border-color: #ec0; }
.sgp__item--green { border-color: #2b6; }
.sgp__item--blue { border-color: #28d; }
.sgp__item--purple { border-color: #a4e; }
.sgp__fail { display: grid; place-items: center; aspect-ratio: 1; background: #faf0f0; color: crimson; border-radius: 0.375rem; font-size: 0.8rem; text-align: center; padding: 0.5rem; }
.sgp__flags { display: flex; gap: 0.35rem; margin: 0.4rem 0; }
.sgp__flag { width: 1.1rem; height: 1.1rem; border-radius: 50%; border: 2px solid #0002; cursor: pointer; padding: 0; opacity: 0.45; }
.sgp__flag.is-on { opacity: 1; box-shadow: 0 0 0 2px #0003; }
.sgp__flag--red { background: #e23; }
.sgp__flag--yellow { background: #ec0; }
.sgp__flag--green { background: #2b6; }
.sgp__flag--blue { background: #28d; }
.sgp__flag--purple { background: #a4e; }
.sgp__comment { width: 100%; box-sizing: border-box; border: 1px solid #ccc; border-radius: 0.375rem; font: inherit; font-size: 0.85rem; padding: 0.35rem 0.5rem; resize: vertical; }
</style>
