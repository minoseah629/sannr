// Read-only Postman estate capture. The public surface is deliberately small:
// every operation is an allowlisted GET and credentials are accepted only via
// POSTMAN_API_KEY in the process environment.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { secretIn } from "./verdicts.mjs";
import { safeOutputPath, writeOutputFile } from './output-path.mjs';

const API_ROOT = "https://api.getpostman.com";
const DEFAULT_RETRIES = 2;
const DEFAULT_BUDGET = 100;

const ENDPOINTS = Object.freeze({
  me: () => "/me",
  workspaces: () => "/workspaces",
  workspace: (id) => `/workspaces/${segment(id)}`,
  collections: () => "/collections",
  collection: (id) => `/collections/${segment(id)}`,
  environments: () => "/environments",
  environment: (id) => `/environments/${segment(id)}`,
});

function segment(value) {
  if (typeof value !== "string" || !value || /[^A-Za-z0-9._~-]/.test(value)) {
    throw named("POSTMAN_PATH_REFUSED", "Postman resource identifiers must be a single safe path segment.");
  }
  return encodeURIComponent(value);
}

function named(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function refuseLiteralKey(value) {
  if (value !== undefined) throw named("POSTMAN_API_KEY_LITERAL_REFUSED",
    "Postman API key literal refused: use POSTMAN_API_KEY in .env; rotate the key if it was exposed on a command line.");
}

function parseJson(text, path) {
  try { return JSON.parse(text); }
  catch { throw named("POSTMAN_EMPTY_OR_INVALID_BODY", `Postman returned an empty or invalid JSON body for ${path}.`); }
}

export function createPostmanClient({ fetchImpl = globalThis.fetch, apiKey = undefined,
  baseUrl = API_ROOT, retries = DEFAULT_RETRIES, budget = DEFAULT_BUDGET,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  refuseLiteralKey(apiKey);
  if (typeof fetchImpl !== "function") throw named("POSTMAN_FETCH_UNAVAILABLE", "fetch is required to capture Postman.");
  const key = process.env.POSTMAN_API_KEY;
  if (!key) throw named("POSTMAN_API_KEY_MISSING", "POSTMAN_API_KEY is not set; source .env for the capture run.");
  let calls = 0;

  const allowed = (path) => /^\/(?:me|workspaces|collections|environments)(?:\/[A-Za-z0-9._~-]+)?$/.test(path);

  async function get(path) {
    if (!allowed(path)) {
      throw named("POSTMAN_ENDPOINT_REFUSED", `Postman endpoint is not an allowlisted GET: ${path}`);
    }
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (calls >= budget) throw named("POSTMAN_CALL_BUDGET_EXCEEDED", `Postman capture call budget (${budget}) exhausted.`, { calls, budget });
      calls += 1;
      const response = await fetchImpl(`${baseUrl}${path}`, { method: "GET", redirect: 'manual', headers: { "X-Api-Key": key, accept: "application/json" } });
      if (response.status >= 300 && response.status < 400)
        throw named('POSTMAN_REDIRECT_REFUSED', 'Postman capture does not follow credential-bearing redirects.');
      const text = await response.text();
      if (response.status === 429 || (!text.trim() && response.ok)) {
        if (attempt < retries) { await sleep(250 * 2 ** attempt); continue; }
        throw named("POSTMAN_PARTIAL_CAPTURE", `Postman capture exhausted retries for ${path}.`, { gap: path, status: response.status });
      }
      if (!response.ok) throw named("POSTMAN_REQUEST_FAILED", `Postman GET ${path} failed with status ${response.status}.`, { gap: path, status: response.status });
      return parseJson(text, path);
    }
  }
  return Object.freeze({
    get me() { return get(ENDPOINTS.me()); },
    get workspaces() { return get(ENDPOINTS.workspaces()); },
    workspace: (id) => get(ENDPOINTS.workspace(id)),
    get collections() { return get(ENDPOINTS.collections()); },
    collection: (id) => get(ENDPOINTS.collection(id)),
    get environments() { return get(ENDPOINTS.environments()); },
    environment: (id) => get(ENDPOINTS.environment(id)),
    stats: () => ({ calls, budget }),
  });
}

function scrub(value, counts, where = "capture", depth = 0) {
  if (depth > 64) throw named('POSTMAN_CAPTURE_OVERSIZED', 'Postman capture nesting exceeds its bound.');
  if (typeof value === "string") {
    const hit = secretIn(value);
    if (!hit) return value;
    counts.redactions += 1;
    counts.by_reason[hit] = (counts.by_reason[hit] ?? 0) + 1;
    return `[REDACTED:${hit}]`;
  }
  if (Array.isArray(value)) return value.map((v, i) => scrub(v, counts, `${where}[${i}]`, depth + 1));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (secretIn(key) || /^(?:password|passwd|secret|token|access_token|refresh_token|client_secret|api[_-]?key|authorization)$/i.test(key)) {
      counts.redactions++; counts.by_reason['credential field'] = (counts.by_reason['credential field'] ?? 0) + 1; continue;
    }
    Object.defineProperty(out, key, { enumerable: true, value: scrub(item, counts, where, depth + 1) });
  }
  return out;
}

export function scrubEnvironmentShape(environment, counts = { redactions: 0, by_reason: {} }) {
  const meta = environment?.environment && typeof environment.environment === "object" ? environment.environment : environment;
  const values = Array.isArray(meta?.values) ? meta.values : [];
  const { values: ignored, ...metadata } = meta ?? {};
  return { ...scrub(metadata, counts), values: values.map((entry) => scrub({
    key: typeof entry?.key === "string" ? entry.key : "",
    type: typeof entry?.type === "string" ? entry.type : "default",
    ...(entry?.enabled !== undefined ? { enabled: entry.enabled !== false } : {}),
  }, counts)) };
}

export function scrubCaptured(capture) {
  const counts = { redactions: 0, by_reason: {} };
  const environments = (capture.environments ?? []).map((e) => scrubEnvironmentShape(e, counts));
  const out = { ...scrub(capture, counts), environments };
  out.redactions = counts;
  return out;
}

export async function capturePostman({ outputDir = "../postman-corpus", account = "Postman account",
  date = new Date().toISOString().slice(0, 10), ...options } = {}) {
  const dir = resolve(outputDir);
  safeOutputPath(dir, { directory: true });
  for (const name of ['capture.json', 'README.md']) safeOutputPath(join(dir, name));
  const client = createPostmanClient(options);
  const me = await client.me;
  const workspacesResponse = await client.workspaces;
  const workspaceList = workspacesResponse?.workspaces ?? workspacesResponse?.data ?? [];
  const workspaces = [], collections = [], environments = [], collectionIds = new Set();
  for (const w of workspaceList) {
    const id = w?.id; if (!id) continue;
    workspaces.push(await client.workspace(id));
  }
  const listed = await client.collections;
  for (const c of (listed?.collections ?? listed?.data ?? [])) {
    const id = c?.uid ?? c?.id;
    if (id && !collectionIds.has(id)) { collectionIds.add(id); collections.push(await client.collection(id)); }
  }
  const envList = await client.environments;
  for (const e of (envList?.environments ?? envList?.data ?? [])) if (e?.uid || e?.id)
    environments.push(await client.environment(e.uid ?? e.id));
  const capture = scrubCaptured({ captured_at: date, account, me, workspaces, collections, environments });
  mkdirSync(dir, { recursive: true });
  writeOutputFile(join(dir, "capture.json"), `${JSON.stringify(capture, null, 2)}\n`, { mode: 0o600 });
  writeOutputFile(join(dir, "README.md"), `# Postman corpus\n\nCaptured account: ${capture.account}\nCaptured on: ${capture.captured_at}\nContents: workspace and collection JSON plus environment shapes (names, types, enabled flags only).\nRedactions: ${capture.redactions.redactions}; by reason: ${JSON.stringify(capture.redactions.by_reason)}\n`);
  return { dir, capture, calls: client.stats().calls };
}

export const postmanEndpoints = ENDPOINTS;
