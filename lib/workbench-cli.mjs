import { osOpenLaunch } from './os-open.mjs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createWorkbenchServer } from './workbench-server.mjs';
import { workbenchAssets, workbenchHandlers, createShowQueue } from './workbench-engine.mjs';
import { createWorkbenchControl } from './workbench-control.mjs';
import { buildSessionLedger } from './session-ledger.mjs';
import { latestAgentSession } from './session-summary.mjs';
import { SESSION_ID } from './workbench-session.mjs';
import { readWorkbenchHandoff } from './workbench-handoff.mjs';
import { LAYOUT } from './layout.mjs';
import { CLI_NAME } from './brand.mjs';

export const workbenchHelp = () => `\nUsage: ${CLI_NAME} workbench [--session <id>] [--show last-session | --show <session id>] [--no-open]
Launch this repository’s local workbench. Agent presence is optional. Enter the browser’s pairing
code in this terminal. The URL contains no authority. Close with Ctrl-C; idle
authority expires after 15 minutes, with an 8-hour maximum lifetime.
Opening is read-only. The page shows the Workbench and Map views of this repository's
stacks; responses you save there stay on this machine, outside the ledger.
Use --session to continue an earlier repository inbox; otherwise a new inbox is selected.
--show last-session or --show <ledger session id> is accepted for compatibility; the page has
no session view, so read that session with ${CLI_NAME} sessions.
Docs: docs/workbench.md`;

// Keep the launch terminal available for an explicit reconnect, without
// repeatedly asking an already-connected operator for another pairing code.
// Injectable streams exercise the real readline interaction in local tests.
export function createWorkbenchPairingTerminal({ input, output, authorizePairing, onClose }) {
  const terminal = createInterface({ input, output });
  let state = 'idle';
  const write = text => output.write(`${text}\n`);
  function prompt() { terminal.setPrompt('Pairing code: '); terminal.prompt(); }
  terminal.on('line', line => {
    if (state !== 'requested') {
      write(state === 'connected' ? 'Workbench ready. Ctrl-C closes the workbench.' :
        state === 'approved' ? 'Waiting for the browser to connect. Ctrl-C closes the workbench.' :
          'Open the local workbench URL to pair a browser. Ctrl-C closes the workbench.');
      return;
    }
    state = 'checking';
    function complete(approved) {
      // Browser completion can arrive before the asynchronous approval reply.
      if (state === 'connected' || state === 'closed') return;
      if (approved === true) {
        state = 'approved';
        terminal.setPrompt('');
        write('Code accepted. Waiting for the browser to connect…');
      } else {
        state = 'requested';
        write('That pairing code is unavailable or expired. Check the browser’s current code, or request a new one.');
        prompt();
      }
    }
    try {
      const approval = authorizePairing(line);
      if (approval && typeof approval.then === 'function') approval.then(complete, () => complete(false));
      else complete(approval);
    } catch { complete(false); }
  });
  terminal.on('SIGINT', onClose); terminal.on('close', onClose);
  return Object.freeze({
    pairingState(next) {
      if (next === 'requested' && state !== 'requested') {
        state = 'requested';
        write('Browser requested pairing. Enter the code shown in the browser.');
        prompt();
      } else if (next === 'connected' && state !== 'connected') {
        state = 'connected';
        terminal.setPrompt('');
        write('Browser connected. Workbench ready. Ctrl-C closes the workbench.');
      }
    },
    close: () => { state = 'closed'; terminal.close(); },
  });
}

// Shared by the interactive terminal and exact-package adapter checks. No MCP
// host, registration or presence record is required to open the local viewport.
/** The session a --show value names: `last-session` is the newest agent
 * (MCP host) session in this repository's ledger, otherwise a ledger session
 * id that must exist. null when last-session has nothing to show yet. */
export function resolveShowTarget(root, value) {
  if (value === 'last-session') return latestAgentSession(buildSessionLedger(root, { attentionBound: 1 }))?.session ?? null;
  if (typeof value !== 'string' || !SESSION_ID.test(value)) throw Object.assign(new Error('Use --show last-session or a ledger session id.'), { code: 'WORKBENCH_SESSION_ID_INVALID' });
  if (!buildSessionLedger(root, { attentionBound: 1 }).sessions.some(session => session.id === value))
    throw Object.assign(new Error('No recorded session has that id.'), { code: 'WORKBENCH_SESSION_UNKNOWN', next: `Run ${CLI_NAME} sessions to list recorded sessions, or use --show last-session.` });
  return value;
}
/** The launch URL for a session: the hash carries a ledger session id only. */
export const workbenchShowUrl = (url, session) => session ? `${url}#session/${encodeURIComponent(session)}` : url;

// The OS opener is shared with `view --open` (lib/os-open.mjs); on Windows,
// PowerShell's Start-Process reads the URL from this environment variable.
const WINDOWS_OPEN_URL_ENV = 'WORKBENCH_OPEN_URL';
/** The browser launcher for a URL on a platform, without starting anything. */
export const browserLaunch = (url, platform = process.platform, env = process.env) =>
  osOpenLaunch(url, { platform, env, variable: WINDOWS_OPEN_URL_ENV });

export function parseWorkbenchArgs(args) {
  let sessionId, show, open = true;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--no-open') { open = false; continue; }
    if (args[index] === '--session' && !sessionId && typeof args[index + 1] === 'string') { sessionId = args[++index]; continue; }
    if (args[index] === '--show' && show === undefined && typeof args[index + 1] === 'string') { show = args[++index]; continue; }
    throw Object.assign(new Error('Unknown workbench argument.'), { code: 'WORKBENCH_ARGUMENT_INVALID' });
  }
  return { sessionId, show, open };
}

export async function launchWorkbench(root, { sessionId, onPairingState, control = true } = {}) {
  if (sessionId !== undefined) {
    readWorkbenchHandoff(root, sessionId, { limit: 1 }); // shape/path/history checks
    if (!existsSync(join(root, LAYOUT.evidence, 'workbench', 'handoffs', `${sessionId}.json`)))
      throw Object.assign(new Error('The requested repository inbox does not exist.'), {
        code: 'WORKBENCH_SESSION_NOT_FOUND', next: `Use an earlier inbox ID from api_workbench status, or run ${CLI_NAME} workbench for a new inbox.` });
  } else sessionId = `wb-${randomUUID()}`;
  const shows = createShowQueue(root);
  let paired = false;
  const server = await createWorkbenchServer({ assets: workbenchAssets(), handlers: workbenchHandlers(root, { sessionId, shows }),
    onPairingState: state => { if (state === 'connected') paired = true; onPairingState?.(state); } });
  // The discovery record and control socket let an agent ask this launch to
  // bring a session forward. Losing them only disables that path.
  let controller = null;
  if (control) try { controller = await createWorkbenchControl({ root, sessionId, onShow: id => shows.push(id), isPaired: () => paired }); } catch { controller = null; }
  const close = async reason => { await controller?.close(); return server.close(reason); };
  void server.closed.then(() => controller?.close());
  return Object.freeze({ ...server, close, sessionId, control: controller ? { record: controller.record } : null });
}

export async function runWorkbenchCli(root, args) {
  const { sessionId, show, open } = parseWorkbenchArgs(args);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw Object.assign(new Error('Launch the workbench in an interactive terminal for browser pairing.'), { code: 'WORKBENCH_TERMINAL_REQUIRED', next: `${CLI_NAME} workbench` });
  const target = show === undefined ? null : resolveShowTarget(root, show);
  let terminal;
  const server = await launchWorkbench(root, { sessionId, onPairingState: state => terminal?.pairingState(state) });
  const url = workbenchShowUrl(server.url, target);
  console.log(`Local workbench: ${url}\nRepository inbox: ${server.sessionId}${show !== undefined && !target ? '\nNo agent session is recorded yet.' : target ? `\nSession ${target} is recorded; read it with ${CLI_NAME} sessions. The page opens on the Workbench view.` : ''}\nWaiting for the browser to pair. Ctrl-C closes the workbench.`);
  const stop = () => { void server.close(); };
  terminal = createWorkbenchPairingTerminal({ input: process.stdin, output: process.stdout,
    authorizePairing: code => server.authorizePairing(code), onClose: stop });
  process.once('SIGTERM', stop);
  if (open) {
    const launch = browserLaunch(url);
    const child = spawn(launch.command, launch.args, { stdio: 'ignore', shell: false, windowsHide: true,
      ...(launch.env ? { env: { ...process.env, ...launch.env } } : {}) });
    child.on('error', () => console.log('Open the local URL above in your browser.'));
  }
  const result = await server.closed;
  terminal.close(); process.removeListener('SIGTERM', stop);
  console.log(`Workbench closed (${result.reason}). The browser has no remaining authority.`);
}
