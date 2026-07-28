// The UI design system (tokens / reset / base in app/assets/scss/main.scss) is intentionally NOT loaded
// app-globally — that would leak Kestrel's CSS reset + base styles onto a consumer's public site and fight
// their own CSS (e.g. Bootstrap). It is imported by the admin layout (layers/admin/app/layouts/admin.vue)
// instead, which scopes it to /admin: every admin route uses that layout, and /admin/** is ssr:false.
export default defineNuxtConfig({})
