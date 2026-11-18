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

export const workbenchHelp = () => `\nUsage: ${CLI_NAME} workbench open [--project <path>] [--view workbench|activity|request|map] [--stack <name>] [--operation "<METHOD /path>"] [--no-open] [--json]
       ${CLI_NAME} workbench status [--project <path>] [--json]
       ${CLI_NAME} workbench stop [--project <path>] [--json]
       ${CLI_NAME} workbench [--session <id>] [--show last-session | --show <session id>] [--no-open]
open starts this repository’s workbench in the background, or reuses the one already running, and
opens a connected browser page. It needs no terminal and no pairing code, so a coding agent can run
it. --project names another local checkout; each checkout has its own workbench, and several can run
at once. stop closes this checkout’s workbench only. It also stops by itself 30 minutes after its
last page request, and after 8 hours. The printed URL contains no authority.
With no subcommand, launch the workbench in this interactive terminal instead and enter the browser’s
pairing code here. Close with Ctrl-C; idle authority expires after 15 minutes, with an 8-hour
maximum lifetime.
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

const LAUNCH_COMMANDS = ['open', 'status', 'stop', 'serve'];
/** Flags of the launch subcommands; anything else is refused before any work. */
export function parseWorkbenchLaunchArgs(command, args) {
  const options = { json: false, open: true }, values = command === 'open' ? ['--project', '--view', '--stack', '--operation'] : ['--project'];
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--json' && command !== 'serve') { options.json = true; continue; }
    if (flag === '--no-open' && command === 'open') { options.open = false; continue; }
    if (values.includes(flag) && options[flag.slice(2)] === undefined && typeof args[index + 1] === 'string') { options[flag.slice(2)] = args[++index]; continue; }
    throw Object.assign(new Error(`Unknown workbench ${command} argument.`), { code: 'WORKBENCH_ARGUMENT_INVALID', next: `${CLI_NAME} workbench --help` });
  }
  return options;
}

const browserLine = outcome => {
  const { browser, page } = outcome;
  if (browser.state === 'not-requested') return 'Browser: not opened (--no-open). A page connects only through a launch; the URL alone grants no access.';
  if (browser.state !== 'dispatched') return `Browser: not opened. ${browser.message} (${browser.code})\n${browser.next}`;
  return `Browser: the system opener accepted the request${page.state === 'connected' ? ', and the page connected.' : '. No page had connected yet when this returned, so this does not confirm that it rendered.'}`
    + (browser.remote_session ? '\nThis looks like a remote session: the browser opened on the machine that ran this command.' : '');
};

// open, status, stop: one checkout's background Workbench. serve is that
// background process itself, started by open and never by a person.
async function runWorkbenchLaunchCli(root, command, args) {
  const options = parseWorkbenchLaunchArgs(command, args);
  const launch = await import('./workbench-launch.mjs');
  const emit = (value, lines) => { console.log(options.json ? JSON.stringify(value, null, 1) : lines.filter(Boolean).join('\n')); if (value.ok === false) process.exitCode = 1; };
  try {
    if (command === 'serve') {
      if (options.project === undefined) throw Object.assign(new Error('The workbench service is started by workbench open.'), { code: 'WORKBENCH_ARGUMENT_INVALID', next: `${CLI_NAME} workbench open` });
      const { runWorkbenchService } = await import('./workbench-service.mjs');
      const notify = message => new Promise(done => {
        if (typeof process.send !== 'function' || !process.connected) return done();
        try { process.send(message, () => { try { process.disconnect(); } catch { /* already closed */ } done(); }); } catch { done(); }
      });
      const result = await runWorkbenchService(options.project, { notify });
      // Nothing else keeps this process: leave even if a handle lingers.
      process.exit(['failed'].includes(result?.reason) ? 1 : 0);
    }
    const target = options.project === undefined ? launch.resolveWorkbenchProject(root) : launch.resolveWorkbenchProject(options.project);
    const named = repo => `${repo.name} (${repo.root})`;
    if (command === 'open') {
      const outcome = await launch.openWorkbench(target, { open: options.open,
        context: { view: options.view, stack: options.stack, operation: options.operation } });
      return emit(outcome, [`Workbench for ${named(outcome.repository)}`,
        outcome.instance.state === 'created' ? 'Started a new local instance.' : 'Reused the instance that was already running.',
        `Local URL: ${outcome.url}`, browserLine(outcome),
        outcome.context?.ignored.length ? `Ignored: ${outcome.context.ignored.join(', ')} (not a usable value). The repository opened as asked.` : null,
        `Stop it with: ${outcome.stop}`]);
    }
    if (command === 'status') {
      const status = await launch.workbenchServiceStatus(target);
      return emit(status, [`Workbench for ${named(status.repository)}: ${status.state === 'running' ? 'running' : status.state === 'unresponsive' ? 'not answering' : 'not running'}`,
        status.state === 'running' ? `Local URL: ${status.url}\nConnected pages: ${status.pages_connected ?? 'unknown'}\nStops by itself at: ${status.instance.expires_at}\nStop it with: ${status.stop}` : null,
        status.state === 'unresponsive' ? status.next : null, status.state === 'not-running' ? `Open it with: ${status.open}` : null]);
    }
    const stopped = await launch.stopWorkbenchService(target);
    return emit(stopped, [`Workbench for ${named(stopped.repository)}: ${stopped.state === 'stopped' ? 'stopped. Other repositories’ workbenches are unaffected.' : 'was not running.'}`]);
  } catch (error) {
    // With --json a refusal is the same kind of object on stdout, so a caller
    // reads one shape; otherwise the CLI's usual error report applies.
    if (!options.json || typeof error?.code !== 'string') throw error;
    emit({ ok: false, error: { code: error.code, message: error.message, ...(error.next ? { next: error.next } : {}) },
      ...(error.project ? { repository: { root: error.project } } : {}) }, []);
  }
}

export async function runWorkbenchCli(root, args) {
  if (LAUNCH_COMMANDS.includes(args[0])) return runWorkbenchLaunchCli(root, args[0], args.slice(1));
  const { sessionId, show, open } = parseWorkbenchArgs(args);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw Object.assign(new Error('The terminal launch needs an interactive terminal for browser pairing. Use workbench open, which needs none.'), { code: 'WORKBENCH_TERMINAL_REQUIRED', next: `${CLI_NAME} workbench open` });
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
