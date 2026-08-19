// Browser options shared by every `browser: true` e2e suite.
//
// CI ships a Playwright-managed browser; locally there usually isn't one, so `KESTREL_E2E_BROWSER_PATH`
// points at a system Chrome/Chromium instead. Without it a developer can only run the API suites, and the
// browser ones fail on a missing binary rather than on anything they assert.
export const e2eBrowserOptions = {
  type: 'chromium',
  launch: process.env.KESTREL_E2E_BROWSER_PATH ? { executablePath: process.env.KESTREL_E2E_BROWSER_PATH } : {},
} as const
