// Knowledge is already saved when guidance refresh runs. Keep each existing
// instruction file intact on a failed write, and refuse a concurrent edit.
import { accessSync, constants, existsSync, lstatSync, readFileSync, writeFileSync, statSync, openSync, closeSync, fchmodSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, basename, join, resolve, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeOutputPath } from './output-path.mjs';

const conflict = () => Object.assign(new Error('The managed instruction file changed during refresh.'), { code: 'POINTER_WRITE_CONFLICT' });
export function replaceNotePointer(file, text, { expectedText, beforeCommit } = {}) {
  safeOutputPath(file, { code: 'POINTER_UNSAFE_PATH' });
  if (typeof expectedText !== 'string' || readFileSync(file, 'utf8') !== expectedText) throw conflict();
  const mode = statSync(file).mode & 0o777;
  const temporary = join(dirname(file), `.${basename(file)}.refresh-${randomUUID()}`);
  let written = false;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', mode);
    written = true;
    writeFileSync(descriptor, text);
    fchmodSync(descriptor, mode);
    closeSync(descriptor);
    descriptor = undefined;
    beforeCommit?.();
    safeOutputPath(file, { code: 'POINTER_UNSAFE_PATH' });
    if (readFileSync(file, 'utf8') !== expectedText) throw conflict();
    renameSync(temporary, file);
    written = false;
  } finally {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* preserve the original write failure */ }
    if (written) try { unlinkSync(temporary); } catch { /* preserve the original write failure */ }
  }
}

import { fileURLToPath } from 'node:url';
import { PRODUCT, MCP_SERVER_KEY, LEGACY_MCP_SERVER_KEYS, POINTER_CLI_NAME, POINTER_BEGIN as BEGIN, POINTER_END as END } from './brand.mjs';
import { LAYOUT } from './layout.mjs';
import { CONTEXT_FILE, loadContextSnapshot, indexOf } from './context.mjs';
import { contextFileFor } from './stack-scope.mjs';
import { POINTER_FILES } from './capabilities.mjs';
import { resolveConfig } from './config.mjs';
import { advertisementPlan } from './advertisement.mjs';
import { discoverMcpRegistrations } from './mcp-registrations.mjs';
import { currentSetupBinding, validSetupBinding } from './setup-binding.mjs';
import { setupGuidance } from './onboarding.mjs';
import { installPointerSentence } from './install-voice.mjs';
import { registeredContextTools, renderStackContext, renderInheritedLessons } from './pointer-context.mjs';
import { renderInlineMcp } from './mcp-delivery.mjs';
import { stackEvidenceClasses, formatEvidenceClassCounts, projectKnownNotes } from './evidence-confidence.mjs';
import { planSetupContract } from './setup-contract.mjs';
import { loadHttpContract } from './http-operation-context.mjs';
import { importedTestClaimCounts } from './imported-test-claims.mjs';
import { blockText, blockCode, assertManagedBody } from './block-text.mjs';
import { loadNoteReadContext } from './note-read-model.mjs';
import { notePointerDataText, NOTE_DATA_MEANING } from './note-projection.mjs';
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const MAX_INLINE_GOTCHAS = 15;
const CLAUDE_BRIDGE = "@AGENTS.md\n";
const isClaudeBridge = (text) => /^@AGENTS\.md(?:\r?\n)?$/.test(text);

export function pointerPathProblem(root, target) {
  const base = resolve(root), dest = resolve(target);
  if (dest !== base && !dest.startsWith(`${base}${sep}`)) return "pointer path escapes the project";
  let current = base;
  for (const part of relative(base, dest).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if (error?.code === "ENOENT") continue;
      return "pointer path cannot be inspected safely";
    }
    if (stat.isSymbolicLink()) return "pointer path traverses a symbolic link";
    if (current !== dest && !stat.isDirectory()) return "pointer parent is not a directory";
    if (current === dest && (!stat.isFile() || stat.nlink !== 1))
      return "pointer target is not a single-link regular file";
  }
  return null;
}

export function inspectPointerFiles(root) {
  return POINTER_FILES.map((file) => {
    const path = join(root, file);
    const unsafe = pointerPathProblem(root, path);
    if (unsafe) return { file, path, managed: false, problem: unsafe };
    if (!existsSync(path)) return { file, path, managed: false, problem: null };
    const text = readFileSync(path, "utf8");
    const begins = text.split(BEGIN).length - 1, ends = text.split(END).length - 1;
    if (!begins && !ends) return { file, path, managed: false,
      bridge: file === "CLAUDE.md" && isClaudeBridge(text), problem: null };
    if (begins !== 1 || ends !== 1 || text.indexOf(END) < text.indexOf(BEGIN))
      return { file, path, managed: true, problem: "managed pointer delimiters are malformed" };
    return { file, path, managed: true, problem: null };
  });
}

// A plan is not complete while a later write can already be proven impossible.
// Check both the final file (when present) and the directory entry needed to
// create/replace it. Mode bits make this deterministic even under a privileged
// test runner; accessSync also catches ACL-based refusal for the current user.
export function writableDestinationProblem(target) {
  try {
    const link = lstatSync(target);
    if (link.isSymbolicLink() || !link.isFile() || link.nlink !== 1)
      return "target is not a single-link regular writable file";
    if ((link.mode & 0o222) === 0) return "target is not writable";
    try { accessSync(target, constants.W_OK); }
    catch { return "target is not writable"; }
  } catch (error) {
    if (error?.code !== "ENOENT") return "target cannot be inspected for writability";
  }

  let parent = dirname(target);
  for (;;) {
    try {
      const directory = statSync(parent);
      if (!directory.isDirectory()) return "nearest existing parent is not a directory";
      if ((directory.mode & 0o222) === 0 || (directory.mode & 0o111) === 0)
        return "nearest existing parent is not writable";
      try { accessSync(parent, constants.W_OK | constants.X_OK); }
      catch { return "nearest existing parent is not writable"; }
      return null;
    } catch (error) {
      if (error?.code !== "ENOENT") return "nearest existing parent cannot be inspected for writability";
      const next = dirname(parent);
      if (next === parent) return "no writable parent exists";
      parent = next;
    }
  }
}

function decodedPathPunctuation(value) {
  let decoded = value;
  const encodedPathPunctuation = /%(?:25|2e|2f|3a|5c)/gi;
  const punctuation = { "25": "%", "2e": ".", "2f": "/", "3a": ":", "5c": "\\" };
  for (let pass = 0; pass < 2; pass += 1) {
    const next = decoded.replace(encodedPathPunctuation,
      (token) => punctuation[token.slice(1).toLowerCase()]);
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function quoteWrapperBefore(value, start) {
  // A whitespace run can immediately precede only one URL start, so walking
  // these disjoint runs keeps the complete URL scan linear without a cap.
  let quoteAt = start - 1;
  while (quoteAt >= 0 && /\s/.test(value[quoteAt])) quoteAt -= 1;
  const quote = value[quoteAt];
  if (!/["'`]/.test(quote ?? "")) return undefined;
  let precedingCodePoint = value[quoteAt - 1] ?? "";
  const lastUnit = value.charCodeAt(quoteAt - 1);
  const priorUnit = value.charCodeAt(quoteAt - 2);
  if (lastUnit >= 0xdc00 && lastUnit <= 0xdfff
      && priorUnit >= 0xd800 && priorUnit <= 0xdbff)
    precedingCodePoint = value.slice(quoteAt - 2, quoteAt);
  if (quoteAt === 0 || !/^[\p{L}\p{N}\p{M}_]$/u.test(precedingCodePoint)) return quote;
  return undefined;
}

function withoutHttpUrlSpans(value) {
  const scheme = /\bhttps?:\/\//gi;
  const chunks = [];
  let cursor = 0, match;
  while ((match = scheme.exec(value))) {
    const start = match.index;
    if (start < cursor) continue;
    const wrapper = quoteWrapperBefore(value, start);
    let end = scheme.lastIndex;
    let parentheses = 0, squareBrackets = 0, curlyBraces = 0;
    while (end < value.length) {
      const character = value[end];
      const code = character.charCodeAt(0);
      if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)
          || /\s/.test(character) || character === "<" || character === ">"
          || character === '"' || character === "`" || character === "\\"
          || character === "|" || (character === "'" && wrapper === "'")) break;
      if (character === "(") parentheses += 1;
      else if (character === ")") {
        if (parentheses === 0) break; // Markdown link delimiter, not URL text.
        parentheses -= 1;
      } else if (character === "[") squareBrackets += 1;
      else if (character === "]") {
        if (squareBrackets === 0) break; // Wrapper delimiter, not URL text.
        squareBrackets -= 1;
      } else if (character === "{") curlyBraces += 1;
      else if (character === "}") {
        if (curlyBraces === 0) break; // Wrapper delimiter, not URL text.
        curlyBraces -= 1;
      }
      end += 1;
    }
    chunks.push(value.slice(cursor, start), " ");
    cursor = end;
    scheme.lastIndex = Math.max(end, scheme.lastIndex);
  }
  chunks.push(value.slice(cursor));
  return chunks.join("");
}

export function containsMachineLocalPath(value) {
  if (typeof value !== "string") return false;
  // Decode for detection only, then mask complete URL spans. The source note
  // remains byte-for-byte untouched in the context file and `show` output.
  const prose = withoutHttpUrlSpans(decodedPathPunctuation(value));
  const boundary = String.raw`(?:^|[^A-Za-z0-9_./-])`;
  const posix = new RegExp(boundary +
    String.raw`\/+(?:\.\/)*(?:Users|home|private(?:\/tmp)?|tmp|Volumes|var\/folders)(?=$|[\/\s"'\x60<>()\[\]{}*_,;:!?.])`);
  const drive = new RegExp(boundary + String.raw`[A-Za-z]:[\\/]`, "i");
  const backslashHost = new RegExp(boundary +
    String.raw`\\{2,}[^\\/\s]+(?=$|[\\/\s"'\x60<>()\[\]{}*_,;:!?.])`);
  const uncShare = new RegExp(boundary +
    String.raw`[\\/]{2,}[^\\/\s]+[\\/][^\\/\s]+`);
  const fileUri = /\bfile:(?:[\\/]+|[A-Za-z]:[\\/]|%)/i;
  return fileUri.test(prose) || posix.test(prose) || drive.test(prose)
    || backslashHost.test(prose) || uncShare.test(prose);
}

function renderBlock(ctx, root, commandResolution = advertisementPlan(root), mcpRegistrations = discoverMcpRegistrations(root), { registeredKey: keptKey } = {}) {
  const portable = commandResolution.portable.available
    ? commandResolution.portable.command : null;
  const bindingId = commandResolution.mcp.bindingId ?? currentSetupBinding(root, mcpRegistrations);
  const contextTools = registeredContextTools(root, mcpRegistrations, join(PACKAGE_ROOT, "server.mjs"));
  const registeredKey = [MCP_SERVER_KEY, ...LEGACY_MCP_SERVER_KEYS].find(key =>
    mcpRegistrations.some(row => row.key === key && !row.code)) ?? keptKey;
  const stackLines = renderStackContext(root, ctx, { portable, containsMachineLocalPath,
    renderMcp: stackContext => renderInlineMcp(stackContext, mcpRegistrations, { containsMachineLocalPath }) });
  if (!ctx && !stackLines) return [BEGIN, "", installPointerSentence(), "", setupGuidance(bindingId, portable, registeredKey, { stacks: Boolean(stackLines) }), "", `Project API files: see \`${LAYOUT.readme}\`.`, "", "## API context", "",
    `No OpenAPI contract was selected for context during setup, so there is no \`${contextFileFor(root, CONTEXT_FILE)}\` yet. The MCP client and installed skills remain available.`,
    portable ? `If a real contract is available, run \`${portable} start --contract <path>\` to enable API notes. Do not invent a contract to complete setup.`
      : "Install the repo-local CLI before adding a real contract and running setup again.",
    "", END].join("\n");
  const rows = ctx ? indexOf(ctx, root) : [];
  const pointerConfig = resolveConfig(root);
  const pointerBinding = planSetupContract(root, pointerConfig, { contextContract: ctx?.api?.contract });
  const grades = stackEvidenceClasses(root, ctx ?? {}, { config: pointerConfig,
    contract: pointerBinding.contract ? loadHttpContract(pointerBinding.contract, { pathPrefix: pointerConfig.contractPathPrefix }) : null,
    commits: false });
  const verified = grades.counts.verified;
  // Committed instructions carry the decision, not the private inbox status.
  const noteRead = loadNoteReadContext(root, ctx, { runRequests: false });
  const gotchas = Object.entries(ctx?.operations ?? {}).flatMap(([op, entry]) =>
    projectKnownNotes(entry, noteRead.forOperation(op)).records.map(record => ({ op, note: record.text, record })));
  // Operation IDs are structured contract identity (`GET /profile/:id`), not
  // prose paths. Only the free-text note crosses the machine-path boundary.
  const safeGotchas = gotchas.filter(({ note }) => !containsMachineLocalPath(note));
  const omittedGotchas = gotchas.length - safeGotchas.length;
  const count = `${grades.operations.size} operation${grades.operations.size === 1 ? "" : "s"}; ` +
    formatEvidenceClassCounts(grades.counts);
  const testCounts = ctx ? importedTestClaimCounts(ctx) : { total: 0 };
  const lifecycle = portable
    ? (rows.length && verified === 0 && gotchas.length === 0
      ? `This is a contract-derived inventory and is currently unverified; \`${portable} learn\` records execution-verified knowledge.`
      : `This is the current committed knowledge; \`${portable} learn\` refreshes its execution evidence.`)
    : (rows.length && verified === 0 && gotchas.length === 0
      ? "This is a contract-derived inventory and is currently unverified."
      : "This is the current committed knowledge and retains its execution evidence.");

  const workflow = `For API calls, use the repository-bound \`${commandResolution.mcp.tool}\` tool when registered.`;
  const verbOwner = `is it up / health / verify → \`${commandResolution.mcp.tool}\` tool (when registered), with the relevant endpoint and assertions; never raw-curl this repo's own API.`;
  const lines = [BEGIN, "", installPointerSentence(), "", setupGuidance(bindingId, portable, registeredKey, { stacks: Boolean(stackLines) }), "", `Project API files: see \`${LAYOUT.readme}\`.`, "", "## API workflow", "",
    workflow,
    verbOwner,
    contextTools.read
      ? "Before discovery, use api_context for the relevant operation/environment and inspect referenced evidence as needed. Saved lessons are scoped claims, not proof of current behavior."
      : "Before discovery, read the relevant saved entries and contract. Saved lessons are scoped claims, not proof of current behavior.",
    "While completing and verifying the requested task, promptly record reusable behavior missing from the contract, or a correction. " +
      (contextTools.record ? "Use api_context_record and prefer the existing observation_id; " : "") +
      `See ${PRODUCT}-write for other evidence and the CLI fallback. Do not duplicate captured response shapes or make extra calls to repair bookkeeping.`,
    ...(contextTools.record ? ["Check the recording receipt: confirm the lesson was saved and, when context.snapshot is configured, snapshot.state is written. Report failed or limited handoffs; use the team's existing Git/CI workflow to deliver the artifact and referenced evidence."] : []),
    ...(portable ? [`Use \`${portable} map .\` when a visual map is needed; use \`${portable} doctor\` for a demonstrated setup or wiring problem. These are not prerequisites for an API task.`] : []),
    "",
    "## API context", "",
    ...(stackLines ?? ["API knowledge for this service is in `" + contextFileFor(root, CONTEXT_FILE) + "` — " + count +
    ". It records learned response shapes, field values allowed by the contract, and how " +
    "recently every execution-derived claim was checked. " +
    (contextTools.read ? "Prefer scoped api_context retrieval. " : "Read the relevant saved entries directly. ") + lifecycle,
    ...(testCounts.total ? [`${testCounts.total} claims from imported tests are stored separately in \`imported_test_claims\`; they are not included in the verified-operation count. Read their source, conditions and individual execution evidence before relying on them.`] : []), ""])];

  if (!stackLines && (safeGotchas.length || omittedGotchas)) {
    lines.push("**Known gotchas** (do not rediscover these):", "", NOTE_DATA_MEANING, "");
    for (const g of safeGotchas.slice(0, MAX_INLINE_GOTCHAS)) lines.push("- `" + blockCode(g.op) + "` — " + blockText(g.note) + " [" + blockText(notePointerDataText(g.record, containsMachineLocalPath)) + "]");
    if (safeGotchas.length > MAX_INLINE_GOTCHAS)
      lines.push("- …and " + (safeGotchas.length - MAX_INLINE_GOTCHAS) + " more in `" + contextFileFor(root, CONTEXT_FILE) + "`.");
    if (omittedGotchas)
      lines.push(`- ${omittedGotchas} gotcha${omittedGotchas === 1 ? "" : "s"} omitted from this managed block because ${omittedGotchas === 1 ? "it contains" : "they contain"} a machine-local absolute path; read the original ${omittedGotchas === 1 ? "note" : "notes"} in \`${contextFileFor(root, CONTEXT_FILE)}\`.`);
    lines.push("");
  }
  if (!stackLines) {
    lines.push(...renderInheritedLessons(ctx, { containsMachineLocalPath }));
    lines.push(...renderInlineMcp(ctx, mcpRegistrations, { containsMachineLocalPath }));
  }
  // The BINARY the user installed, never `npx <name>`: this block is committed
  // into their repo and read by agents, and sannr is not published to npm yet —
  // so `npx sannr …` in a file we wrote would have an agent fetch and run
  // whatever sits at that name on the registry, on our instruction.
  if (portable)
    lines.push("Regenerate with `" + portable + " learn`. Remove with `" + portable + " unwire`.");
  else
    lines.push("Portable CLI instructions are omitted until the repo-local executable shim is installed.");
  lines.push("", END);
  // Every foreign string above went through blockText/blockCode; this guard
  // refuses the write by name should any path ever bypass them.
  const rendered = lines.join("\n");
  assertManagedBody(rendered.slice(rendered.indexOf(BEGIN) + BEGIN.length, rendered.lastIndexOf(END)), BEGIN, END);
  return rendered;
}

// Idempotent: replaces an existing block rather than appending a second one. We
// hold ourselves to the standard we would want from a tool writing into files we
// curate — delimited, replaceable, removable in one command.
function plannedBlock(path, block) {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const begins = existing.split(BEGIN).length - 1;
  const ends = existing.split(END).length - 1;
  if (begins || ends) {
    if (begins !== 1 || ends !== 1 || existing.indexOf(END) < existing.indexOf(BEGIN))
      return { action: "conflict", reason: "managed pointer delimiters are malformed; edited bytes were left untouched" };
    const start = existing.indexOf(BEGIN);
    const finish = existing.indexOf(END, start) + END.length;
    const current = existing.slice(start, finish);
    if (current === block) return { action: "unchanged", text: existing };
    return { action: "updated", text: existing.slice(0, start) + block + existing.slice(finish) };
  }
  const name = path.split("/").pop().replace(".md", "");
  const header = existing ? "" : "# " + name + "\n\n";
  return { action: "created",
    text: header + existing + (existing ? existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n" : "") + block + "\n" };
}

export function planPointers(root, ctx, commandResolution, mcpRegistrations, setup) {
  const block = renderBlock(ctx, root, commandResolution, mcpRegistrations, setup);
  return POINTER_FILES.map((file) => {
    const path = join(root, file);
    const unsafe = pointerPathProblem(root, path);
    if (!unsafe && file === "CLAUDE.md") {
      if (!existsSync(path)) return { file, path, target: "agents_bridge",
        action: "created", text: CLAUDE_BRIDGE };
      const text = readFileSync(path, "utf8");
      if (isClaudeBridge(text)) return { file, path, target: "agents_bridge",
        action: "unchanged", text };
    }
    return { file, path, ...(unsafe
      ? { action: "conflict", reason: unsafe }
      : plannedBlock(path, block)) };
  });
}

// A knowledge write refreshes knowledge in an already-managed block; setup
// (connect/start) owns its setup section. When this machine cannot produce a
// setup identifier or the repo-local shim (a fresh clone, an isolated HOME),
// keep the committed marker, registered server and portable command spelling
// rather than rewriting them from this machine's absence. Only values the
// generator itself would emit are kept, and only when every managed block
// agrees; the block is still rendered and guarded by renderBlock.
function keptSetup(root, texts, commandResolution, mcpRegistrations) {
  const sections = texts.map(text => {
    const block = text.slice(text.indexOf(BEGIN), text.indexOf(END));
    const workflow = block.indexOf("\nProject API files:");
    return { setup: workflow < 0 ? "" : block.slice(0, workflow), block };
  });
  const agreed = values => values.length > 0 && values.every(value => value && value === values[0]) ? values[0] : null;
  let resolution = commandResolution, registeredKey;
  if (!(commandResolution.mcp.bindingId ?? currentSetupBinding(root, mcpRegistrations))) {
    const binding = agreed(sections.map(({ setup }) => setup.match(/^Expected tool description marker: Setup binding: (\S+)$/mu)?.[1]));
    if (validSetupBinding(binding)) resolution = { ...resolution, mcp: { ...resolution.mcp, bindingId: binding } };
  }
  const keys = [MCP_SERVER_KEY, ...LEGACY_MCP_SERVER_KEYS];
  if (!keys.some(key => mcpRegistrations.some(row => row.key === key && !row.code))) {
    const key = agreed(sections.map(({ setup }) => setup.match(/ Registered server: `([^`\n]+)`\.$/mu)?.[1]));
    if (keys.includes(key)) registeredKey = key;
  }
  // The committed spelling is the project's portable word, never a fallback
  // npx invocation or an omission derived from this checkout's missing shim.
  const local = commandResolution.portable.available && commandResolution.portable.command === POINTER_CLI_NAME;
  if (!local && sections.length > 0 && sections.every(({ block }) => block.includes(`\nRegenerate with \`${POINTER_CLI_NAME} learn\`. Remove with \`${POINTER_CLI_NAME} unwire\`.\n`)))
    resolution = { ...resolution, portable: { command: POINTER_CLI_NAME, path: join(root, "node_modules", ".bin", PRODUCT), available: true } };
  return { resolution, setup: registeredKey ? { registeredKey } : {} };
}

export function refreshNotePointers(root, retry = "Repeat the same note command; it is idempotent and retries pointer refresh.") {
  // A note refreshes only already-managed instruction blocks. Setup remains
  // the owner of creating instruction files and the Claude import bridge.
  const states = inspectPointerFiles(root);
  const managed = states.filter(row => row.managed || row.problem);
  if (!managed.length) return { state: "unchanged", files: [] };
  const touched = [];
  try {
    const snapshot = loadContextSnapshot(root);
    if (!snapshot) throw Object.assign(new Error("The saved context is unavailable."), { code: "CONTEXT_UNAVAILABLE" });
    const files = new Set(managed.map(row => row.file));
    const originals = new Map(managed.filter(row => !row.problem).map(row => [row.file, readFileSync(row.path, "utf8")]));
    const registrations = discoverMcpRegistrations(root);
    const kept = keptSetup(root, [...originals.values()].filter(text => text.includes(BEGIN) && text.includes(END)), advertisementPlan(root), registrations);
    const plans = planPointers(root, snapshot.ctx, kept.resolution, registrations, kept.setup).filter(plan => files.has(plan.file));
    const failures = plans.filter(plan => plan.action === "conflict").map(plan => ({ file: plan.file, code: "POINTER_CONFLICT", reason: plan.reason }));
    if (failures.length) return { state: "failed", files: [], failures, retry };
    for (const plan of plans) {
      if (plan.action !== "unchanged") {
        if (loadContextSnapshot(root)?.digest !== snapshot.digest) throw Object.assign(new Error("Knowledge changed during pointer refresh."), { code: "CONTEXT_WRITE_CONFLICT" });
        const problem = writableDestinationProblem(plan.path);
        if (problem) throw Object.assign(new Error(`${plan.file}: ${problem}`), { code: "POINTER_WRITE_FAILED" });
        replaceNotePointer(plan.path, plan.text, { expectedText: originals.get(plan.file), beforeCommit: () => {
          if (loadContextSnapshot(root)?.digest !== snapshot.digest) throw Object.assign(new Error("Knowledge changed during pointer refresh."), { code: "CONTEXT_WRITE_CONFLICT" });
        } });
      }
      touched.push({ file: plan.file, action: plan.action });
    }
    if (loadContextSnapshot(root)?.digest !== snapshot.digest) return { state: "failed", files: touched, failures: [{ code: "CONTEXT_WRITE_CONFLICT", reason: "Knowledge changed during pointer refresh." }], retry };
    return { state: touched.some(row => row.action !== "unchanged") ? "written" : "unchanged", files: touched };
  } catch (error) {
    return { state: "failed", files: touched, failures: [{ code: error.code ?? "POINTER_WRITE_FAILED", reason: "The context was saved, but managed instruction blocks could not be refreshed." }], retry };
  }
}
