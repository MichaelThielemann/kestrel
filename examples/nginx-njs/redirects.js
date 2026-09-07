// Reference njs handler for polling a Kestrel `redirects.json` artifact.
//
// js_periodic handlers run on worker process 0 only (nginx default); the fetched
// list is written into a js_shared_dict_zone, which is shared memory readable by
// every worker, so the request handler below sees it regardless of which worker
// serves the request.
const dict = () => ngx.shared.redirects;

function applyList(list) {
  // [] is a valid, deliberate "no redirects configured" state (spec contract) -
  // it must overwrite any previous list, not be treated as a fetch failure.
  if (!Array.isArray(list)) throw new Error("body is not an array");
  dict().set("rules", JSON.stringify(list));
  dict().set("ready", "1");
}

function fetchRules() {
  const url = process.env.REDIRECTS_URL;
  ngx.fetch(url, { headers: { "Cache-Control": "no-cache" } })
    .then((r) => (r.status === 200 ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
    .then(applyList)
    // Last-known-good: on any fetch/parse error the previously stored "rules" key
    // is left untouched, so request handling keeps using the last good list.
    .catch((e) => ngx.log(ngx.WARN, `redirects: keeping last good list: ${e.message}`));
}

function fetchRulesCold() {
  // Second, faster js_periodic calls this. Once the first well-formed response
  // has landed ("ready" is set), the fast poller becomes a no-op and only the
  // steady-interval poller (fetchRules) keeps refreshing the list.
  if (dict().get("ready") === "1") return;
  fetchRules();
}

function redirect(r) {
  const raw = dict().get("rules");
  if (!raw) {
    r.internalRedirect("@origin");
    return;
  }
  const path = r.uri;
  let rules;
  try {
    rules = JSON.parse(raw);
  } catch (e) {
    // Defensive only: applyList() always stores valid JSON, so this should be unreachable.
    ngx.log(ngx.ERR, `redirects: corrupt shared dict entry: ${e.message}`);
    r.internalRedirect("@origin");
    return;
  }
  // njs does not support `for...of` (see nginx.org/en/docs/njs/compatibility.html) - indexed loop instead.
  for (let i = 0; i < rules.length; i++) {
    // No per-item shape check: rules come from Kestrel's compiler, which guarantees
    // { pattern, target, status } - not arbitrary/untrusted input.
    const rule = rules[i];
    const m = new RegExp(rule.pattern).exec(path);
    if (!m) continue;
    const target = rule.target.replace(/\$(\d+)/g, (_, n) => m[Number(n)] || "");
    // For 3xx codes, r.return()'s second argument IS the redirect URL - it sets
    // Location internally. Setting r.headersOut.Location manually beforehand does
    // not work: nginx's built-in redirect response generation overwrites it.
    r.return(rule.status, target);
    return;
  }
  r.internalRedirect("@origin");
}

export default { fetchRules, fetchRulesCold, redirect };
