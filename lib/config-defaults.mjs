// Pure defaults resolution shared by legacy configuration and stack scopes.
import { LAYOUT } from "./layout.mjs";

export const BUILTIN_DEFAULTS = {
  budget: 800,        // API_BUDGET      — max envelope tokens
  timeoutMs: 30_000,  // API_TIMEOUT_MS  — per-request timeout
  concurrency: 1,     // API_CONCURRENCY — starting lane width
  evidenceDir: LAYOUT.evidence, // API_EVIDENCE — where full request/response pairs land
  staleDays: 180,     // API_STALE_DAYS  — confirmation-age horizon
};

// The env-var name that overrides each default. Kept beside BUILTIN_DEFAULTS so
// a new default cannot be added without declaring how it is overridden.
const DEFAULT_ENV = {
  budget: "API_BUDGET", timeoutMs: "API_TIMEOUT_MS", concurrency: "API_CONCURRENCY",
  evidenceDir: "API_EVIDENCE", staleDays: "API_STALE_DAYS",
};

// THREE-level precedence: an explicit environment variable beats the config
// file's `defaults` block beats the built-in. This is the rule that lets an
// existing env-only setup keep working untouched — its env vars still win —
// while a stranger who has exported nothing gets sane project defaults from a
// file they can read. A junk value at any level falls THROUGH to the next
// rather than poisoning the client (a non-numeric budget would become NaN,
// which silently defeats the token cap the same way NaN concurrency defeats
// the lane limiter).
export function resolveDefaults(fileDefaults) {
  const file = fileDefaults && typeof fileDefaults === "object" ? fileDefaults : {};
  const num = (key) => {
    const fromEnv = Number(process.env[DEFAULT_ENV[key]]);
    if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
    const fromFile = Number(file[key]);
    if (Number.isFinite(fromFile) && fromFile > 0) return fromFile;
    return BUILTIN_DEFAULTS[key];
  };
  const str = (key) => {
    const fromEnv = process.env[DEFAULT_ENV[key]];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
    if (typeof file[key] === "string" && file[key] !== "") return file[key];
    return BUILTIN_DEFAULTS[key];
  };
  return {
    budget: num("budget"), timeoutMs: num("timeoutMs"), concurrency: num("concurrency"),
    evidenceDir: str("evidenceDir"), staleDays: num("staleDays"),
  };
}

