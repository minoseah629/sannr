import { currentStackScope } from './stack-scope.mjs';
import { LAYOUT } from './layout.mjs';
import { projectConfigRoot } from './config.mjs';
// Setup may turn one local contract discovery into an explicit environment
// binding. Request execution itself never guesses a contract from nearby files.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";

export const CONTRACT_CANDIDATES = [
  "openapi.json", "openapi.yaml", "openapi.yml",
  "swagger.json", "swagger.yaml", "docs/openapi.yaml", "api/openapi.yaml",
];

export function planSetupContract(root, cfg, { env = process.env, contextContract, selectedContract } = {}) {
  const unchanged = (contract, reason) => ({ contract,
    report: { action: "unchanged", environment: cfg.name ?? null, reason } });
  if (currentStackScope()) return unchanged(selectedContract ?? cfg.contract ?? null, 'explicit stack contract');
  // Shell overrides describe this invocation, not a change to the team's
  // selected environment. In particular an overridden URL cannot inherit the
  // configured URL's contract through the generated MCP registration.
  if (!selectedContract && env.API_CONTRACT !== undefined)
    return unchanged(env.API_CONTRACT ? resolve(root, env.API_CONTRACT) : "", "API_CONTRACT override; project binding preserved");
  if (cfg.baseUrlOverride || cfg.baseUrlSource === "env")
    return unchanged(selectedContract ?? null, "API_BASE_URL override requires its own explicit API_CONTRACT");
  if (!selectedContract && cfg.contract) return unchanged(resolve(root, cfg.contract), "explicit environment contract");
  const configured = cfg.file && cfg.name && cfg.baseUrlSource === "config";
  if (!configured && (selectedContract || contextContract))
    // An earlier explicit setup selection remains useful for offline context
    // and MCP wiring even before an environment URL exists. Keep the path
    // (including a missing one) so setup diagnoses it instead of rediscovering
    // or silently clearing it. This does not create a runtime provider binding.
    return unchanged(selectedContract ?? (contextContract ? resolve(root, contextContract) : null),
      "no explicitly configured primary environment base URL; prior context selection preserved");
  const file = cfg.file ? resolve(cfg.file) : null, project = resolve(root);
  if (file && !file.startsWith(`${project}${sep}`))
    return unchanged(selectedContract ?? null, "shared config outside this project requires an explicit contract binding");

  const discovered = (selectedContract ? [selectedContract]
    : [...CONTRACT_CANDIDATES, ...(contextContract ? [contextContract] : [])])
    .map(path => resolve(root, path)).filter(path => existsSync(path) && statSync(path).isFile());
  const candidates = [...new Set(discovered.map(path => realpathSync(path)))];
  if (candidates.length > 1) return { error: { code: "CONTRACT_DISCOVERY_AMBIGUOUS",
    message: "Several local OpenAPI documents could describe the primary API; setup has not written any files.",
    next: `Set the selected environment's contract in ${LAYOUT.environments}, or select one with start --contract <path>.` } };
  if (!candidates.length) return unchanged(null, "no local contract discovered");
  const contract = candidates[0];
  if (!selectedContract && !contract.startsWith(`${project}${sep}`)) {
    const result = unchanged(null, "a contract outside this project requires an explicit environment binding");
    // Preserve only the discovered project-relative name, never the linked
    // workstation target. Static inventory can still describe this document.
    result.report.omissions = discovered.filter(path => realpathSync(path) === contract)
      .map(path => path.startsWith(`${project}${sep}`)
        ? { code: "CONTRACT_SYMLINK_OUTSIDE_PROJECT", file: relative(root, path).split(sep).join("/") }
        : { code: "CONTRACT_OUTSIDE_PROJECT", file: basename(path) });
    return result;
  }
  const upstreamContracts = Object.values(cfg.hosts ?? {}).map(host => host.contract)
    .filter(path => typeof path === "string" && path)
    .map(path => { try { return realpathSync(path); } catch { return resolve(path); } });
  if (!selectedContract && upstreamContracts.includes(contract))
    return unchanged(null, "the discovered contract belongs to a named upstream; primary binding requires explicit selection");

  // Offline first-run inventory also needs a stable selected document in both
  // host registrations. Without an explicit URL this is only static context;
  // the HTTP client still refuses to bind capture to its fallback localhost.
  if (!configured) return unchanged(contract, "offline contract discovery; no primary environment URL binding");

  const config = JSON.parse(readFileSync(file, "utf8"));
  const selected = config.environments?.[cfg.name];
  // Preserve even an explicitly empty/null declaration instead of treating it
  // as permission to replace the team's config.
  if (!selected || (!selectedContract && Object.hasOwn(selected, "contract")))
    return unchanged(null, "existing primary contract declaration preserved");
  if (selected.contract && resolve(projectConfigRoot(file), selected.contract) === contract)
    return unchanged(contract, "explicit environment contract");
  selected.contract = relative(projectConfigRoot(file), contract).split(sep).join("/");
  return { contract, file, text: `${JSON.stringify(config, null, 2)}\n`,
    report: { action: "bind", environment: cfg.name, file: relative(root, file),
      contract: selected.contract } };
}
