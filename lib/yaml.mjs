// Bounded, dependency-free YAML facade used by importers.
// The OpenAPI subset parser remains in context.mjs for compatibility; this
// module adds stream and input safety at the format boundary. Duplicate keys
// are last-wins and are reported on the returned document's non-enumerable
// `yamlWarnings` array; JSON.stringify drops it, so consumers must read it
// before serializing. Depth counts containers with the root included.
import { parseYamlDocument as parseDocument } from "./context.mjs";

export const YAML_MAX_BYTES = 50 * 1024 * 1024;
// Containers including the root; a document with N containers parses iff N <= YAML_MAX_DEPTH.
export const YAML_MAX_DEPTH = 33;

function splitDocuments(source) {
  const docs = [];
  let current = [];
  let quote = null;
  const scanQuote = (line) => {
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quote) {
        if (quote === '"' && ch === "\\") { i += 1; continue; }
        if (ch === quote) {
          if (quote === "'" && line[i + 1] === "'") { i += 1; continue; }
          quote = null;
        }
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "#" && /\s/.test(line[i - 1] ?? "")) break;
    }
  };
  const finish = () => {
    if (current.some((x) => x.trim() && !x.trim().startsWith("#"))) docs.push(current.join("\n"));
    current = [];
  };
  for (const raw of source.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const marker = !quote && /^(---|\.\.\.)(?:\s|$)/.test(line);
    if (marker) finish();
    else { current.push(line); scanQuote(line); }
  }
  finish();
  return docs;
}

export function parseYaml(text, { multi = false } = {}) {
  const source = String(text ?? "").replace(/^\uFEFF/, "");
  if (Buffer.byteLength(source, "utf8") > YAML_MAX_BYTES)
    throw Object.assign(new Error("YAML input exceeds 50 MB"), { code: "YAML_INPUT_OVERSIZED" });
  if (/(?:^|\n)\t+\S/.test(source))
    throw Object.assign(new Error("tabs are not permitted for YAML indentation"), { code: "YAML_TABS_INDENTATION" });
  const docs = splitDocuments(source);
  if (!multi && docs.length > 1)
    throw Object.assign(new Error(`YAML stream contains ${docs.length} documents; expected one`), { code: "YAML_MULTI_DOCUMENT" });
  const values = docs.map((doc) => {
    try { return parseDocument(doc, { maxDepth: YAML_MAX_DEPTH, strictDepth: true }); }
    catch (error) {
      if (error?.code?.startsWith("YAML_")) throw error;
      // Native parser diagnostics may quote source material. Neither the public
      // message nor a nested cause may carry an unreviewed input excerpt.
      throw Object.assign(new Error("YAML document: parsing failed; expected a supported YAML value"), { code: "YAML_PARSE_FAILED" });
    }
  });
  return multi ? values : values[0] ?? null;
}

export { parseDocument as parseYamlDocument };
