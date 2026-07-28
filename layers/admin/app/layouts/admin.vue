<script setup lang="ts">
// The admin design system (tokens / reset / base) loads HERE — with the admin-layout chunk — rather than
// app-globally, so it stays scoped to /admin and never leaks Kestrel's reset onto a consumer's public site
// (which ships its own CSS, e.g. Bootstrap). Every admin route uses this layout, so coverage is complete.
import '../../../ui/app/assets/scss/main.scss'

const { authenticated } = useAuth()
const { collapsed, toggle: toggleRail } = useRailCollapsed()
const { theme, toggle: toggleTheme } = useTheme()
const { t } = useT()

// Bind the resolved theme onto <html> so the admin palette (and teleported widgets) pick it up, and
// re-assert the root font-size while the admin is mounted. The admin is entirely rem-based and assumes
// the browser-default root; a consumer that sets `html { font-size: … }` on its public site would
// otherwise rescale the whole panel (rem resolves against the shared root, which no admin-side selector
// can override). An inline style beats a consumer stylesheet rule in the cascade without needing
// `!important`; `initial` restores the user-agent default (respecting the visitor's own font-size
// preference). unhead removes both attributes when the admin layout unmounts, so the public site keeps
// its own root. In dev the style guard also strips the consumer sheet outright (see
// admin-style-guard.client.ts); this reassert is the production-safe half of the defense.
// No admin page sets its own <title> today, so this fallback is the only one every route gets — a
// per-page useHead still wins (titleTemplate only fires when a title is actually set).
useHead(() => ({
  title: 'Kestrel',
  titleTemplate: (title) => (title && title !== 'Kestrel' ? `${title} · Kestrel` : 'Kestrel'),
  htmlAttrs: { 'data-theme': theme.value, style: 'font-size: initial' },
}))
</script>

<template>
  <div class="admin" :class="{ 'admin--rail-collapsed': collapsed }">
    <aside v-if="authenticated" class="admin__rail">
      <div class="rail__head">
        <NuxtLink to="/admin" class="rail__brand" aria-label="Kestrel">
          <UiBrand />
          <span class="rail__brand-word rail__label">kestrel</span>
        </NuxtLink>
        <button
          type="button"
          class="rail__toggle"
          :aria-label="collapsed ? t('a11y.expandSidebar') : t('a11y.collapseSidebar')"
          @click="toggleRail"
        >
          <UiIcon :name="collapsed ? 'panel-left-open' : 'panel-left-close'" size="1.25rem" />
        </button>
      </div>

      <div class="rail__nav">
        <NuxtLink
          to="/admin"
          class="rail__item rail__item--dashboard"
          :title="collapsed ? t('nav.dashboard') : undefined"
        >
          <UiIcon name="home" class="rail__icon" size="1.25rem" />
          <span class="rail__label">{{ t('nav.dashboard') }}</span>
        </NuxtLink>

        <AdminNav />
      </div>

      <div class="rail__foot">
        <AdminAccount />
        <button
          type="button"
          class="rail__item"
          :title="collapsed ? (theme === 'dark' ? t('theme.light') : t('theme.dark')) : undefined"
          :aria-label="theme === 'dark' ? t('a11y.toLight') : t('a11y.toDark')"
          @click="toggleTheme"
        >
          <UiIcon :name="theme === 'dark' ? 'sun' : 'moon'" class="rail__icon" size="1.25rem" />
          <span class="rail__label">{{ theme === 'dark' ? t('theme.light') : t('theme.dark') }}</span>
        </button>
      </div>
    </aside>

    <main class="admin__main"><slot /></main>
    <UiToasts />
  </div>
</template>

<style lang="scss">
.admin {
  display: flex;
  align-items: flex-start;
  min-height: 100svh;
  background: var(--color-bg);

  &__rail {
    position: sticky;
    top: 0;
    flex: 0 0 var(--rail-width);
    width: var(--rail-width);
    height: 100svh;
    display: flex;
    flex-direction: column;
    background: var(--color-rail-bg);
    border-right: 1px solid var(--color-border);
    transition:
      flex-basis var(--motion-base) var(--ease-standard),
      width var(--motion-base) var(--ease-standard);
  }

  // App-shell: the main column is locked to the viewport height and never scrolls itself — each page
  // (and, in the editor, each of its panes) owns its own scroll region instead.
  &__main {
    flex: 1 1 auto;
    min-width: 0;
    height: 100svh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    padding: var(--space-4);
  }

  // Scroll-ownership convention — every admin page follows it. The page section handed this
  // `flex:1 1 auto; min-height:0` is a flex column that NEVER scrolls itself (overflow:hidden); it keeps
  // its header/toolbar fixed (flex:0 0 auto) and delegates vertical scroll to exactly ONE inner region
  // (flex:1 1 auto; min-height:0; overflow:auto). One unbroken min-height:0 chain reaches that region, so
  // nothing else clips (inline popovers stay visible). Those regions, by page: the list table
  // (.list__scroll), the flat/blocks editor body (.editor__flat / .editor3 panes), the media grid
  // (.media-library__items) and the references table (.refs__scroll).
  &__main > * {
    flex: 1 1 auto;
    min-height: 0;
  }

  // Collapsed rail: narrow to icon-only width.
  &--rail-collapsed &__rail {
    flex-basis: var(--rail-width-collapsed);
    width: var(--rail-width-collapsed);
  }
}

.rail {
  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-3);
  }

  &__brand {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    color: var(--color-text);
    text-decoration: none;
    font-weight: var(--weight-bold);
    border-radius: var(--radius-sm);

    &:focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: -2px;
    }
  }

  &__toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    padding: var(--space-1);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-muted);
    cursor: pointer;

    &:hover {
      background: var(--color-hover);
      color: var(--color-text);
    }
    &:focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: -2px;
    }
  }

  &__nav {
    flex: 1 1 auto;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
  }

  // Shared item used by the static links, the collection links (AdminNav) and Sign out.
  &__item {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-sm);
    text-align: left;
    text-decoration: none;
    cursor: pointer;

    &:hover {
      background: var(--color-hover);
    }
    &:focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: -2px;
    }
    // Calm active state: a neutral fill (not a tinted pill) with the icon carrying a restrained accent.
    &.router-link-active {
      background: var(--color-active, var(--color-surface-2));
      color: var(--color-text);
      font-weight: var(--weight-medium);
    }
  }

  &__item.router-link-active &__icon {
    color: var(--color-primary);
  }

  &__icon {
    flex-shrink: 0;
  }

  &__label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__foot {
    padding: var(--space-3);
    border-top: 1px solid var(--color-border);
  }

}

// Collapsed state: hide labels (kept in the DOM for a11y + tests), center icons.
.admin--rail-collapsed {
  .rail__label {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .rail__item {
    justify-content: center;
    gap: 0;
  }
  .rail__head {
    flex-direction: column;
    align-items: center;
  }
}
</style>
