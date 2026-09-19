const dict = () => ngx.shared.redirects;

function applyList(list) {
  if (!Array.isArray(list)) throw new Error("body is not an array");
  dict().set("rules", JSON.stringify(list));
  dict().set("ready", "1");
}

function fetchRules() {
  const url = process.env.REDIRECTS_URL;
  ngx.fetch(url, { headers: { "Cache-Control": "no-cache" } })
    .then((r) => (r.status === 200 ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
    .then(applyList)
    .catch((e) => ngx.log(ngx.WARN, `redirects: keeping last good list: ${e.message}`));
}

function fetchRulesCold() {
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
    ngx.log(ngx.ERR, `redirects: corrupt shared dict entry: ${e.message}`);
    r.internalRedirect("@origin");
    return;
  }
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const m = new RegExp(rule.pattern).exec(path);
    if (!m) continue;
    const target = rule.target.replace(/\$(\d+)/g, (_, n) => m[Number(n)] || "");
    r.return(rule.status, target);
    return;
  }
  r.internalRedirect("@origin");
}

export default { fetchRules, fetchRulesCold, redirect };
