import { CLI_NAME, PRODUCT } from "./brand.mjs";
import { terminalText, terminalTheme } from "./terminal.mjs";
import { coverageStatement } from "./map.mjs";
import { renderApiMapText } from "./api-map.mjs";
import { basename } from "node:path";

const count = (value, singular, plural = `${singular}s`) =>
  `${value} ${value === 1 ? singular : plural}`;

// The reference's number-first poster tiles, expressed in terminal cells.
// Captions can span two lines; narrow terminals retain compact, complete facts.
function renderCounts(tiles, width, theme) {
  if (width < 48) return tiles.map((tile) => `  ${tile.n > 0
    ? (tile.finding ? theme.alarm(tile.fact) : theme.accent(tile.fact)) : tile.fact}`);

  const perRow = Math.min(3, Math.floor((width + 2) / 24));
  const cellWidth = Math.floor((width - (perRow - 1) * 2) / perRow);
  const lines = [];
  for (let start = 0; start < tiles.length; start += perRow) {
    const group = tiles.slice(start, start + perRow);
    const captionRows = Math.max(...group.map((tile) => tile.caption.length));
    const cards = group.map((tile) => {
      const frame = `+${"-".repeat(cellWidth - 2)}+`;
      const row = (text) => `| ${text.padEnd(cellWidth - 4)} |`;
      const card = [frame, row(String(tile.n)),
        ...Array.from({ length: captionRows }, (_, i) => row(tile.caption[i] ?? "")), frame];
      if (tile.n > 0) return card.map(tile.finding ? theme.alarm : theme.stamp);
      return card.map((line, i) => i === 0 || i === card.length - 1 ? theme.muted(line) : line);
    });
    if (start) lines.push("");
    for (let line = 0; line < cards[0].length; line++)
      lines.push(`  ${cards.map((card) => card[line]).join("  ")}`);
  }
  return lines;
}

/**
 * The default HTML command's receipt; the model, JSON, and --text are separate.
 * `apiMap`, when the store has operations, adds the API map's counts: a repo
 * that serves nothing but consumes an API reports what its store holds.
 */
export function renderMapReceipt(model, { out, preview, previewFailed = false,
  noExecute = false, theme = terminalTheme(), apiMap } = {}) {
  const { summary: s } = model;
  const width = Math.max(20, Math.min(76, theme.columns - 4));
  const rule = "/".repeat(width);
  const tile = (n, singular, caption, { plural, finding = false } = {}) => ({
    n, fact: count(n, singular, plural), caption, finding,
  });
  const tiles = [
    tile(s.services, "service", [s.services === 1 ? "SERVICE" : "SERVICES"]),
    tile(s.operations, "documented operation", [s.operations === 1 ? "DOCUMENTED OP" : "DOCUMENTED OPS"]),
    tile(s.edges, "service edge", [s.edges === 1 ? "SERVICE EDGE" : "SERVICE EDGES"]),
    tile(s.shadow, "shadow route", [s.shadow === 1 ? "SHADOW ROUTE" : "SHADOW ROUTES"], { finding: true }),
    tile(s.findings, "disagreement", [s.findings === 1 ? "DISAGREEMENT" : "DISAGREEMENTS"], { finding: true }),
    tile(s.external, "external dependency", [s.external === 1 ? "EXTERNAL UPSTREAM" : "EXTERNAL UPSTREAMS"],
      { plural: "external dependencies" }),
    ...(s.undocumented_routes ? [tile(s.undocumented_routes, "undocumented route",
      ["UNDOCUMENTED", s.undocumented_routes === 1 ? "ROUTE" : "ROUTES"], { finding: true })] : []),
    ...(s.platform ? [tile(s.platform, "platform disagreement",
      ["PLATFORM", s.platform === 1 ? "DISAGREEMENT" : "DISAGREEMENTS"], { finding: true })] : []),
  ];
  const lines = ["", `  ${theme.bold(PRODUCT)}${theme.accent(".")}  ${theme.muted("// MAP · SNAPSHOT")}`,
    `  ${theme.muted(rule)}`,
    ...(model.root ? [`  ${theme.muted(`// map / ${terminalText(basename(model.root))}`)}`] : []), "",
    `  ${theme.bold("API")}`, `  ${theme.accent("FOOTPRINT.")}`,
    `  ${theme.bold("MAP'S IN.")} Follow the wires.`, "",
    ...(model.graph ? [`  ${theme.muted("// LOCAL SCAN")}`] : []), ...renderCounts(tiles, width, theme),
    `  ${theme.muted(`// COVERAGE · ${coverageStatement(model, { noExecute, apiMap })}`)}`];
  if (apiMap) lines.push("", `  ${theme.bold("// API MAP")} ${theme.muted("· projected from the store and contract")}`,
    ...renderApiMapText(apiMap).split("\n").map((line) => `  ${line}`), "");
  if (s.high) lines.push("", `  ${theme.alarm(" START HERE ")} ${theme.high(count(s.high, "high-severity finding"))}`);
  if (s.services === 0)
    lines.push(s.external
      ? "  This repo calls APIs; no served API was found in this scan."
      : "  No served API was found in this scan.");
  if (s.external)
    lines.push(theme.muted("  External dependencies sit outside the scanned services."));
  if (model.graph) lines.push("", `  ${theme.bold("// SHARED CONTEXT")}`,
    `  ${count(model.graph.repositories?.length ?? 0, "published repo")}. ${count(model.graph.edges?.length ?? 0, "declared dependency", "declared dependencies")}.`,
    `  ${count(model.graph.unresolved?.length ?? 0, "unresolved provider")}. Coverage is partial.`,
    theme.muted(`  Agent entry point: ${CLI_NAME} graph context --json`));
  if (preview) lines.push("", `  ${theme.bold("// OPEN THE MAP")}`,
    `  ${theme.accent("↗")} ${theme.accent(theme.link(preview.url))}`,
    "  Cmd/Ctrl+click. Follow the wires in your browser.",
    theme.muted(`  Local preview, pid ${preview.pid}. Link expires in ${preview.expiresInMinutes} minutes.`),
    theme.muted(`  Stop: ${process.platform === "win32" ? `taskkill /PID ${preview.pid} /T /F` : `kill ${preview.pid}`}`));
  lines.push("", `  ${theme.bold(preview ? "// KEEP A COPY" : "// SAVED MAP")}`, `  ${terminalText(out)}`,
    ...(!preview ? [previewFailed
      ? "  Browser preview unavailable. Open this file from your browser."
      : "  Open this file from your browser."] : []),
    theme.muted("  One HTML file. Works offline. Pass it around."), "",
    theme.muted(noExecute
      ? model.graph ? "  Source scan and selected snapshots. No API requests executed." : "  Source scan only. No API requests executed."
      : "  From source declarations and available probe results."),
    `  ${theme.muted(rule)}`, "");
  return lines.join("\n");
}
