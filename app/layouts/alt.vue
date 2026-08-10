<!-- Demo scaffolding for the playground/e2e, not product: the engine root's `app/` is outside the published
     `files` list. It exists so the demo site ships MORE than one layout, which is what makes the page
     editor's layout select appear at all (a single-layout project has nothing to choose). -->
<template>
  <main data-layout="alt">
    <slot />
  </main>
</template>
