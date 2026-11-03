// Every mutation is a pure function of (seed, source file, variation index).
// No third-party fuzzing package, clock, network, or Math.random is involved.
export const TEXT_CLASSES = Object.freeze([
  'unchanged', 'truncate', 'byte-substitution', 'line-duplicate', 'line-delete',
  'line-shuffle', 'bracket-swap', 'quote-swap', 'colon-swap', 'dash-swap',
  'document-marker', 'deep-flow', 'deep-block', 'deep-json', 'long-scalar',
  'long-number', 'nul', 'bom', 'crlf', 'unicode-lines', 'zero-width',
  'prototype-keys', 'anchor-chain', 'alias-expansion', 'matches', 'malformed-field',
]);
export const DIRECTORY_CLASSES = Object.freeze([
  'directory-baseline', 'missing-manifest', 'bru-name-directory', 'empty-file',
  'symlink-cycle', 'many-files',
]);
export function prng(seed, source, index) {
  let state = seed >>> 0;
  for (const char of `${source}\0${index}`) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = Math.imul(state ^ state >>> 15, state | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
export function vary(text, { seed, source, index, variation, entry }) {
  const random = prng(seed, source, index);
  const offset = (length) => Math.floor(random() * Math.max(1, length));
  const at = offset(text.length);
  const insert = (value) => text.slice(0, at) + value + text.slice(at);
  const lines = text.split('\n');
  const line = offset(lines.length);
  const swap = (pattern, replacement) => {
    const places = [...text.matchAll(pattern)];
    if (!places.length) return insert(replacement);
    const where = places[offset(places.length)].index;
    return text.slice(0, where) + replacement + text.slice(where + 1);
  };
  switch (variation) {
    case 'unchanged': return text;
    case 'truncate': return text.slice(0, at);
    case 'byte-substitution': {
      const bytes = Buffer.from(text);
      if (bytes.length) bytes[offset(bytes.length)] = offset(256);
      return bytes.toString('utf8');
    }
    case 'line-duplicate': lines.splice(line, 0, lines[line]); return lines.join('\n');
    case 'line-delete': lines.splice(line, 1); return lines.join('\n');
    case 'line-shuffle':
      for (let i = lines.length - 1; i > 0; i--) { const j = offset(i + 1); [lines[i], lines[j]] = [lines[j], lines[i]]; }
      return lines.join('\n');
    case 'bracket-swap': return swap(/[\[\]{}]/g, [']', '}', '[', '{'][offset(4)]);
    case 'quote-swap': return swap(/["']/g, random() < .5 ? '"' : "'");
    case 'colon-swap': return swap(/:/g, '-');
    case 'dash-swap': return swap(/-/g, ':');
    case 'document-marker': return `${text}\n---\nsecond: document\n...\n`;
    case 'deep-flow': return 'a: ' + '['.repeat(160) + '0' + ']'.repeat(160);
    case 'deep-block': return Array.from({ length: 160 }, (_, i) => '  '.repeat(i) + 'a:').join('\n') + '\n' + '  '.repeat(160) + '0\n';
    case 'deep-json': return '{"a":'.repeat(512) + '0' + '}'.repeat(512);
    case 'long-scalar': return insert('x'.repeat(128 * 1024));
    case 'long-number': return insert('9'.repeat(128 * 1024));
    case 'nul': return insert('\0');
    case 'bom': return '\uFEFF' + text;
    case 'crlf': return text.replace(/\r?\n/g, '\r\n');
    case 'unicode-lines': return text.replace(/\n/g, random() < .5 ? '\u2028' : '\u2029');
    case 'zero-width': return insert('\u200B\u200C\u200D');
    case 'prototype-keys': return '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"item":[]}';
    case 'anchor-chain': return 'a0: &a0 [leaf]\n' + Array.from({ length: 160 }, (_, i) => `a${i + 1}: &a${i + 1} [*a${i}]`).join('\n');
    case 'alias-expansion': return 'a0: &a0 [leaf]\n' + Array.from({ length: 24 }, (_, i) => `a${i + 1}: &a${i + 1} [*a${i}, *a${i}]`).join('\n');
    case 'malformed-field': {
      let parsed;
      try { parsed = JSON.parse(text); } catch { return text + '\nitem: {request: null}\n'; }
      if (entry === 'importInsomnia') parsed.resources = { malformed: true };
      else if (entry === 'importKong') parsed.services = [{ routes: [null] }];
      else parsed.variable = { malformed: true };
      return JSON.stringify(parsed);
    }
    case 'matches': {
      const pattern = ['(a+)+$', '(a|aa)+$', 'a'.repeat(201)][offset(3)];
      if (entry === 'importBruno') return text + `\nassert {\n  res.body: matches ${pattern}\n}\n`;
      let parsed;
      try { parsed = JSON.parse(text); } catch { return text + `\nmatches: "${pattern}"\n`; }
      if (entry === 'importPostman') parsed.item = [{ name: 'matches', request: { method: 'GET', url: '/health' }, event: [{ listen: 'test', script: { exec: [`pm.expect(pm.response.headers.get("etag")).to.include(${JSON.stringify(pattern)});`] } }] }];
      else parsed.matches = pattern;
      return JSON.stringify(parsed);
    }
    default: throw new Error(`Unknown robustness variation: ${variation}`);
  }
}
