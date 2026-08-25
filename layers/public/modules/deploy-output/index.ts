import { defineNuxtModule } from '@nuxt/kit'
import { createS3Driver } from '@kestrel/core'
import { resolveOutputCreds, deployStaticOutput, isEnvTrue, planS3Deploy, readRouteDiscovery } from '@kestrel/delivery-static'
import { resolveKestrel } from '@kestrel/core'
import type { KestrelConfig } from '@kestrel/core'
/**
 * Ships `nuxt generate`'s static output (`.output/public`) to an S3 bucket when `kestrel.output.driver`
 * is `s3` — the deploy half of FEATURES "Output target: local directory or S3 bucket". Runs on Nitro's
 * `compiled` hook (which fires once the full output is on disk — prerendered HTML, the `_nuxt` client
 * bundle + static `public/` assets copied by `copyPublicAssets`, and any compressed variants — i.e. after
 * prerendering, which does NOT abort on a route error unless `prerender.failOnError` is set: hence the
 * `incomplete` signal below), and only when `nitro.options.static` is set, i.e. a real `nuxt generate`.
 * A plain `nuxt build`/`dev` never deploys.
 * Nor does it with `output.auto` on — then the running server owns publishing (see the `auto` note below).
 * With `driver: local` (the default) it does nothing — the local `.output/public` tree is the artifact.
 * S3 credentials are env-only (`KESTREL_OUTPUT_S3_*`, falling back to the shared media `KESTREL_S3_*`).
 */
export default defineNuxtModule({
  meta: { name: 'kestrel-deploy-output' },
  setup(_options, nuxt) {
    // Build-time: resolve from the consumer's config through the one shared resolver, so driver, prefixes
    // and `auto` here are byte-identical to what the runtime publisher and the media driver see — an
    // ad-hoc env probe that disagrees (env-first vs config-first) would silently disarm the guards below.
    const c = resolveKestrel(nuxt.options.kestrel as KestrelConfig, process.env, nuxt.options.rootDir)
    if (c.output.driver !== 's3') return
    const target = c.output.s3

    // Where the S3 media driver keeps live uploads — used to stop the reconcile from wiping them when the
    // generated site shares its bucket. Undefined (media on the local driver) makes the guard a no-op.
    const mediaS3 = c.media.driver === 's3' ? c.media.s3 : undefined

    nuxt.hook('nitro:init', (nitro) => {
      // Nitro prerenders BEFORE the build that fires `compiled`, and `prerender.failOnError` is off by
      // default — a route that 5xx'd leaves no file and does not abort the generate. Remember that here:
      // its live page is still there and must not be mistaken for content removed from the CMS.
      let failedRoutes = 0
      nitro.hooks.hook('prerender:done', ({ failedRoutes: failed }) => { failedRoutes = failed?.length ?? 0 })

      nitro.hooks.hook('compiled', async () => {
        const env = process.env
        const creds = resolveOutputCreds(env)
        const dryRun = isEnvTrue(env.KESTREL_OUTPUT_DRY_RUN)
        // Skip on a plain build (no static generate) or when the runtime publisher owns the bucket;
        // throw on a misconfigured real deploy or unsafe reconcile.
        if (planS3Deploy({
          isStaticGenerate: nitro.options.static === true,
          autoPublish: c.output.auto,
          dryRun,
          bucket: target.bucket,
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          prefix: target.prefix,
          mediaBucket: mediaS3?.bucket,
          mediaPrefix: mediaS3?.prefix,
        }) === 'skip') {
          // A plain build skips silently; someone who actually ran `nuxt generate` deserves to hear why
          // nothing shipped.
          if (nitro.options.static === true && c.output.auto) {
            console.log('[kestrel] output.auto is on — the running server publishes to this bucket; not shipping'
              + ' .output/public. Set output.auto=false (or KESTREL_OUTPUT_AUTO=false) for the build-time model.')
          }
          return
        }

        const driver = createS3Driver({ ...target, publicBaseUrl: '', ...creds })
        console.log(`[kestrel] ${dryRun ? 'dry-run: ' : ''}shipping static output → s3://${target.bucket || '<bucket>'}/${target.prefix}`)
        // Both signals are REPORTED failures of a step that knows: route discovery could not enumerate the
        // pages, or Nitro could not render some of them. Neither is inferred from how the tree looks —
        // no shape of output distinguishes a degraded build from a small site.
        const discovery = readRouteDiscovery(nuxt)
        const res = await deployStaticOutput(nitro.options.output.publicDir, driver, {
          dryRun,
          incomplete: discovery?.incomplete ?? (failedRoutes ? `${failedRoutes} route(s) failed to prerender` : undefined),
          log: (m) => console.log(`[kestrel] ${m}`),
        })
        console.log(`[kestrel] static output ${dryRun ? 'walk' : 'deploy'} complete — ${res.keys.length} file(s), ${res.pruned} pruned.`)
      })
    })
  },
})
