import { summaryCell } from "./ci.mjs";
import { secretIn } from "./verdicts.mjs";
import { redactMcpUri } from "./mcp-facts.mjs";

const HINTS = [["readOnlyHint", "read-only"], ["destructiveHint", "destructive"], ["idempotentHint", "idempotent"], ["openWorldHint", "open-world"]];
const text = (value, fallback = "—") => {
  const raw = redactMcpUri(value ?? fallback);
  if (secretIn(raw)) return "[withheld]";
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim() || fallback;
};
const fieldType = (schema) => {
  if (typeof schema?.type === "string") return schema.type;
  if (Array.isArray(schema?.type)) return schema.type.join(" | ");
  const alternatives = schema?.anyOf ?? schema?.oneOf;
  if (Array.isArray(alternatives)) {
    const types = [...new Set(alternatives.flatMap((item) => typeof item?.type === "string" ? [item.type] : []))];
    if (types.length) return types.join(" | ");
  }
  return "unspecified";
};
const fieldsFor = (schema, required) => {
  const properties = schema?.properties ?? {};
  const requiredNames = Array.isArray(schema?.required) ? schema.required : [];
  const names = [...new Set([...Object.keys(properties), ...requiredNames])];
  return names.filter((name) => requiredNames.includes(name) === required)
    .map((name) => `${name}: ${fieldType(properties[name])}`).join(", ") || "—";
};

export function renderMcpReport(record, { gfm = false } = {}) {
  const cell = gfm ? (value) => summaryCell(text(value)) : text;
  const declared = record.declared ?? {}, server = record.server ?? { name: null };
  const lines = ["MCP inspection", `Server: ${server.name ? `${cell(server.name)}${server.version ? ` ${cell(server.version)}` : ""}` : "identity unavailable (server.name: null)"}`];
  lines.push(`Label: ${cell(server.label)}`, `Protocol: ${cell(server.protocolVersion)} | Transport: ${cell(server.transport ?? record.transport)} | Initialized: ${record.initialized ? "yes" : "no"}`);
  lines.push(`Capabilities (declared): ${cell(JSON.stringify(record.capabilities ?? {}))}`);
  lines.push(`Instructions (server-provided): ${cell(record.instructions, "none")}`);
  lines.push("Annotations are server claims; they do not establish safety.", `malformed_frames: ${record.malformed_frames ?? 0}`);
  for (const [key, method] of [["tools", "tools/list"], ["resources", "resources/list"], ["resourceTemplates", "resources/templates/list"], ["prompts", "prompts/list"]]) {
    const error = declared[`${key}_error`];
    if (error !== undefined && error !== null) {
      const detail = typeof error === "object" ? `${error.code ?? "error"}: ${error.message ?? "list failed"}` : error;
      lines.push(`List failed: ${method} — ${cell(detail)}`);
    }
  }
  const table = (title, headers, rows, state) => {
    if (state === 'not_declared') { lines.push('', `${title}: not declared by this server`); return; }
    lines.push("", `${title} (${rows.length})`, "", `| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`);
    lines.push(...(rows.length ? rows : [headers.map(() => "—")]).map((row) => `| ${row.map((value) => cell(value)).join(" | ")} |`));
  };
  const list = key => Array.isArray(declared[key]) ? declared[key] : [];
  table("Tools", ["Tool", "Hints (server claims)", "Required inputs", "Optional inputs", "Output schema"], list('tools').map((tool) => [
    tool.name,
    HINTS.map(([key, label]) => tool.annotations?.[key] === true ? `claims ${label}` : tool.annotations?.[key] === false ? `claims not ${label}` : `no ${label} claim`).join("; "),
    fieldsFor(tool.inputSchema, true), fieldsFor(tool.inputSchema, false), Object.hasOwn(tool, "outputSchema") ? "declared" : "not declared",
  ]), declared.tools?.state);
  table("Resources", ["URI or URI template", "MIME type"], [...list('resources'), ...list('resourceTemplates')].map((resource) => [resource.uriTemplate ?? resource.uri, resource.mimeType]), declared.resources?.state);
  table("Prompts", ["Prompt", "Arguments"], list('prompts').map((prompt) => [prompt.name, (prompt.arguments ?? []).map((arg) => `${arg.name}${arg.required ? " (required)" : " (optional)"}`).join(", ") || "—"]), declared.prompts?.state);
  lines.push("", `Tool calls executed: ${record.measured?.length ?? 0}`);
  for (const measurement of record.measured ?? []) {
    const observed = measurement.observed ?? {};
    lines.push(`Observed ${cell(measurement.tool)}: result_kind=${cell(observed.result_kind)}; matches_output_schema=${observed.matches_output_schema ?? "null"}; missing=${cell((observed.missing ?? []).join(", ") || "none")}; unexpected=${cell((observed.unexpected ?? []).join(", ") || "none")}`);
    if (observed.type_mismatches?.length) lines.push(`  Type mismatches: ${cell(observed.type_mismatches.join(", "))}`);
    if (observed.schema_limitations?.length) lines.push(`  Schema comparison limited at: ${cell(observed.schema_limitations.join(", "))}`);
    if (observed.fields?.length) lines.push(`  Measured fields: ${cell(observed.fields.map((field) => `${field.name}: ${field.type}`).join(", "))}`);
  }
  if (record.diff) {
    const details = [], unavailable = [];
    for (const key of ["tools", "resources", "resourceTemplates", "prompts"]) {
      const changes = record.diff[key] ?? {};
      if (changes.declaration) details.push(`${key} capability: ${cell(changes.declaration.previous.replaceAll('_', ' '))} → ${cell(changes.declaration.current.replaceAll('_', ' '))}`);
      for (const name of changes.added ?? []) details.push(`${key} added: ${cell(name)}`);
      for (const name of changes.removed ?? []) details.push(`${key} removed: ${cell(name)}`);
      for (const changed of changes.changed ?? []) details.push(`${key} changed: ${cell(changed.name)} — ${cell((changed.changes ?? []).join("; "))}`);
      if (changes.unavailable?.length) unavailable.push(`${key} comparison unavailable: ${cell(changes.unavailable.join("; "))}`);
    }
    for (const change of record.diff.server ?? []) details.push(`server: ${cell(change)}`);
    if (record.diff.tool_declarations) details.push(cell(record.diff.tool_declarations));
    if (record.diff.capabilities) details.push(cell(record.diff.capabilities));
    if (record.diff.instructions) details.push(cell(record.diff.instructions));
    const status = details.length ? "declaration changes" : unavailable.length ? "no comparable declaration changes" : "no declaration changes";
    lines.push("", `since ${cell(record.diff.since ?? record.diff_from)}: ${status}${unavailable.length ? "; comparison incomplete" : ""}`, ...details, ...unavailable);
  } else lines.push("", "First inspection for this server; no previous record to compare.");
  return `${lines.join("\n")}\n`;
}
