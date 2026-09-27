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

const MAX_PATH_LENGTH = 2048;

function isPathChar(code) {
  return code > 0x1f && code !== 0x7f && code !== 0x5c;
}

function isSegmentChar(code) {
  return code !== 0x2f && isPathChar(code);
}

function tokenize(from) {
  const tokens = [];
  let literal = "";
  let i = 0;
  while (i < from.length) {
    if (from[i] !== "*") {
      literal += from[i];
      i++;
      continue;
    }
    if (literal) tokens.push({ kind: "literal", text: literal });
    literal = "";
    const many = from[i + 1] === "*";
    tokens.push({ kind: many ? "many" : "one" });
    i += many ? 2 : 1;
  }
  if (literal) tokens.push({ kind: "literal", text: literal });
  return tokens;
}

function matchFrom(from, path) {
  if (from === "/") return path === "/" ? [] : null;
  const tokens = tokenize(from);
  if (tokens[0].kind === "literal" && !path.startsWith(tokens[0].text)) return null;
  const n = path.length;
  const segmentRun = new Int32Array(n + 2);
  const pathRun = new Int32Array(n + 2);
  for (let p = n - 1; p >= 0; p--) {
    const code = path.charCodeAt(p);
    segmentRun[p] = isSegmentChar(code) ? segmentRun[p + 1] + 1 : 0;
    pathRun[p] = isPathChar(code) ? pathRun[p + 1] + 1 : 0;
  }
  const reach = [];
  for (let t = 0; t <= tokens.length; t++) reach.push(new Uint8Array(n + 2));
  const end = reach[tokens.length];
  end[n] = 1;
  if (n > 0 && path.charCodeAt(n - 1) === 0x2f) end[n - 1] = 1;
  const nearest = new Int32Array(n + 3);
  for (let t = tokens.length - 1; t >= 0; t--) {
    const token = tokens[t];
    const next = reach[t + 1];
    const here = reach[t];
    if (token.kind === "literal") {
      const len = token.text.length;
      for (let p = 0; p + len <= n; p++) here[p] = next[p + len] === 1 && path.startsWith(token.text, p) ? 1 : 0;
      continue;
    }
    nearest[n + 1] = n + 1;
    nearest[n + 2] = n + 2;
    for (let q = n; q >= 0; q--) nearest[q] = next[q] === 1 ? q : nearest[q + 1];
    for (let p = 0; p < n; p++) {
      if (segmentRun[p] === 0) continue;
      const furthest = token.kind === "one" ? p + segmentRun[p] : p + 1 + pathRun[p + 1];
      here[p] = nearest[p + 1] <= furthest ? 1 : 0;
    }
  }
  if (reach[0][0] !== 1) return null;
  const captures = [];
  let p = 0;
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t];
    const next = reach[t + 1];
    if (token.kind === "literal") {
      p += token.text.length;
      continue;
    }
    let q;
    if (token.kind === "one") {
      q = p + segmentRun[p];
      while (next[q] !== 1) q--;
    } else {
      q = p + 1;
      while (next[q] !== 1) q++;
    }
    captures.push(path.slice(p, q));
    p = q;
  }
  return captures;
}

function redirect(r) {
  const raw = dict().get("rules");
  if (!raw) {
    r.internalRedirect("@origin");
    return;
  }
  const path = r.uri;
  if (path.length > MAX_PATH_LENGTH) {
    r.internalRedirect("@origin");
    return;
  }
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
    const m = matchFrom(rule.from, path);
    if (!m) continue;
    const target = rule.target.replace(/\$(\d+)/g, (_, n) => m[Number(n) - 1] || "");
    r.return(rule.status, target);
    return;
  }
  r.internalRedirect("@origin");
}

export default { fetchRules, fetchRulesCold, redirect };
