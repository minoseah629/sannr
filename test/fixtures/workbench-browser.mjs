// A stand-in for the system opener and the browser behind it, for launch
// tests. A test puts a small `open` / `xdg-open` script on PATH that runs this
// file with the URL the product handed to the opener. What it does is chosen
// by WORKBENCH_TEST_BROWSER:
//   connect  act as the opened page: redeem the launch once, as the page does
//   ignore   accept the request and open nothing
//   fail     exit non-zero, as an opener that could not hand the URL on
// Each run appends one JSON line to WORKBENCH_TEST_BROWSER_LOG. Imported, the
// module gives tests the same same-origin request the page sends. Loopback only.
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** One JSON POST as the packaged page sends it, from `origin` unless overridden. */
export function pageRequest(origin, path, body = {}, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  const all = { origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty',
    'content-type': 'application/json', accept: 'application/json', 'content-length': payload.length, ...headers };
  for (const key of Object.keys(all)) if (all[key] === undefined) delete all[key];
  return new Promise(done => {
    const req = request(origin, { method: 'POST', path, headers: all, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* not JSON */ } done({ status: res.statusCode, json }); });
      res.on('error', () => done({ status: 0, json: null }));
    });
    req.on('error', error => done({ status: 0, json: null, code: error.code }));
    req.end(payload);
  });
}
/** A page action with a session token. */
export const pageAction = (origin, token, action, params = {}) => pageRequest(origin, '/action', { action, params }, { 'x-workbench-token': token });
/** Redeem a launch grant, as the opened page does once. */
export const redeemLaunch = (origin, grant) => pageRequest(origin, '/launch/redeem', {}, { 'x-workbench-launch': grant });

/** Put `open` and `xdg-open` stand-ins in a new directory and return it, for the front of PATH. */
export function installTestBrowser(directory) {
  mkdirSync(directory, { recursive: true });
  const script = `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(import.meta.url)}" "$@"\n`;
  for (const name of ['open', 'xdg-open']) { const file = join(directory, name); writeFileSync(file, script); chmodSync(file, 0o755); }
  return directory;
}
/** What the stand-in recorded, oldest first. */
export const browserLog = file => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const target = process.argv.at(-1), mode = process.env.WORKBENCH_TEST_BROWSER ?? 'connect', log = process.env.WORKBENCH_TEST_BROWSER_LOG;
  const note = value => { if (log) appendFileSync(log, `${JSON.stringify(value)}\n`); };
  if (mode === 'fail') { note({ mode }); process.exit(1); }
  const url = new URL(target), params = new URLSearchParams(url.hash.slice(1));
  const entry = { mode, origin: url.origin, plain: `${url.origin}${url.pathname}`, grant: params.get('launch'),
    view: params.get('view'), stack: params.get('stack'), operation: params.get('operation') };
  if (mode === 'connect') {
    const reply = await redeemLaunch(url.origin, entry.grant);
    Object.assign(entry, { status: reply.status, token: reply.json?.result?.token ?? null, code: reply.json?.error?.code ?? null });
  }
  note(entry);
}
