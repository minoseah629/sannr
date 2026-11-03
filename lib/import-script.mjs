// Bounded lexical boundaries only; never a JavaScript evaluator. Unsupported
// compound statements remain whole, so assertions inside if/try/loops cannot
// turn into unconditional checks. Strings and comments never create syntax.
export function scriptUnits(source) {
  const out = [];
  let text = "", quote = null, escape = false, line = false, block = false;
  let round = 0, square = 0, curly = 0, regexClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (line) { if (c === "\n") { line = false; text += "\n"; } continue; }
    if (block) { if (c === "*" && next === "/") { block = false; i++; text += " "; } continue; }
    if (quote) {
      text += c;
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (quote === "/" && c === "[") regexClass = true;
      else if (quote === "/" && c === "]") regexClass = false;
      else if (c === quote && !regexClass) quote = null;
      continue;
    }
    if (c === "/" && next === "/") { line = true; i++; continue; }
    if (c === "/" && next === "*") { block = true; i++; continue; }
    if (c === "/" && /[(\[=,:!&|?;{]$/.test(text.trimEnd())) { quote = "/"; regexClass = false; text += c; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; text += c; continue; }
    if (c === "(") round++;
    if (c === ")") round--;
    if (c === "[") square++;
    if (c === "]") square--;
    if (c === "{") curly++;
    if (c === "}") curly--;
    if ((c === ";" || c === "\n") && round === 0 && square === 0 && curly === 0) {
      if (text.trim()) out.push(text.trim()); text = "";
    } else text += c;
  }
  if (text.trim()) out.push(text.trim());
  return out;
}

export function staticString(source) {
  if (source[0] === '"') {
    try { const value = JSON.parse(source); return typeof value === "string" ? value : null; } catch { return null; }
  }
  const quote = source[0];
  if ((quote !== "'" && quote !== "`") || source.at(-1) !== quote) return null;
  const body = source.slice(1, -1);
  if (quote === "`" && body.includes("${")) return null;
  // Refuse complex escapes rather than interpret JavaScript literals.
  let value = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === quote || c === "\n" || c === "\r") return null;
    if (c !== "\\") { value += c; continue; }
    const escaped = body[++i];
    if (!escaped || !"\\'\"`nrt".includes(escaped)) return null;
    value += ({ n: "\n", r: "\r", t: "\t" })[escaped] ?? escaped;
  }
  return value;
}
