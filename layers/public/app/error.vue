<script setup lang="ts">
import type { NuxtError } from '#app'
defineProps<{ error: NuxtError }>()
</script>

<template>
  <main>
    <h1>{{ error.statusCode }}</h1>
    <p>{{ error.statusCode === 404 ? 'Page not found.' : 'Something went wrong.' }}</p>
    <NuxtLink to="/">Home</NuxtLink>
  </main>
</template>
