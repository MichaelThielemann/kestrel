export default defineEventHandler((event) => {
  const base = siteBaseUrl()
  setHeader(event, 'content-type', 'text/plain; charset=utf-8')
  return buildRobots({
    sitemapUrl: base ? `${base}/sitemap.xml` : undefined,
    llmsUrl: base ? `${base}/llms.txt` : undefined,
    llmsFullUrl: base && llmsFullEnabled() ? `${base}/llms-full.txt` : undefined,
  })
})
