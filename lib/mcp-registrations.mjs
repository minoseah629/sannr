// Project registrations are launch instructions, never promoted evidence. Only
// registration keys/host paths and fixed diagnostic text may enter reports.
import { accessSync, closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { isObject, safeMcpValue } from './mcp-facts.mjs';

export const MAX_MCP_REGISTRATIONS = 100;
const MAX_CONFIG_BYTES = 1024 * 1024;
const HOSTS = [
  { host: 'claude-code', file: '.mcp.json', container: 'mcpServers' },
  { host: 'codex', file: '.codex/config.toml', container: 'mcp_servers' },
  { host: 'cursor', file: '.cursor/mcp.json', container: 'mcpServers' },
  { host: 'vscode', file: '.vscode/mcp.json', container: 'servers' },
];
export const MCP_REGISTRATION_FILES = HOSTS.map(host => host.file);
const invalid = () => { throw new Error('unsupported or malformed registration config'); };

function readConfig(path) {
  let descriptor;
  const oversized = () => { throw Object.assign(new Error('registration file exceeds 1 MB'), { code: 'MCP_REGISTRATION_LIMIT' }); };
  try {
    // O_NONBLOCK avoids waiting for a writer when a registration path names a
    // FIFO. Inspect the opened descriptor so path replacement cannot switch a
    // checked regular file into a device before reading.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) invalid();
    if (stat.size > MAX_CONFIG_BYTES) oversized();
    // The extra byte detects growth after fstat without an unbounded read.
    const bytes = Buffer.allocUnsafe(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_CONFIG_BYTES) oversized();
    return bytes.toString('utf8', 0, length);
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

// JSONC is a VS Code project format. Strip comments and trailing commas only
// outside strings; never reinterpret registered command/argument/env bytes.
function jsonConfig(text, comments) {
  if (!comments) return JSON.parse(text);
  let output = '', quote = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      output += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quote = false;
    } else if (c === '"') { quote = true; output += c; }
    else if (text.slice(i, i + 2) === '//') {
      const end = text.indexOf('\n', i + 2); i = end < 0 ? text.length : end; output += '\n';
    } else if (text.slice(i, i + 2) === '/*') {
      const end = text.indexOf('*/', i + 2); if (end < 0) invalid(); i = end + 1; output += ' ';
    } else output += c;
  }
  let clean = ''; quote = false; escaped = false;
  for (let i = 0; i < output.length; i++) {
    const c = output[i];
    if (quote) {
      clean += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quote = false;
    } else if (c === '"') { quote = true; clean += c; }
    else if (c !== ',' || !/^\s*[}\]]/.test(output.slice(i + 1))) clean += c;
  }
  return JSON.parse(clean);
}

// Bounded TOML reader for registration tables, dotted/quoted keys, arrays,
// inline env tables, and ordinary surrounding Codex settings. Unsupported
// syntax becomes a named config gap; it is never a guessed launch command.
function tomlConfig(text) {
  let i = 0, nodes = 0;
  const root = Object.create(null);
  const inlineTables = new WeakSet();
  const sealInline = table => { inlineTables.add(table); for (const value of Object.values(table)) if (isObject(value)) sealInline(value); };
  const count = depth => { if (++nodes > 20_000 || depth > 32) invalid(); };
  const ws = () => {
    for (;;) {
      while (/\s/.test(text[i] ?? '') && i < text.length) i++;
      if (text[i] !== '#') return;
      while (i < text.length && text[i] !== '\n') i++;
    }
  };
  function string() {
    const quote = text[i++], multiline = text.slice(i, i + 2) === quote.repeat(2);
    if (multiline) { i += 2; if (text[i] === '\r') i++; if (text[i] === '\n') i++; }
    let value = '';
    while (i < text.length) {
      if (text[i] === quote && (!multiline || text.slice(i, i + 3) === quote.repeat(3))) { i += multiline ? 3 : 1; return value; }
      const c = text[i++];
      if (!multiline && /[\r\n]/.test(c)) invalid();
      if (quote === "'" || c !== '\\') { value += c; continue; }
      const escape = text[i++];
      if (multiline && /\s/.test(escape)) { while (i < text.length && /\s/.test(text[i])) i++; continue; }
      const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
      if (Object.hasOwn(simple, escape)) value += simple[escape];
      else if (escape === 'u' || escape === 'U') {
        const length = escape === 'u' ? 4 : 8, hex = text.slice(i, i + length);
        if (hex.length !== length || !/^[a-f\d]+$/i.test(hex)) invalid();
        const code = parseInt(hex, 16); if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) invalid();
        value += String.fromCodePoint(code); i += length;
      } else invalid();
    }
    invalid();
  }
  function keys() {
    const parts = [];
    for (;;) {
      while (/[ \t]/.test(text[i] ?? '') && i < text.length) i++;
      if (text[i] === '"' || text[i] === "'") parts.push(string());
      else { const match = /^[\w-]+/.exec(text.slice(i)); if (!match) invalid(); parts.push(match[0]); i += match[0].length; }
      while (/[ \t]/.test(text[i] ?? '') && i < text.length) i++;
      if (parts.length > 32) invalid();
      if (text[i] !== '.') return parts;
      i++;
    }
  }
  function set(target, path, value) {
    for (const key of path.slice(0, -1)) {
      if (inlineTables.has(target)) invalid();
      if (!Object.hasOwn(target, key)) target[key] = Object.create(null);
      if (!isObject(target[key])) invalid();
      target = target[key];
    }
    if (inlineTables.has(target)) invalid();
    const key = path.at(-1); if (Object.hasOwn(target, key)) invalid(); target[key] = value;
  }
  function value(depth = 0) {
    count(depth); ws();
    if (text[i] === '"' || text[i] === "'") return string();
    if (text[i] === '[') {
      i++; const result = []; ws();
      while (text[i] !== ']') { result.push(value(depth + 1)); ws(); if (text[i] === ']') break; if (text[i++] !== ',') invalid(); ws(); }
      i++; return result;
    }
    if (text[i] === '{') {
      i++; const result = Object.create(null); ws();
      while (text[i] !== '}') { const path = keys(); if (text[i++] !== '=') invalid(); set(result, path, value(depth + 1)); ws(); if (text[i] === '}') break; if (text[i++] !== ',') invalid(); ws(); }
      i++; sealInline(result); return result;
    }
    const match = /^[^\s,#\]}]+/.exec(text.slice(i)); if (!match) invalid(); i += match[0].length;
    if (match[0] === 'true' || match[0] === 'false') return match[0] === 'true';
    const token = match[0];
    const decimal = /^[+-]?(?:0|[1-9](?:_?\d)*)$/;
    const float = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*(?:[eE][+-]?\d(?:_?\d)*)?|[eE][+-]?\d(?:_?\d)*)$/;
    const based = /^(?:0x[\da-fA-F](?:_?[\da-fA-F])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*)$/;
    if (decimal.test(token) || float.test(token) || based.test(token)) return Number(token.replaceAll('_', ''));
    // Dates and special floats can occur in unrelated host settings.
    if (/^[\d]{4}-\d\d-\d\d(?:[Tt].*)?$/.test(match[0]) || /^[+-]?(?:inf|nan)$/.test(match[0])) return null;
    invalid();
  }
  let table = root;
  const tables = new Set();
  while (i < text.length) {
    ws(); if (i >= text.length) break;
    if (text[i] === '[') {
      i++; const array = text[i] === '['; if (array) i++;
      const path = keys(); if (text[i++] !== ']' || (array && text[i++] !== ']')) invalid();
      table = root;
      for (const [index, key] of path.entries()) {
        if (!Object.hasOwn(table, key)) table[key] = array && index === path.length - 1 ? [] : Object.create(null);
        if (Array.isArray(table[key])) {
          if (array && index === path.length - 1) table[key].push(Object.create(null));
          table = table[key].at(-1);
        } else table = table[key];
        if (!isObject(table) || inlineTables.has(table)) invalid();
      }
      const identity = JSON.stringify(path);
      if (!array && tables.has(identity)) invalid(); if (!array) tables.add(identity);
    } else {
      const path = keys(); if (text[i++] !== '=') invalid(); set(table, path, value());
    }
    while (/[ \t\r]/.test(text[i] ?? '') && i < text.length) i++;
    if (text[i] === '#') while (i < text.length && text[i] !== '\n') i++;
    if (i < text.length && text[i++] !== '\n') invalid();
  }
  return root;
}

function resolves(command, cwd, env) {
  const executable = candidate => { try { accessSync(candidate, constants.X_OK); return statSync(candidate).isFile(); } catch { return false; } };
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) return executable(resolve(cwd, command));
  return (env.PATH ?? process.env.PATH ?? '/usr/bin:/bin').split(delimiter).some(path => executable(resolve(cwd, path || '.', command)));
}
const gap = (base, code, reason) => ({ ...base, code, reason });

export function discoverMcpRegistrations(root, { only } = {}) {
  const rows = [];
  for (const host of HOSTS) {
    const base = { key: host.file, host: host.host, file: host.file };
    let config;
    try {
      const raw = readConfig(join(root, host.file));
      config = host.host === 'codex' ? tomlConfig(raw) : jsonConfig(raw, host.host === 'vscode');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      if (error.code === 'MCP_REGISTRATION_LIMIT') { rows.push(gap(base, error.code, 'registration file exceeds 1 MB')); continue; }
      rows.push(gap(base, 'MCP_REGISTRATION_CONFIG_INVALID', 'registration file could not be read or parsed')); continue;
    }
    if (!isObject(config) || (config[host.container] !== undefined && !isObject(config[host.container]))) {
      rows.push(gap(base, 'MCP_REGISTRATION_CONFIG_INVALID', 'registration container must be an object')); continue;
    }
    const registrations = Object.entries(config[host.container] ?? {});
    if (registrations.length > MAX_MCP_REGISTRATIONS) {
      rows.push(gap(base, 'MCP_REGISTRATION_LIMIT', `registration file exceeds ${MAX_MCP_REGISTRATIONS} servers`)); continue;
    }
    for (const [key, entry] of registrations) {
      if (only !== undefined && key !== only) continue;
      const named = { ...base, key };
      try { if (!key || key.length > 200 || safeMcpValue(key) !== key) throw new Error(); }
      catch { rows.push(gap({ ...base, key: '[withheld registration key]' }, 'MCP_REGISTRATION_KEY_INVALID', 'registration key is empty, secret-shaped, contains controls, or exceeds 200 characters')); continue; }
      if (isObject(entry) && (entry.enabled === false || entry.disabled === true)) {
        rows.push(gap(named, 'MCP_REGISTRATION_DISABLED', 'registration is disabled in the project host configuration')); continue;
      }
      if (!isObject(entry) || typeof entry.command !== 'string' || !entry.command || (entry.type !== undefined && entry.type !== 'stdio') || entry.url !== undefined) {
        rows.push(gap(named, 'MCP_REGISTRATION_UNSUPPORTED', 'registration does not declare a supported stdio command')); continue;
      }
      if ((entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.length > 100 || entry.args.some(arg => typeof arg !== 'string'))) ||
          (entry.env !== undefined && (!isObject(entry.env) || Object.keys(entry.env).length > 100 || Object.entries(entry.env).some(([key, value]) => !key || key.includes('=') || typeof value !== 'string'))) ||
          (entry.cwd !== undefined && typeof entry.cwd !== 'string')) {
        rows.push(gap(named, 'MCP_REGISTRATION_INVALID', 'registration args, env, or cwd have an unsupported shape')); continue;
      }
      const cwd = resolve(root, entry.cwd ?? '.'), env = entry.env ?? {};
      if (!resolves(entry.command, cwd, env)) { rows.push(gap(named, 'MCP_COMMAND_NOT_FOUND', 'registered command does not resolve to an executable')); continue; }
      rows.push({ ...named, command: entry.command, args: entry.args ?? [], env, cwd });
    }
  }
  if (only !== undefined && !rows.some(row => row.key === only)) rows.push(gap({ key: only, host: 'project', file: null }, 'MCP_REGISTRATION_NOT_FOUND', 'no matching project registration'));
  return rows;
}
