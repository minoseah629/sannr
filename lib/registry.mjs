// THE CROSS-REPO REGISTRY — global understanding at the local level.
//
// One machine runs many repos, each with its own committed knowledge file.
// Until now each was an island: the agent in the storefront repo re-derives
// the billing API's gotchas that the billing repo already paid to learn. The
// registry is the machine-level index that ends that — WITHOUT becoming a
// second source of truth. It holds two things and only two things:
//
//   repos:  which repos on this machine are connected (name, root, dates)
//   grants: who may read whom — DIRECTIONAL and DEFAULT-DENY. A grant
//           {consumer, provider} means: an agent working in `consumer` may
//           read `provider`'s knowledge file. Nothing is mutual, nothing is
//           implied, nothing is granted by registration alone.
//
// The knowledge itself never moves. A cross-repo answer is read from the
// PROVIDER'S OWN FILE at query time, every time — no daemon, no cache, no
// sync. That is the design decision the whole feature hangs on: a revoked
// grant is dead on the next query, a provider's new learning is visible on
// the next query, and two sannr versions (or seven fleet generations) can
// disagree about everything except this file's schema and still cooperate.
//
// Where it lives: <global home>/registry.json. The home derives from the
// product name (~/.sannr) through the brand seam, and the HOME_ENV_NAME
// environment variable overrides it — that override is how the fleet
// harness gives every container and every generation an isolated world, and
// how two experiments on one machine stay out of each other's state.
//
// What it refuses to hold: values. No credentials, no base URLs, no bodies —
// those live where they always lived (env references, per-repo config). The
// registry stores names, absolute roots, and timestamps; the schema test
// pins exactly that and nothing more.
//
// Damage policy: a corrupt registry.json is EVIDENCE, not a casualty. Reads
// degrade to local-only (the primary path must survive), mutations refuse
// loudly with the path in hand, and nothing here ever overwrites a file it
// could not parse.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync,
         realpathSync, unlinkSync } from "node:fs";
import { join, dirname, basename, isAbsolute, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { GLOBAL_DIR_NAME, HOME_ENV_NAME } from "./brand.mjs";
import { loadContext } from "./context.mjs";

export const REGISTRY_VERSION = 1;
const REGISTRY_BASENAME = "registry.json";

/** The machine-global home: the env override wins (isolation for fleets,
 *  parallel experiments, and tests), else ~/.<product>. */
export function globalHome(env = process.env) {
  return env[HOME_ENV_NAME] || join(homedir(), GLOBAL_DIR_NAME);
}

export function registryPath(env = process.env) {
  return join(globalHome(env), REGISTRY_BASENAME);
}

export function emptyRegistry() {
  return { v: REGISTRY_VERSION, repos: {}, grants: [] };
}

/**
 * Structural soundness — the third damage state, after unparseable JSON and a
 * newer major (QA BUG-1). JSON.parse accepting a file says nothing about its
 * shape: grants-as-an-object, a null grant entry, a null repos value all
 * parsed clean and then detonated as TypeErrors inside whichever consumer
 * touched them first — doctor mid-report with its finished rows discarded,
 * grant mid-mutation. The gate lives here, in the one loader every consumer
 * shares, so doctor, grant, revoke, and crossLookup get uniform refusal from
 * one decision instead of four defensive copies.
 *
 * Sound means exactly:
 *   - v is a number ≤ REGISTRY_VERSION (checked by the caller, above this)
 *   - repos is a plain object whose every value is an object with a string root
 *   - grants is an array whose every entry is an object with string consumer
 *     and provider
 *
 * Anything else is REFUSED with the field named — never filtered, because a
 * later saveRegistry would then rewrite the file minus the evidence, and the
 * damage policy says the file IS evidence. (A sound registry whose grant
 * names an id with no repos entry stays ALLOWED: that is referential drift
 * the readers already skip — the separately-pinned observation — not shape
 * damage. Unknown EXTRA keys anywhere stay allowed too: same-major forward
 * compatibility, per the version comment below.)
 */
function shapeProblem(parsed) {
  if (typeof parsed.repos !== "object" || Array.isArray(parsed.repos))
    return "repos is not an object";
  for (const [id, r] of Object.entries(parsed.repos)) {
    if (!r || typeof r !== "object" || Array.isArray(r)) return `repos entry '${id}' is not an object`;
    if (typeof r.root !== "string") return `repos entry '${id}' has no string root`;
  }
  if (!Array.isArray(parsed.grants)) return "grants is not an array";
  for (const [i, g] of parsed.grants.entries()) {
    if (!g || typeof g !== "object" || Array.isArray(g)) return `grants[${i}] is not an object`;
    if (typeof g.consumer !== "string" || typeof g.provider !== "string")
      return `grants[${i}] has no string consumer and provider`;
  }
  return null;
}

/**
 * Read the registry, problems as data. Absent is not a problem — it is the
 * state of every machine before the first grant. Corrupt IS a problem, and
 * the caller decides its severity: `show` degrades to local-only, `grant`
 * refuses to write. Both get the same facts from here.
 */
export function loadRegistry(env = process.env) {
  const path = registryPath(env);
  if (!existsSync(path)) return { registry: emptyRegistry(), path, exists: false };
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (e) {
    return { registry: emptyRegistry(), path, exists: true,
      problem: { code: "REGISTRY_INVALID",
        message: `${path} is not valid JSON: ${String(e.message).slice(0, 120)}`,
        next: "Fix the syntax, or move the file aside to start a fresh registry. Nothing overwrites it while it is damaged." } };
  }
  // Same-major forward compatibility: unknown extra keys from a NEWER minor
  // are preserved by the read-modify-write cycle (we mutate, never rebuild),
  // but a higher major means a shape this version does not understand —
  // refuse to guess, for the same reason corrupt refuses.
  if (typeof parsed?.v !== "number" || parsed.v > REGISTRY_VERSION) {
    return { registry: emptyRegistry(), path, exists: true,
      problem: { code: "REGISTRY_INVALID",
        message: `${path} declares schema v${parsed?.v ?? "?"}; this install reads v${REGISTRY_VERSION}.`,
        next: "Upgrade this install, or move the file aside to start fresh." } };
  }
  // Absent sections are the one shape repair allowed, BEFORE the soundness
  // gate: null/missing means "none yet" (older writes), not damage.
  parsed.repos ??= {};
  parsed.grants ??= [];
  const unsound = shapeProblem(parsed);
  if (unsound) {
    return { registry: emptyRegistry(), path, exists: true,
      problem: { code: "REGISTRY_INVALID",
        message: `${path} is valid JSON with a damaged shape: ${unsound}.`,
        next: "Fix that field, or move the file aside to start a fresh registry. Nothing overwrites it while it is damaged." } };
  }
  return { registry: parsed, path, exists: true };
}

/**
 * Atomic write: temp file, then rename, so a crash mid-write leaves either
 * the old registry or the new one — never half a file (the corrupt-registry
 * policy above is for damage we did not cause; this is for not causing it).
 * Windows can refuse a rename onto an existing file; the fallback is a plain
 * write, which trades atomicity for correctness on the platform that lacks
 * the primitive rather than failing the command.
 */
export function saveRegistry(registry, env = process.env) {
  const path = registryPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify(registry, null, 2)}\n`;
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  writeFileSync(tmp, body, { flag: "wx", mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

/** realpath when the path exists (macOS /tmp is a symlink; identity must not
 *  depend on which spelling the caller used), resolve when it does not. */
const canonical = (p) => {
  try { return realpathSync(p); } catch { return resolve(p); }
};

/**
 * Register a repo root. Idempotent by canonical root: registering the same
 * repo twice refreshes `last_seen_at` and returns the SAME id, because grants
 * reference ids and a re-register that minted a new one would silently orphan
 * every grant the user made. Ids are opaque and random — a path is identity
 * enough until a repo moves, which this very workspace did last week.
 */
export function registerRepo(registry, root, { name } = {}) {
  const canon = canonical(root);
  const now = new Date().toISOString();
  const existing = Object.entries(registry.repos).find(([, r]) => r.root === canon);
  if (existing) {
    const [id, entry] = existing;
    entry.last_seen_at = now;
    if (name) entry.name = name;
    return { id, created: false };
  }
  let id;
  do { id = randomBytes(3).toString("hex"); } while (registry.repos[id]);
  registry.repos[id] = {
    name: name || basename(canon),
    root: canon,
    registered_at: now,
    last_seen_at: now,
  };
  return { id, created: true };
}

/**
 * Resolve a user-supplied reference to a registered repo: exact id, exact
 * name, or a path. Two repos may share a basename, so a name that matches
 * more than one is returned as { ambiguous } with the candidates — guessing
 * here would grant read access to the wrong repository.
 */
export function resolveRef(registry, ref, cwd = process.cwd()) {
  if (Object.hasOwn(registry.repos, ref)) return { id: ref };
  const looksLikePath = isAbsolute(ref) || ref.includes(sep) || ref.includes("/")
    || ref === "." || ref === ".." || existsSync(resolve(cwd, ref));
  if (looksLikePath) {
    const canon = canonical(isAbsolute(ref) ? ref : resolve(cwd, ref));
    const hit = Object.entries(registry.repos).find(([, r]) => r.root === canon);
    return hit ? { id: hit[0] } : { path: canon, unregistered: true };
  }
  const byName = Object.entries(registry.repos).filter(([, r]) => r.name === ref);
  if (byName.length === 1) return { id: byName[0][0] };
  if (byName.length > 1)
    return { ambiguous: byName.map(([id, r]) => ({ id, name: r.name, root: r.root })) };
  return null;
}

/** Grant: consumer may read provider. Directional, idempotent, never self. */
export function grant(registry, consumerId, providerId) {
  if (consumerId === providerId) return { changed: false, reason: "self" };
  if (allowed(registry, consumerId, providerId)) return { changed: false };
  registry.grants.push({ consumer: consumerId, provider: providerId,
    granted_at: new Date().toISOString() });
  return { changed: true };
}

export function revoke(registry, consumerId, providerId) {
  const before = registry.grants.length;
  registry.grants = registry.grants.filter(
    (g) => !(g.consumer === consumerId && g.provider === providerId));
  return { changed: registry.grants.length !== before };
}

export function allowed(registry, consumerId, providerId) {
  return registry.grants.some(
    (g) => g.consumer === consumerId && g.provider === providerId);
}

/** The providers a consumer may read, with their registry entries. */
export function providersFor(registry, consumerId) {
  return registry.grants
    .filter((g) => g.consumer === consumerId)
    .map((g) => ({ id: g.provider, ...registry.repos[g.provider] }))
    .filter((p) => p.root);
}

const normalizeRoute = (path) => {
  const trimmed = path.replace(/\/+$/u, "");
  return trimmed || "/";
};

const splitOperation = (operation) => {
  const space = operation.indexOf(" ");
  return space < 0
    ? { method: operation, path: "" }
    : { method: operation.slice(0, space), path: operation.slice(space + 1) };
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

// Provider keys use the same `{name}` path-template convention as
// `contextFor`, but the registry has to compare every provider before it can
// choose a winner. A route template consumes exactly one path segment and
// trailing slashes are deliberately insignificant.
const templatePattern = (path) => {
  const source = normalizeRoute(path).split("/").map((segment) =>
    /^\{[^{}]+\}$/u.test(segment) ? "[^/]+" : escapeRegExp(segment)).join("/");
  return new RegExp(`^${source}/?$`, "iu");
};

const matchRank = (key, wanted) => {
  const actual = splitOperation(key);
  const query = splitOperation(wanted);
  if (actual.method.toLowerCase() !== query.method.toLowerCase()) return null;

  if (normalizeRoute(actual.path).toLowerCase() === normalizeRoute(query.path).toLowerCase()) return 0;
  if (templatePattern(actual.path).test(query.path)) return 1;
  if (key.toLowerCase().includes(wanted.toLowerCase())) return 2;
  return null;
};

/**
 * The query-time cross-repo lookup — the one function `show` and the MCP
 * answer path share, so the CLI and the server can never disagree about what
 * a grant means. Given the CONSUMER's root and a wanted operation, read each
 * granted provider's knowledge file FRESH from disk and return the best match
 * with its provenance. Exact and template matches outrank loose substrings
 * across providers; grant order is the deterministic tiebreak within a match
 * class. Returns null when the consumer is unregistered, the registry is
 * damaged (local-only degradation), or no granted provider knows the operation.
 */
export function crossLookup(consumerRoot, wanted, env = process.env) {
  const { registry, problem } = loadRegistry(env);
  if (problem) return null;
  const canon = canonical(consumerRoot);
  const consumer = Object.entries(registry.repos).find(([, r]) => r.root === canon);
  if (!consumer) return null;
  let best = null;
  for (const [providerIndex, provider] of providersFor(registry, consumer[0]).entries()) {
    if (!existsSync(provider.root)) continue;      // vanished root: skipped, `repos` reports it
    const ctx = loadContext(provider.root);
    if (!ctx?.operations) continue;
    for (const [keyIndex, key] of Object.keys(ctx.operations).entries()) {
      const rank = matchRank(key, wanted);
      if (rank == null) continue;
      if (best && (rank > best.rank
        || (rank === best.rank && (providerIndex > best.providerIndex
          || (providerIndex === best.providerIndex && keyIndex >= best.keyIndex))))) continue;
      best = { rank, providerIndex, keyIndex, key, entry: ctx.operations[key], ctx,
        provider: { id: provider.id, name: provider.name, root: provider.root } };
    }
  }
  if (!best) return null;
  const { rank: _rank, providerIndex: _providerIndex, keyIndex: _keyIndex, ...hit } = best;
  return hit;
}
