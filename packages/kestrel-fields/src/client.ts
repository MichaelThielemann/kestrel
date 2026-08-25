/**
 * The browser-safety boundary: only the pure, `node:`-free pieces admin/ui components import directly in
 * the client bundle. Mirrors `@kestrel/core/client`'s reason for existing (see that entry's own TSDoc) —
 * built after `@kestrel/core` learned the hard way that a server-only import reaching the browser bundle
 * crashes every admin page at module-link time.
 *
 * @packageDocumentation
 */

export { fieldConstraints, type FieldConstraints } from './app/utils/field-meta.js'
export { tryParseJson } from './app/utils/field-value.js'
export { validateField } from './app/utils/field-validate.js'
// Same exported name as `defineBlock` from the main entry (the content-wrapping identity helper) —
// harmless: they live at separate entry points (`@kestrel/fields` vs `@kestrel/fields/client`) and are
// never both in scope in the same file (a block SFC's `<script setup>` only ever needs this one, the
// metadata no-op; server-side code only ever needs the other).
export { defineBlock } from './app/utils/define-block.js'
