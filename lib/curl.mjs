// Parse a pasted curl command, deterministically.
//
// The alternative is letting the model translate, and that fails three ways:
// it can split host from path wrongly and hit the wrong environment, it can
// carry a literal credential into the agent's context and our evidence files,
// and it can silently drop a flag it did not recognise. A parser cannot
// improvise, and it can refuse.
//
// Two rules this file exists to enforce:
//   1. Never silently drop a flag. Anything unhandled is REPORTED.
//   2. Never carry a literal credential. Refuse, name it, and say what to do.

// Secrets are supplied by environment reference. A literal one in a pasted curl
// is already in the agent's context; the least we can do is not persist it.
// Exported because saved suites (lib/suites.mjs) guard the same door — a
// committed request file is a pasted curl that lives forever — and two copies
// of a credential list drift, which is how the note/verdict guard nearly split.
export const SECRET_HEADERS = /^(authorization|proxy-authorization|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-session-token|cookie)$/i;
// A fixed denylist cannot enumerate every custom auth header an agent might
// paste (X-Vault-Token, X-Company-Secret). A header whose last segment is
// token/secret/password is almost always a credential; -key is deliberately NOT
// here, because Idempotency-Key and X-Request-Key are ordinary headers.
export const CREDENTIAL_SHAPED_HEADER = /(^|[-_])(token|secret|password|passwd)$/i;
export const SECRET_PARAMS = /^(api_?key|access_?token|auth_?token|refresh_?token|id_?token|client_?secret|token|secret|password|signature|sig|private_?key)$/i;

// Flags we understand but that carry no request semantics: accepting them
// silently is correct, because ignoring them changes nothing about the request.
const BENIGN = new Set(["-s", "--silent", "-S", "--show-error", "-v", "--verbose", "-i", "--include",
  "-k", "--insecure", "--compressed", "-L", "--location", "-f", "--fail", "-#", "--progress-bar",
  "--no-progress-meter", "-N", "--no-buffer", "-4", "-6", "--http1.1", "--http2"]);

// Shell-aware tokenizer: quotes, escapes, and line continuations.
export function tokenize(command) {
  const out = [];
  let cur = "", quote = null, started = false;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < command.length) { cur += command[++i]; continue; }
      if (c === quote) { quote = null; continue; }
      cur += c; continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (c === "\\" && command[i + 1] === "\n") { i += 1; continue; }
    if (c === "\\" && command[i + 1] === "\r") { i += 2; continue; }
    if (/\s/.test(c)) { if (cur || started) { out.push(cur); cur = ""; started = false; } continue; }
    cur += c;
  }
  if (cur || started) out.push(cur);
  return out;
}

/**
 * @returns {{request?: object, origin?: string, warnings: string[], error?: object}}
 */
export function parseCurl(command) {
  const t = tokenize(String(command).trim());
  if (!t.length || !/^curl$/i.test(t[0]))
    return { warnings: [], error: { code: "NOT_A_CURL_COMMAND",
      message: "The command does not begin with `curl`.",
      next: "Paste the command exactly as it would run in a shell." } };

  const req = { method: null, headers: {}, params: {}, body: undefined, body_type: undefined, files: {} };
  const warnings = [];
  const dataParts = [];
  const formParts = [];
  let urlRaw = null, getWithData = false;

  // curl bundles short flags: -sS, -fsSL, -sLo file. Expanding them first is the
  // difference between parsing `curl -fsSL https://…` — one of the most-copied
  // command forms there is — and reporting three flags as unsupported.
  const expanded = [];
  for (const raw of t.slice(1)) {
    if (/^-[a-zA-Z]{2,}$/.test(raw)) for (const ch of raw.slice(1)) expanded.push(`-${ch}`);
    else expanded.push(raw);
  }

  for (let i = 0; i < expanded.length; i += 1) {
    const a = expanded[i];
    const next = () => expanded[++i];
    if (BENIGN.has(a)) continue;

    if (a === "-X" || a === "--request") { req.method = next()?.toUpperCase(); continue; }
    if (a === "--url") { urlRaw = next(); continue; }
    if (a === "-G" || a === "--get") { getWithData = true; continue; }

    if (a === "-H" || a === "--header") {
      const raw = next() ?? "";
      const idx = raw.indexOf(":");
      if (idx < 1) { warnings.push(`ignored malformed header: ${raw.slice(0, 40)}`); continue; }
      const headerName = raw.slice(0, idx).trim();
      if (headerName === "__proto__" || headerName === "constructor") {
        warnings.push(`ignored prototype-shaped header: ${headerName}`);
        continue;
      }
      req.headers[headerName] = raw.slice(idx + 1).trim();
      continue;
    }
    if (a === "-A" || a === "--user-agent") { req.headers["user-agent"] = next(); continue; }
    if (a === "-e" || a === "--referer") { req.headers.referer = next(); continue; }
    if (a === "-b" || a === "--cookie") { req.headers.cookie = next(); continue; }
    if (a === "-u" || a === "--user") {
      // Basic auth with a literal credential; treated as a secret below.
      req.headers.authorization = `Basic ${Buffer.from(next() ?? "").toString("base64")}`;
      continue;
    }

    if (a === "-d" || a === "--data" || a === "--data-raw" || a === "--data-binary" || a === "--data-ascii") {
      dataParts.push(next() ?? ""); continue;
    }
    if (a === "--data-urlencode") { dataParts.push(next() ?? ""); req.body_type = "form"; continue; }
    if (a === "-F" || a === "--form") {
      const raw = next() ?? "";
      const eq = raw.indexOf("=");
      if (eq < 1) { warnings.push(`ignored malformed --form: ${raw.slice(0, 40)}`); continue; }
      const [k, v] = [raw.slice(0, eq), raw.slice(eq + 1)];
      if (v.startsWith("@")) req.files[k] = v.slice(1);
      else formParts.push([k, v]);
      req.body_type = "multipart";
      continue;
    }

    if (a.startsWith("-")) {
      // Never silently drop. An unrecognised flag may change the request.
      warnings.push(`unsupported flag ignored: ${a}`);
      if (i + 1 < expanded.length && !expanded[i + 1].startsWith("-") && !/^https?:/i.test(expanded[i + 1])) i += 1;
      continue;
    }
    if (!urlRaw) urlRaw = a; else warnings.push(`ignored extra argument: ${a.slice(0, 40)}`);
  }

  if (!urlRaw)
    return { warnings, error: { code: "CURL_HAS_NO_URL", message: "No URL found in the command.",
      next: "Include the URL, e.g. curl 'https://api.example.test/things'." } };

  let url;
  try { url = new URL(urlRaw); }
  catch { return { warnings, error: { code: "CURL_URL_INVALID",
    message: `'${urlRaw.slice(0, 80)}' is not an absolute URL.`,
    next: "Use the full URL including scheme and host." } }; }

  // --- refuse literal credentials -----------------------------------------
  const secretHeaders = Object.keys(req.headers)
    .filter((h) => SECRET_HEADERS.test(h) || CREDENTIAL_SHAPED_HEADER.test(h));
  // A -G request merges its --data into the query string; those keys must be
  // checked too, or `curl -G --data 'api_key=…'` bypasses a refusal that the
  // identical `?api_key=…` triggers.
  const gDataKeys = getWithData ? [...new URLSearchParams(dataParts.join("&")).keys()] : [];
  const secretParams = [...url.searchParams.keys(), ...gDataKeys].filter((k) => SECRET_PARAMS.test(k));
  // A credential in the URL userinfo (https://user:pass@host) was dropped
  // silently — violating both rules this parser exists for: it neither refused
  // nor warned, it just vanished.
  const userinfo = url.username || url.password ? ["the URL userinfo (user:password@)"] : [];
  if (secretHeaders.length || secretParams.length || userinfo.length) {
    return { warnings, error: {
      kind: "policy", code: "CREDENTIAL_IN_CURL",
      message: `The pasted command carries a literal credential in ${
        [...secretHeaders.map((h) => `header '${h}'`), ...secretParams.map((p) => `query parameter '${p}'`), ...userinfo].join(", ")
      }. It was not sent and has not been written to evidence.`,
      details: { headers: secretHeaders, params: secretParams, userinfo: userinfo.length > 0 },
      next: "Remove it from the command and configure it once as an environment reference, e.g. " +
            "API_AUTH=header:X-API-Key:MY_KEY with the value in an env file. Treat the pasted value as " +
            "exposed — it is already in this conversation — and rotate it.",
    } };
  }

  for (const [k, v] of url.searchParams) req.params[k] = v;

  // --- body ----------------------------------------------------------------
  if (dataParts.length) {
    const joined = dataParts.join("&");
    if (getWithData) {
      for (const [k, v] of new URLSearchParams(joined)) req.params[k] = v;
    } else if (req.body_type === "form" || /^[^{[]/.test(joined.trim()) && joined.includes("=")) {
      req.body_type = "form";
      req.body = Object.fromEntries(new URLSearchParams(joined));
    } else {
      try { req.body = JSON.parse(joined); }
      catch { req.body = joined; warnings.push("body is not valid JSON and was sent verbatim"); }
    }
  }
  if (formParts.length) req.body = Object.fromEntries(formParts);
  if (!Object.keys(req.files).length) delete req.files;
  if (!Object.keys(req.params).length) delete req.params;

  // curl infers POST from a body; make it explicit rather than implicit.
  req.method = req.method ?? (req.body !== undefined || req.files ? "POST" : "GET");

  // content-type is implied by body_type; carrying it duplicates the decision.
  for (const h of Object.keys(req.headers))
    if (h.toLowerCase() === "content-type") delete req.headers[h];
  if (!Object.keys(req.headers).length) delete req.headers;

  return { request: { ...req, path: url.pathname }, origin: url.origin, warnings };
}
