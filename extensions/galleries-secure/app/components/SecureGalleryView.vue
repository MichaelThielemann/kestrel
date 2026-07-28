<script setup lang="ts">
// The ready-to-use PUBLIC display: a thin shell over `useSecureGallery`. Drop `<SecureGalleryView :gallery
// ="…" />` into your own block's display component and the whole flow works with zero crypto code — default
// password form + default folder/grid. Advanced consumers skip this and build their own UI on
// `useSecureGallery` directly. SSG-safe: all decryption is client-side (`<ClientOnly>`); the static page
// ships only ciphertext URLs + this JS. Plain HTML + scoped CSS (the admin design system is /admin-scoped
// and not loaded here). Forwards a per-image scoped slot for overlay customization.
import { computed, ref } from 'vue'
import { useSecureGallery, type GalleryViewRef } from '../composables/useSecureGallery'

// The user-facing strings, English by default. This is a shipped PUBLIC component with no admin-i18n
// catalog available, so localization is a consumer OVERRIDE SEAM: pass `:labels` to translate (or reword)
// any subset. `labels` = null keys fall back to the English defaults below.
export interface SecureGalleryLabels {
  empty?: string
  locked?: string
  password?: string
  decrypting?: string
  view?: string
  decryptingStatus?: string
}
const DEFAULT_LABELS: Required<SecureGalleryLabels> = {
  empty: 'This gallery is empty.',
  locked: 'This gallery is protected. Enter the password to view it.',
  password: 'Password',
  decrypting: 'Decrypting…',
  view: 'View',
  decryptingStatus: 'Decrypting the gallery…',
}

// `gallery` is the public field ref PLUS the storage `base` URL (the consumer's endpoint supplies both,
// e.g. the playground's `/api/public-gallery`).
const props = defineProps<{ gallery?: GalleryViewRef | null; labels?: SecureGalleryLabels }>()
const l = computed<Required<SecureGalleryLabels>>(() => ({ ...DEFAULT_LABELS, ...(props.labels ?? {}) }))
const { state, error, tree, unlock } = useSecureGallery(() => props.gallery, { autoFromHash: true })

const password = ref('')
function submit() { if (password.value) unlock(password.value) }
</script>

<template>
  <section class="sgv">
    <ClientOnly>
      <p v-if="!gallery" class="sgv__note">{{ l.empty }}</p>
      <p v-else-if="state === 'unlocked' && !tree.length" class="sgv__note">{{ l.empty }}</p>
      <SecureGalleryNodes v-else-if="state === 'unlocked'" :nodes="tree">
        <template v-if="$slots.image" #image="slotProps"><slot name="image" v-bind="slotProps" /></template>
      </SecureGalleryNodes>
      <form v-else class="sgv__lock" @submit.prevent="submit">
        <p class="sgv__note">{{ l.locked }}</p>
        <div class="sgv__row">
          <input v-model="password" type="password" class="sgv__input" :placeholder="l.password" :aria-label="l.password" autocomplete="current-password" :disabled="state === 'unlocking'" />
          <button type="submit" class="sgv__btn" :disabled="state === 'unlocking' || !password">{{ state === 'unlocking' ? l.decrypting : l.view }}</button>
        </div>
        <!-- role=alert so a wrong-password failure is spoken; the decrypting state gets a polite status. -->
        <p v-if="error" class="sgv__error" role="alert">{{ error }}</p>
        <p class="sgv__sr" aria-live="polite">{{ state === 'unlocking' ? l.decryptingStatus : '' }}</p>
      </form>
      <template #fallback>
        <!-- Static (SSG/SSR) shell — decryption happens client-side on hydration. -->
        <p class="sgv__note">{{ l.locked }}</p>
      </template>
    </ClientOnly>
  </section>
</template>

<style scoped>
.sgv { margin: 1.5rem 0; }
.sgv__note { color: #555; font-size: 0.95rem; }
.sgv__row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.sgv__input { padding: 0.5rem 0.75rem; border: 1px solid #ccc; border-radius: 0.375rem; font: inherit; }
.sgv__btn { padding: 0.5rem 1rem; border: 1px solid #ccc; border-radius: 0.375rem; background: #f5f5f5; cursor: pointer; font: inherit; }
.sgv__btn:disabled { opacity: 0.5; cursor: default; }
.sgv__error { color: #b91c1c; font-size: 0.9rem; } /* red-700 ≈ 5.9:1 on white */
.sgv__sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
</style>
