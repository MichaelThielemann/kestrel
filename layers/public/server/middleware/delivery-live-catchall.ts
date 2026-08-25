import { serveLiveRoute } from '../delivery-live/serve'

// Runs on every request; only intercepts when serveLiveRoute's own gate says so (delivery-live/ stays
// the single owner of when/how this adapter answers — see its TSDoc).
export default defineEventHandler(async (event) => {
  await serveLiveRoute(event)
})
