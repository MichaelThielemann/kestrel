export default defineNuxtRouteMiddleware(async (to) => {
  if (await useAuth().ensureSession()) return
  return navigateTo(`/admin/login?redirect=${encodeURIComponent(to.fullPath)}`)
})
