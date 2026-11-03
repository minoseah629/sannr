// One bounded JSON-RPC session for an entire MCP inspection. Transport errors
// never include server command lines, URLs, stderr, response bodies, or headers.
import { spawn } from "node:child_process";

const MAX_BYTES = 1024 * 1024;
const own = (value, key) => Object.hasOwn(value, key);
const failure = (code, malformed_frames = 0) => Object.assign(new Error({
  MCP_ENCODING_INVALID: "MCP response is not valid UTF-8",
  MCP_SESSION_CHANGED: "MCP HTTP session identity changed",
  MCP_TARGET_INVALID: "provide one valid MCP stdio command or HTTP endpoint without userinfo",
  MCP_NOT_INITIALIZED: "MCP server did not complete initialize",
  MCP_TIMEOUT: "MCP request timed out",
  MCP_OVERSIZED: "MCP response exceeded 1 MB",
  MCP_SPAWN_FAILED: "could not start MCP stdio server",
  MCP_SERVER_EXITED: "MCP stdio server exited before replying",
  MCP_HTTP_FAILED: "MCP HTTP request failed",
  MCP_NO_RESPONSE: "MCP response did not contain the requested JSON-RPC reply",
  MCP_SESSION_CLOSED: "MCP session is closed",
  MCP_SESSION_BUSY: "MCP session already has a pending request",
}[code] ?? "MCP transport failed"), { code, malformed_frames });

function validMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.jsonrpc !== "2.0") return false;
  const hasId = own(value, "id");
  if (hasId && value.id !== null && typeof value.id !== "string" && !(typeof value.id === "number" && Number.isFinite(value.id))) return false;
  if (typeof value.method === "string") return !own(value, "result") && !own(value, "error");
  if (!hasId || own(value, "result") === own(value, "error")) return false;
  return !own(value, "error") || (value.error && typeof value.error === "object" && !Array.isArray(value.error) && Number.isInteger(value.error.code) && typeof value.error.message === "string");
}

export function createMcpSession({ command, args = [], env, cwd, url, timeoutMs = 10_000, deadline = Infinity } = {}) {
  if (Boolean(command) === Boolean(url) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw failure("MCP_TARGET_INVALID");
  if (url) {
    let target;
    try { target = new URL(url); } catch { throw failure("MCP_TARGET_INVALID"); }
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw failure("MCP_TARGET_INVALID");
  } else if (typeof command !== "string" || !Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw failure("MCP_TARGET_INVALID");

  const remainingMs = () => Math.max(1, Math.min(timeoutMs, deadline - Date.now()));
  let malformed = 0, nextId = 1, closed = false, pending = null, transportFailure = null;
  const parse = (frame) => {
    let value;
    try { value = JSON.parse(frame); } catch { malformed++; return null; }
    if (!validMessage(value)) { malformed++; return null; }
    return value;
  };
  const errorFor = (method, code) => failure(method === "initialize" && ["MCP_TIMEOUT", "MCP_NO_RESPONSE", "MCP_SERVER_EXITED"].includes(code) ? "MCP_NOT_INITIALIZED" : code, malformed);
  const accept = (method, reply) => {
    if (method === "initialize" && reply.error) throw errorFor(method, "MCP_NOT_INITIALIZED");
    return reply;
  };

  if (url) {
    let sessionId = null, protocolVersion = null;
    const controllers = new Set();
    async function send(message) {
      if (closed) throw errorFor(message.method, "MCP_SESSION_CLOSED");
      if (Date.now() >= deadline) throw errorFor(message.method, "MCP_TIMEOUT");
      const controller = new AbortController(); controllers.add(controller);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, remainingMs());
      let reader;
      try {
        const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
        if (sessionId) headers["Mcp-Session-Id"] = sessionId;
        if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion;
        const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(message), signal: controller.signal, redirect: "error" });
        if (!response.ok) throw errorFor(message.method, "MCP_HTTP_FAILED");
        const receivedSession = response.headers.get("mcp-session-id");
        if (message.method === "initialize") sessionId = receivedSession;
        else if (receivedSession !== null && receivedSession !== sessionId) throw errorFor(message.method, "MCP_SESSION_CHANGED");
        reader = response.body?.getReader();
        if (!own(message, "id")) return;
        if (!reader) throw errorFor(message.method, "MCP_NO_RESPONSE");
        const isSse = /^text\/event-stream\b/i.test(response.headers.get("content-type") ?? "");
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const decode = value => {
          try { return decoder.decode(value, { stream: value !== undefined }); }
          catch { throw errorFor(message.method, "MCP_ENCODING_INVALID"); }
        };
        let total = 0, buffer = "", data = [], skipLf = false, firstText = true;
        const matched = (value) => value && value.id === message.id && (own(value, "result") || own(value, "error"));
        const finish = (reply) => {
          const accepted = accept(message.method, reply);
          if (message.method === "initialize" && typeof accepted.result?.protocolVersion === "string") protocolVersion = accepted.result.protocolVersion;
          return accepted;
        };
        const eventLine = (line) => {
          if (line === "") {
            if (!data.length) return null;
            const reply = parse(data.join("\n")); data = [];
            return matched(reply) ? reply : null;
          }
          if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          else if (line === "data") data.push("");
          return null;
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decode();
            if (isSse) {
              // A final frame may be terminated by EOF instead of a blank line.
              if (buffer) { const reply = eventLine(buffer.replace(/\r$/, "")); if (reply) return finish(reply); }
              const reply = eventLine(""); if (reply) return finish(reply);
              throw errorFor(message.method, "MCP_NO_RESPONSE");
            }
            const reply = parse(buffer);
            if (matched(reply)) return finish(reply);
            throw errorFor(message.method, "MCP_NO_RESPONSE");
          }
          total += value.byteLength;
          if (total > MAX_BYTES) throw errorFor(message.method, "MCP_OVERSIZED");
          buffer += decode(value);
          if (isSse) {
            if (firstText && buffer) { buffer = buffer.replace(/^\uFEFF/, ""); firstText = false; }
            // SSE permits LF, CRLF, or CR. Consume CR immediately (an open
            // stream may end a complete event there), then skip a following LF.
            for (;;) {
              if (skipLf && buffer) { if (buffer[0] === "\n") buffer = buffer.slice(1); skipLf = false; }
              const newline = buffer.search(/[\r\n]/); if (newline < 0) break;
              skipLf = buffer[newline] === "\r";
              const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
              const reply = eventLine(line); if (reply) return finish(reply);
            }
          }
        }
      } catch (error) {
        if (typeof error?.code === "string" && error.code.startsWith("MCP_")) throw error;
        throw errorFor(message.method, timedOut ? "MCP_TIMEOUT" : closed ? "MCP_SESSION_CLOSED" : "MCP_HTTP_FAILED");
      } finally {
        clearTimeout(timer); controller.abort(); controllers.delete(controller);
        if (reader) { try { await reader.cancel(); } catch { /* response cleanup has no reportable server detail */ } }
      }
    }
    return {
      get malformed_frames() { return malformed; },
      request(method, params = {}) { return send({ jsonrpc: "2.0", id: nextId++, method, params }); },
      notify(method, params) { return send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }); },
      close() { closed = true; for (const controller of controllers) controller.abort(); },
    };
  }

  let child;
  try { child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], shell: false, cwd, ...(env ? { env: { ...process.env, ...env } } : {}) }); }
  catch { throw failure("MCP_SPAWN_FAILED"); }
  let buffer = "", idleBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const decode = value => decoder.decode(value, { stream: value !== undefined });
  const settle = (error, reply) => {
    if (!pending) return;
    const current = pending; pending = null; clearTimeout(current.timer);
    if (error) current.reject(error);
    else {
      try { current.resolve(accept(current.method, reply)); }
      catch (caught) { current.reject(caught); }
    }
  };
  const fail = (code) => {
    transportFailure = code;
    if (pending) settle(errorFor(pending.method, code));
  };
  child.on("error", () => fail("MCP_SPAWN_FAILED"));
  child.stdin.on("error", () => fail("MCP_SERVER_EXITED"));
  child.stdout.on("error", () => fail("MCP_SERVER_EXITED"));
  child.on("close", () => {
    try { buffer += decode(); }
    catch { fail("MCP_ENCODING_INVALID"); }
    if (buffer.trim()) parse(buffer);
    buffer = "";
    fail("MCP_SERVER_EXITED");
  });
  child.stdout.on("data", (chunk) => {
    if (closed || transportFailure) return;
    if (pending) pending.bytes += chunk.byteLength;
    else idleBytes += chunk.byteLength;
    if ((pending?.bytes ?? idleBytes) > MAX_BYTES) { fail("MCP_OVERSIZED"); child.kill(); return; }
    try { buffer += decode(chunk); }
    catch { fail("MCP_ENCODING_INVALID"); child.kill(); return; }
    for (;;) {
      const newline = buffer.indexOf("\n"); if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const reply = parse(line);
      if (pending && reply?.id === pending.id && (own(reply, "result") || own(reply, "error"))) settle(null, reply);
    }
  });
  return {
    get malformed_frames() { return malformed; },
    request(method, params = {}) {
      if (closed) return Promise.reject(errorFor(method, "MCP_SESSION_CLOSED"));
      if (transportFailure) return Promise.reject(errorFor(method, transportFailure));
      if (pending) return Promise.reject(errorFor(method, "MCP_SESSION_BUSY"));
      if (Date.now() >= deadline) return Promise.reject(errorFor(method, "MCP_TIMEOUT"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        idleBytes = 0;
        pending = { id, method, resolve, reject, bytes: Buffer.byteLength(buffer), timer: setTimeout(() => settle(errorFor(method, "MCP_TIMEOUT")), remainingMs()) };
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => { if (error) fail("MCP_SERVER_EXITED"); });
      });
    },
    notify(method, params) {
      if (closed) return Promise.reject(errorFor(method, "MCP_SESSION_CLOSED"));
      if (transportFailure) return Promise.reject(errorFor(method, transportFailure));
      return new Promise((resolve, reject) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`, (error) => error ? reject(errorFor(method, "MCP_SERVER_EXITED")) : resolve()));
    },
    close() {
      if (closed) return;
      closed = true;
      if (pending) settle(errorFor(pending.method, "MCP_SESSION_CLOSED"));
      child.stdin.destroy(); child.kill();
      if (child.exitCode === null && child.signalCode === null) {
        const timer = setTimeout(() => child.kill("SIGKILL"), 250); timer.unref();
        child.once("close", () => clearTimeout(timer));
      }
    },
  };
}
