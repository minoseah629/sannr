// Defensive limits at the untrusted import boundary. Walk iteratively before
// format-specific recursive adapters; diagnostics contain only locations and
// rules, never a value or an underlying engine exception.
import { scanMetadataSecrets, redactMetadataSecrets } from './verdicts.mjs';
export function importFailure(code, location, rule) {
  return Object.assign(new Error(`${location}: ${rule}`), { code });
}

export function validateImportInput(value, { code = "IMPORT_INPUT_INVALID", location = "import document" } = {}) {
  const active = new WeakSet();
  const pending = [{ value, depth: 0 }];
  let nodes = 0, textUnits = 0;
  while (pending.length) {
    const item = pending.pop(), node = item.value;
    if (item.leave) { active.delete(node); continue; }
    if (++nodes > 100000) throw importFailure(code, location, "document exceeds the 100000-node bound");
    if (item.depth > 64) throw importFailure(code, location, "nesting exceeds depth 64");
    if (typeof node === "string") {
      textUnits += node.length;
      if (textUnits > 2 * 1024 * 1024) throw importFailure(code, location, "text exceeds the 2 MiB character bound");
      continue;
    }
    if (node === null || typeof node !== "object") continue;
    if (active.has(node)) throw importFailure(code, location, "cyclic input is not supported");
    active.add(node);
    pending.push({ value: node, leave: true });
    const keys = Object.keys(node);
    if (keys.length + nodes > 100000) throw importFailure(code, location, "document exceeds the 100000-node bound");
    for (const key of keys) {
      if (key === "__proto__" || key === "constructor" || key === "prototype")
        throw importFailure(code, location, "prototype-affecting mapping keys are refused");
      textUnits += key.length;
      pending.push({ value: node[key], depth: item.depth + 1 });
    }
  }
}

export function importBoundary(code, location, input, run) {
  try {
    // Text inputs are bounded by the YAML facade (size, depth, aliases, multi-document)
    // with its own named failures; the object walker validates what the parser returns.
    if (typeof input !== "string") validateImportInput(input, { code, location });
    const result = run();
    if (result?.report) result.report = redactMetadataSecrets(result.report);
    // Renderers escape individual cells from an already scanned model.
    return typeof result === 'string' ? result : scanMetadataSecrets(result);
  } catch (error) {
    if (error instanceof Error && error.constructor === Error && typeof error.code === "string") throw error;
    throw importFailure(code, location, "field shape is invalid for this import format");
  }
}

export function importArray(value, code, location) {
  if (value !== undefined && value !== null && !Array.isArray(value))
    throw importFailure(code, location, "must be an array");
  return value ?? [];
}
