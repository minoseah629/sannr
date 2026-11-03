// Credential references are syntax, never credential values. This module must
// never read process.env: parsing and metadata safety use the same grammar.
const ENV = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const PROSE_ENV = /^[A-Z_][A-Z0-9_]{0,127}$/;
const HEADER = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const QUERY = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

export function parseAuthReference(spec, { prose = false } = {}) {
  if (typeof spec !== 'string' || !spec || spec.length > 400) return null;
  const parts = spec.split(':');
  const [scheme, a, b] = parts;
  const env = prose ? PROSE_ENV : ENV;
  if (scheme === 'bearer' && parts.length === 2 && env.test(a)) return { scheme, envVar: a };
  if (scheme === 'header' && parts.length === 3 && HEADER.test(a) && env.test(b)) return { scheme, name: a, envVar: b };
  if (scheme === 'query' && parts.length === 3 && QUERY.test(a) && env.test(b)) return { scheme, param: a, envVar: b };
  if (scheme === 'oauth' && parts.length === 3 && env.test(a) && env.test(b)) return { scheme, clientIdEnv: a, clientSecretEnv: b };
  if (scheme === 'basic' && parts.length === 3 && env.test(a) && env.test(b)) return { scheme, usernameEnv: a, passwordEnv: b };
  return null;
}

// RFC 7617 separates the user-id with the first colon and forbids RFC 5234
// controls in either component. Password colons are ordinary password bytes.
// Encoding is explicit UTF-8 at dispatch; validation never reads an env var.
export function basicAuthValueProblem(username, password) {
  if (/[:\x00-\x1f\x7f]/.test(username)) return 'Basic usernames cannot contain a colon or control characters.';
  if (/[\x00-\x1f\x7f]/.test(password)) return 'Basic passwords cannot contain control characters.';
  return null;
}

// Only complete, bounded tokens are reference candidates. Prose punctuation
// after the token is allowed; URL/path prefixes and value suffixes are not.
// Invalid candidates are retained so the caller cannot accept a malformed
// header reference merely because its header name evades a credential regex.
export function proseAuthReferences(text) {
  const tokens = /(?<![A-Za-z0-9_:/=@.%+\\?&#\-])(?:bearer|header|query|oauth|basic):[^\s<>()[\]{},;"`]+/g;
  return [...text.matchAll(tokens)].map(match => {
    const token = match[0].replace(/[.'!?]+$/, '');
    return { start: match.index, end: match.index + token.length, reference: parseAuthReference(token, { prose: true }) };
  });
}
