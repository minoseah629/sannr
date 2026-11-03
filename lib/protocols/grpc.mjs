// Native, descriptor-bound gRPC. Preparation reads only bounded project files;
// execution opens one RPC, never retries, and requires terminal gRPC status.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import protobuf from "protobufjs";
import { SECRET_HEADERS, CREDENTIAL_SHAPED_HEADER } from "../curl.mjs";

export const GRPC_LIMITS = Object.freeze({
  descriptorBytes: 1024 * 1024, fileBytes: 256 * 1024, files: 32, importDepth: 8,
  depth: 32, nodes: 20_000, messageBytes: 256 * 1024, totalMessageBytes: 1024 * 1024,
  defaultMessages: 25, maxMessages: 100, deadlineMs: 30_000,
});
const JSON_OPTIONS = { keepCase: true, longs: String, enums: String, bytes: String, json: true };
const own = (obj, key) => Object.hasOwn(obj, key);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const failure = (code, message) => Object.assign(new Error(message), { code });
const invalidDescriptor = () => failure("GRPC_DESCRIPTOR_INVALID", "The project gRPC descriptor or its imports could not be loaded safely.");
const invalidMessage = () => failure("GRPC_MESSAGE_INVALID", "The gRPC message does not match the selected protobuf request type.");
const messageLimit = () => failure("GRPC_MESSAGE_LIMIT", "The gRPC message exceeds the supported size, depth, or count limit.");

function boundedJson(value, maxBytes = GRPC_LIMITS.messageBytes) {
  let nodes = 0;
  const ancestors = new Set();
  function visit(current, depth) {
    if (++nodes > GRPC_LIMITS.nodes || depth > GRPC_LIMITS.depth) throw messageLimit();
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number" && Number.isFinite(current)) return;
    if ((!object(current) && !Array.isArray(current)) || ancestors.has(current)) throw invalidMessage();
    ancestors.add(current);
    for (const key of Object.keys(current)) visit(current[key], depth + 1);
    ancestors.delete(current);
  }
  visit(value, 0);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > maxBytes) throw messageLimit();
  return json;
}

// Parsing is in memory. proto-loader never gets a filename and cannot follow
// an unchecked import or reread a checked source after it changes on disk.
function safeFile(root, path) {
  const rel = relative(root, path);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw invalidDescriptor();
  let part = root;
  for (const name of rel.split(sep)) {
    part = resolve(part, name);
    if (lstatSync(part).isSymbolicLink()) throw invalidDescriptor();
  }
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > GRPC_LIMITS.fileBytes) throw invalidDescriptor();
    const bytes = Buffer.alloc(GRPC_LIMITS.fileBytes + 1);
    let count = 0;
    while (count < bytes.length) {
      const size = readSync(fd, bytes, count, bytes.length - count, null);
      if (!size) break;
      count += size;
    }
    if (count > GRPC_LIMITS.fileBytes) throw invalidDescriptor();
    return bytes.subarray(0, count);
  } finally { if (fd !== undefined) closeSync(fd); }
}

function boundedProto(text) {
  let depth = 0, quote = null, lineComment = false, blockComment = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i], next = text[i + 1];
    if (lineComment) { if (c === "\n") lineComment = false; continue; }
    if (blockComment) { if (c === "*" && next === "/") { blockComment = false; i += 1; } continue; }
    if (quote) { if (c === "\\") i += 1; else if (c === quote) quote = null; continue; }
    if (c === "/" && next === "/") { lineComment = true; i += 1; continue; }
    if (c === "/" && next === "*") { blockComment = true; i += 1; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "{" && ++depth > GRPC_LIMITS.depth) throw invalidDescriptor();
    if (c === "}") depth -= 1;
  }
}

function loadDescriptor(root, entry) {
  const tree = new protobuf.Root(), sources = new Map(), visiting = new Set();
  let totalBytes = 0;
  const validPath = (path) => typeof path === "string" && path.length > 0 && path.length <= 4096
    && !isAbsolute(path) && !/[\0\\:]/.test(path) && path.endsWith(".proto");
  if (!validPath(entry)) throw invalidDescriptor();
  function load(path, depth) {
    if (visiting.has(path) || depth > GRPC_LIMITS.importDepth) throw invalidDescriptor();
    if (sources.has(path)) return;
    if (sources.size >= GRPC_LIMITS.files) throw invalidDescriptor();
    const bytes = safeFile(root, path);
    totalBytes += bytes.length;
    if (totalBytes > GRPC_LIMITS.descriptorBytes) throw invalidDescriptor();
    const text = bytes.toString("utf8");
    boundedProto(text);
    sources.set(path, bytes);
    visiting.add(path);
    const parsed = protobuf.parse(text, tree, { keepCase: true });
    for (const imported of [...(parsed.imports ?? []), ...(parsed.weakImports ?? [])]) {
      if (!validPath(imported)) throw invalidDescriptor();
      // Protobuf projects commonly import from the project include root; a
      // sibling-relative file is also accepted. Both candidates stay bounded.
      const local = resolve(dirname(path), imported), fromRoot = resolve(root, imported);
      let next = local;
      try { lstatSync(local); }
      catch (error) { if (error.code !== "ENOENT") throw error; next = fromRoot; }
      load(next, depth + 1);
    }
    visiting.delete(path);
  }
  load(resolve(root, entry), 0);
  tree.resolveAll();
  // protobufjs enum maps use a custom prototype; normalize its own descriptor
  // output before applying the same plain-JSON bounds used at the boundary.
  const json = JSON.parse(JSON.stringify(tree.toJSON()));
  boundedJson(json, GRPC_LIMITS.descriptorBytes * 4);
  const digest = createHash("sha256");
  for (const [path, bytes] of [...sources].sort(([a], [b]) => a.localeCompare(b)))
    digest.update(JSON.stringify([relative(root, path).split(sep).join("/"), bytes.toString("base64")]));
  return { tree, definitions: protoLoader.fromJSON(json, JSON_OPTIONS), digest: `sha256:${digest.digest("hex")}` };
}

// Reject unknown fields and unsafe coercions before dispatch. Numeric strings
// are supported for 64-bit fields; bytes use base64 and enums accept names.
function checkMessage(type, input) {
  if (!object(input)) throw invalidMessage();
  const scalar = (field, value) => {
    if (field.resolvedType instanceof protobuf.Type) { checkMessage(field.resolvedType, value); return; }
    if (field.resolvedType instanceof protobuf.Enum) {
      if ((typeof value === "string" && own(field.resolvedType.values, value)) ||
          (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647)) return;
      throw invalidMessage();
    }
    if (field.type === "string" && typeof value === "string") return;
    if (field.type === "bool" && typeof value === "boolean") return;
    if (field.type === "bytes" && typeof value === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return;
    if (["double", "float"].includes(field.type) && typeof value === "number" && Number.isFinite(value)) return;
    if (["int32", "sint32", "sfixed32", "uint32", "fixed32"].includes(field.type)) {
      const unsigned = ["uint32", "fixed32"].includes(field.type);
      if (Number.isInteger(value) && value >= (unsigned ? 0 : -2147483648) && value <= (unsigned ? 4294967295 : 2147483647)) return;
    }
    if (["int64", "sint64", "sfixed64", "uint64", "fixed64"].includes(field.type)) {
      if ((typeof value === "string" && /^-?\d{1,20}$/.test(value)) || Number.isSafeInteger(value)) {
        const n = BigInt(value), unsigned = ["uint64", "fixed64"].includes(field.type);
        if (n >= (unsigned ? 0n : -(1n << 63n)) && n <= (unsigned ? (1n << 64n) - 1n : (1n << 63n) - 1n)) return;
      }
    }
    throw invalidMessage();
  };
  for (const [name, value] of Object.entries(input)) {
    if (!own(type.fields, name)) throw invalidMessage();
    if (value === null) continue;
    const field = type.fields[name];
    if (field.map) {
      if (!object(value)) throw invalidMessage();
      for (const item of Object.values(value)) scalar(field, item);
    } else if (field.repeated) {
      if (!Array.isArray(value)) throw invalidMessage();
      for (const item of value) scalar(field, item);
    } else scalar(field, value);
  }
  const message = type.fromObject(input);
  if (type.verify(message)) throw invalidMessage();
  return type.toObject(message, JSON_OPTIONS);
}

function metadataFor(headers) {
  const metadata = new grpc.Metadata();
  if (!object(headers) || Object.keys(headers).length > 64) throw failure("GRPC_METADATA_INVALID", "The gRPC metadata is invalid or exceeds its limit.");
  let size = 0, credentialHeaders = false;
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    credentialHeaders ||= SECRET_HEADERS.test(name) || CREDENTIAL_SHAPED_HEADER.test(name);
    if (!/^[a-z0-9_.-]+$/.test(name) || name.startsWith("grpc-") || name === "host" || typeof value !== "string")
      throw failure("GRPC_METADATA_INVALID", "The gRPC metadata is invalid or exceeds its limit.");
    size += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (size > 16 * 1024) throw failure("GRPC_METADATA_INVALID", "The gRPC metadata is invalid or exceeds its limit.");
    try {
      if (name.endsWith("-bin") && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error();
      metadata.set(name, name.endsWith("-bin") ? Buffer.from(value, "base64") : value);
    } catch { throw failure("GRPC_METADATA_INVALID", "The gRPC metadata is invalid or exceeds its limit."); }
  }
  return { metadata, credentialHeaders };
}

export async function prepareGrpc(request, { root = process.cwd() } = {}) {
  const spec = request?.grpc;
  if (!object(spec) || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(spec.service ?? "") ||
      !/^[A-Za-z_]\w*$/.test(spec.method ?? ""))
    throw failure("GRPC_REQUEST_INVALID", "Choose a project proto file, declared gRPC service, and method.");
  const maxMessages = spec.max_messages ?? GRPC_LIMITS.defaultMessages;
  if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > GRPC_LIMITS.maxMessages) throw messageLimit();
  const effect = spec.effect === undefined ? "unknown" : spec.effect;
  if (!["read", "write", "unknown"].includes(effect))
    throw failure("GRPC_REQUEST_INVALID", "grpc.effect must be read, write, or unknown.");
  const timeoutMs = request.timeout_ms ?? GRPC_LIMITS.deadlineMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    throw failure("GRPC_REQUEST_INVALID", "The gRPC timeout must be an integer from 1 to 300000 milliseconds.");
  let descriptor, method, requestType;
  try {
    root = realpathSync(root);
    descriptor = loadDescriptor(root, spec.proto);
    const service = descriptor.definitions[spec.service];
    method = service && own(service, spec.method) ? service[spec.method] : null;
    const reflected = descriptor.tree.lookupService(spec.service).methods[spec.method];
    if (!method?.path || !reflected) throw invalidDescriptor();
    requestType = reflected.resolvedRequestType;
  } catch { throw invalidDescriptor(); }
  if ((method.requestStream && (!Array.isArray(spec.messages) || own(spec, "body"))) ||
      (!method.requestStream && own(spec, "messages")))
    throw failure("GRPC_REQUEST_INVALID", "Unary requests use body; client and bidirectional streams use a bounded messages array.");
  const inputs = method.requestStream ? spec.messages : [spec.body ?? {}];
  if (inputs.length > maxMessages) throw messageLimit();
  let totalBytes = 0;
  const messages = inputs.map((input) => {
    totalBytes += Buffer.byteLength(boundedJson(input));
    if (totalBytes > GRPC_LIMITS.totalMessageBytes) throw messageLimit();
    let message;
    try { message = checkMessage(requestType, input); }
    catch { throw invalidMessage(); }
    if (method.requestSerialize(message).length > GRPC_LIMITS.messageBytes) throw messageLimit();
    return message;
  });
  const operation = `GRPC ${method.path}`;
  return {
    operation, effect, contractDigest: descriptor.digest,
    declaration: { protocol: "grpc", source: { kind: "proto", file: spec.proto },
      service: spec.service, method: spec.method, requestStream: method.requestStream,
      responseStream: method.responseStream, reflection: false,
      effectBasis: spec.effect === undefined ? "unknown" : "caller-declared-unverified",
      requestValidated: true, responseValidated: true,
      responseValidation: "Decoded using the selected protobuf response type; this does not verify application behavior.",
      sentMeaning: "Messages submitted to the local gRPC transport; delivery is not acknowledged." },
    async execute({ url, headers = {}, hasCredentials = false, signal, onAttempt = () => {} }) {
      const base = { status: null, ok: false, body: method.responseStream ? [] : null,
        outcome: "error", complete: false, sent: 0, received: 0 };
      if (!(url instanceof URL) || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
        return { ...base, error: { code: "GRPC_TARGET_INVALID", message: "gRPC requires a configured HTTP or HTTPS authority with a root path and no URL credentials or query parameters." } };
      let metadata, credentialHeaders;
      try { ({ metadata, credentialHeaders } = metadataFor(headers)); }
      catch { return { ...base, error: { code: "GRPC_METADATA_INVALID",
        message: "The gRPC metadata is invalid or exceeds its limit." } }; }
      // Configured auth may use an arbitrary header name, so the public client
      // also supplies credential presence without passing another value copy.
      // URL has already canonicalized numeric hosts; only actual loopback
      // authorities qualify, never container aliases or wildcard addresses.
      const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname);
      if (url.protocol === "http:" && !loopback && (hasCredentials || credentialHeaders))
        return { ...base, error: { code: "GRPC_INSECURE_CREDENTIALS",
          message: "Credentials require an HTTPS gRPC authority outside loopback; the insecure request was not sent." } };
      const cancelled = () => signal?.reason?.name === "TimeoutError"
        ? { outcome: "timeout", error: { code: "GRPC_TIMEOUT", message: "The gRPC request reached its deadline." } }
        : { outcome: "cancelled", error: { code: "GRPC_CANCELLED", message: "The gRPC request was cancelled." } };
      if (signal?.aborted) return { ...base, ...cancelled() };
      const target = `${url.hostname}:${url.port || (url.protocol === "https:" ? 443 : 80)}`;
      const client = new grpc.Client(target, url.protocol === "https:" ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(), {
        "grpc.enable_retries": 0, "grpc.service_config_disable_resolution": 1,
        "grpc.enable_http_proxy": 0, "grpc.use_local_subchannel_pool": 1,
        "grpc.max_send_message_length": GRPC_LIMITS.messageBytes,
        "grpc.max_receive_message_length": GRPC_LIMITS.messageBytes,
      });
      return new Promise((resolveResult) => {
        let call, done = false, receivedBytes = 0, callbackError = null, requestEnded = !method.requestStream;
        const result = { ...base };
        const finish = (extra) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          client.close();
          resolveResult({ ...result, ...extra });
        };
        const stop = (extra) => { finish(extra); call?.cancel(); };
        const abort = () => stop(cancelled());
        const timer = setTimeout(() => stop({ outcome: "timeout", error: { code: "GRPC_TIMEOUT", message: "The gRPC request reached its deadline." } }), timeoutMs);
        signal?.addEventListener("abort", abort, { once: true });
        const accept = (message) => {
          if (done) return;
          result.received += 1;
          if (method.responseStream && result.received > maxMessages) {
            stop({ outcome: "partial", omissions: ["Additional stream messages were omitted after the configured message limit."],
              error: { code: "GRPC_MESSAGE_LIMIT", message: "The gRPC stream exceeded the configured message limit." } });
            return;
          }
          try {
            const json = boundedJson(message);
            receivedBytes += Buffer.byteLength(json);
            if (receivedBytes > GRPC_LIMITS.totalMessageBytes) throw messageLimit();
            const clean = JSON.parse(json);
            if (method.responseStream) result.body.push(clean); else result.body = clean;
          } catch {
            stop({ outcome: result.body && (method.responseStream ? result.body.length : true) ? "partial" : "incomplete",
              omissions: ["A response message exceeded the supported JSON size or depth limit and was omitted."],
              error: { code: "GRPC_MESSAGE_LIMIT", message: "The gRPC response exceeded a message limit." } });
          }
        };
        const callback = (error, message) => { callbackError = error; if (!error) accept(message); };
        const options = { deadline: Date.now() + timeoutMs };
        try {
          if (signal?.aborted) { abort(); return; }
          onAttempt();
          if (method.requestStream) {
            call = method.responseStream
              ? client.makeBidiStreamRequest(method.path, method.requestSerialize, method.responseDeserialize, metadata, options)
              : client.makeClientStreamRequest(method.path, method.requestSerialize, method.responseDeserialize, metadata, options, callback);
          } else {
            result.sent = 1;
            call = method.responseStream
              ? client.makeServerStreamRequest(method.path, method.requestSerialize, method.responseDeserialize, messages[0], metadata, options)
              : client.makeUnaryRequest(method.path, method.requestSerialize, method.responseDeserialize, messages[0], metadata, options, callback);
          }
          call.on("error", () => { /* Status is authoritative; raw details/metadata remain private. */ });
          if (method.responseStream) call.on("data", accept);
          call.on("status", (status) => {
            if (done) return;
            const code = callbackError?.code ?? status.code;
            if (code === grpc.status.OK) {
              if (!requestEnded) finish({ outcome: "incomplete", protocolStatus: code,
                omissions: ["The server completed before all supplied request messages were written and the client stream ended."],
                error: { code: "GRPC_SEND_INCOMPLETE", message: "The server completed before the client finished its request stream." } });
              else finish({ ok: true, complete: true, outcome: "success", protocolStatus: code });
            } else {
              const outcome = code === grpc.status.DEADLINE_EXCEEDED ? "timeout"
                : code === grpc.status.CANCELLED ? "cancelled" : result.received ? "partial" : "error";
              finish({ outcome, protocolStatus: code,
                error: { code: outcome === "timeout" ? "GRPC_TIMEOUT" : outcome === "cancelled" ? "GRPC_CANCELLED" : "GRPC_STATUS_ERROR",
                  message: "The gRPC request did not finish with a successful terminal status." } });
            }
          });
          if (method.requestStream) void (async () => {
            for (const message of messages) {
              if (done) return;
              result.sent += 1;
              const wrote = await new Promise((resolveWrite) => call.write(message, (error) => resolveWrite(!error)));
              if (!wrote || done) return;
            }
            if (!done) { requestEnded = true; call.end(); }
          })().catch(() => stop({ error: { code: "GRPC_TRANSPORT_ERROR", message: "The gRPC stream could not be sent." } }));
        } catch {
          stop({ error: { code: "GRPC_TRANSPORT_ERROR", message: "The gRPC request could not be dispatched." } });
        }
      });
    },
  };
}
