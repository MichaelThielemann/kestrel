<script setup lang="ts">
import {
  DropdownMenuRoot, DropdownMenuTrigger, DropdownMenuPortal, DropdownMenuContent,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuItemIndicator, DropdownMenuItem,
} from 'reka-ui'

// The rail's pseudo-account area: an avatar that opens an account menu (UI-language + sign out).
const { t, lang } = useT()
const { logout } = useAuth()

// Single-user admin for now — static initials. A natural seam for a real display name later.
const initials = 'AD'

// reka's DropdownMenuRadioGroup emits the broad `AcceptableValue`; accept `unknown` and coerce to our lang.
function selectLang(value: unknown) { lang.value = value as string }
function signOut() { logout() }

// Exposed for the component test: the menu itself is teleported (not rendered by happy-dom), so the
// load-bearing handlers are asserted directly.
defineExpose({ lang, selectLang, signOut })
</script>

<template>
  <DropdownMenuRoot>
    <DropdownMenuTrigger as-child>
      <button type="button" class="rail-account__trigger" :aria-label="t('account.label')" :title="t('account.label')">
        <span class="rail-account__avatar" aria-hidden="true">{{ initials }}</span>
        <span class="rail-account__name rail__label">{{ t('account.name') }}</span>
        <KestrelUiIcon name="chevron-down" class="rail-account__caret rail__label" size="1rem" />
      </button>
    </DropdownMenuTrigger>

    <DropdownMenuPortal>
      <DropdownMenuContent
        class="rail-account__menu"
        side="top"
        align="start"
        :side-offset="6"
        :collision-padding="8"
      >
        <DropdownMenuLabel class="rail-account__head">
          <span class="rail-account__avatar rail-account__avatar--sm" aria-hidden="true">{{ initials }}</span>
          <span class="rail-account__head-name">{{ t('account.name') }}</span>
        </DropdownMenuLabel>

        <DropdownMenuSeparator class="rail-account__sep" />

        <DropdownMenuLabel class="rail-account__group-label">{{ t('lang.label') }}</DropdownMenuLabel>
        <DropdownMenuRadioGroup :model-value="lang" @update:model-value="selectLang">
          <DropdownMenuRadioItem
            v-for="l in ADMIN_LANGS"
            :key="l"
            :value="l"
            class="rail-account__item"
          >
            <span class="rail-account__check">
              <DropdownMenuItemIndicator>
                <KestrelUiIcon name="check" size="1rem" />
              </DropdownMenuItemIndicator>
            </span>
            <span>{{ l.toUpperCase() }}</span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator class="rail-account__sep" />

        <DropdownMenuItem class="rail-account__item rail-account__item--danger" @select="signOut">
          <KestrelUiIcon name="log-out" size="1rem" class="rail-account__item-icon" />
          <span>{{ t('nav.signOut') }}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>

<style lang="scss">
// Not scoped: Reka teleports DropdownMenuContent to <body>, where a scoped data-v selector no longer
// matches (same reason UiMenu's styles are global). The trigger lives in the rail; keeping the whole
// component's styles global is simplest and consistent with the other portaled overlays.
.rail-account__trigger {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  margin-bottom: var(--space-1);
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;

  &:hover {
    background: var(--color-hover);
  }
  &:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: -2px;
  }
  &[data-state='open'] {
    background: var(--color-active, var(--color-surface-2));
  }
}

.rail-account__avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border-strong, var(--color-border));
  background: var(--color-surface-2);
  color: var(--color-text);
  font-size: var(--text-xs, 0.75rem);
  font-weight: var(--weight-bold);
  letter-spacing: 0.02em;

  &--sm {
    width: 1.5rem;
    height: 1.5rem;
  }
}

.rail-account__name {
  font-weight: var(--weight-medium);
}
.rail-account__caret {
  margin-left: auto; // push the chevron to the right edge of the full-width trigger
  flex-shrink: 0;
  color: var(--color-text-muted);
}

// Menu surface — mirrors .ui-menu so the account dropdown reads like the rest of the admin chrome.
.rail-account__menu {
  min-width: 13rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  padding: var(--space-1);
  z-index: var(--z-dropdown);
}

.rail-account__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-2);
}
.rail-account__head-name {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.rail-account__group-label {
  padding: var(--space-1) var(--space-2);
  font-size: var(--text-xs, 0.75rem);
  font-weight: var(--weight-medium);
  color: var(--color-text-muted);
}

.rail-account__sep {
  height: 1px;
  margin: var(--space-1) calc(var(--space-1) * -1);
  background: var(--color-border);
}

.rail-account__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  color: var(--color-text);
  cursor: pointer;
  user-select: none;

  &[data-highlighted] {
    background: var(--color-hover);
    outline: none;
  }
  &--danger {
    color: var(--color-danger);
  }
}

.rail-account__check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1rem;
  flex-shrink: 0;
  color: var(--color-primary);
}
.rail-account__item-icon {
  flex-shrink: 0;
}

// Collapsed rail: drop the label + caret and centre the avatar (mirrors .rail__item's collapsed rule).
.admin--rail-collapsed .rail-account__trigger {
  justify-content: center;
  gap: 0;
}
</style>
