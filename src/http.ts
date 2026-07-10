/**
 * HTTP transport entry for the Argosvix MCP server (remote MCP server).
 *
 * Uses `StreamableHTTPServerTransport` from @modelcontextprotocol/sdk
 * (Streamable HTTP, the modern MCP spec) in stateless mode, treating each
 * request as its own MCP session. Unlike stdio mode, credentials come from
 * each request's `Authorization: Bearer <key>` header instead of the
 * ARGOSVIX_API_KEY env var.
 *
 * Startup:
 *   argosvix-mcp --http
 *   # Options:
 *   MCP_HTTP_PORT=4000 MCP_HTTP_HOST=0.0.0.0 \
 *   MCP_HTTP_ALLOWED_HOSTS=mcp.example.com \
 *   MCP_HTTP_ALLOWED_ORIGINS=https://app.example.com \
 *     argosvix-mcp --http
 *
 * Client example (sending MCP messages directly as JSON-RPC):
 *   curl -X POST http://localhost:3000/mcp \
 *     -H "Authorization: Bearer argk_..." \
 *     -H "Content-Type: application/json" \
 *     -H "Accept: application/json, text/event-stream" \
 *     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
 *
 * Security design:
 *   - On localhost binds (127.0.0.1 / localhost / ::1) the Host header is
 *     strictly validated against a localhost allow list (DNS rebinding defense).
 *   - On non-local binds (0.0.0.0 etc.) MCP_HTTP_ALLOWED_HOSTS must be set
 *     explicitly (fail-closed); if unset, a startup warning is printed and all
 *     requests are rejected with 403.
 *   - CORS uses an allow list via MCP_HTTP_ALLOWED_ORIGINS ('*' is never used).
 *     When unset, localhost binds allow only localhost origins; otherwise no
 *     CORS headers are returned, blocking browser-based access.
 *   - Shutdown uses connection tracking plus a grace-period timeout so the
 *     server terminates reliably even with lingering keep-alive / SSE
 *     connections; repeated SIGTERM/SIGINT is limited to one run via a flag.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { dispatchTool, resolveToolProfile, toolsForProfile } from "./tools.js";
import {
  resolveMcpLang,
  localizeTools,
  localizeResources,
  localizeResourceTemplates,
  localizePrompts,
} from "./toolDescriptionsEn.js";
import {
  resources,
  resourceTemplates,
  readResource,
  ResourceNotFoundError,
} from "./resources.js";
import { prompts, getPrompt, PromptNotFoundError } from "./prompts.js";
import { MCP_VERSION } from "./version.js";

const SERVER_NAME = "argosvix";
const SERVER_VERSION = MCP_VERSION;

const API_BASE =
  process.env["ARGOSVIX_API_BASE"] ?? "https://ingest.argosvix.com";
const PORT = Number.parseInt(process.env["MCP_HTTP_PORT"] ?? "3000", 10);
const HOST = process.env["MCP_HTTP_HOST"] ?? "127.0.0.1";

// Prevents memory exhaustion from oversized bodies. Normal MCP messages are
// well under a few KB.
const MAX_BODY_BYTES = 1_048_576; // 1 MiB
// Grace period for graceful shutdown (time to wait for keep-alive / SSE
// connections to close naturally).
const SHUTDOWN_GRACE_MS = 10_000;

// Localhost-bind check (the boundary that limits the relaxed defaults for DNS
// rebinding / CORS to local binds only).
const isLocalBind =
  HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";

// Host header allow list (stored lowercased so comparisons are case-insensitive).
const DEFAULT_LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  `localhost:${PORT}`,
  `127.0.0.1:${PORT}`,
  "[::1]",
  `[::1]:${PORT}`,
]);
const allowedHostsEnv = process.env["MCP_HTTP_ALLOWED_HOSTS"];
const allowedHosts = allowedHostsEnv
  ? new Set(
      allowedHostsEnv
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    )
  : DEFAULT_LOCAL_HOSTS;

// CORS Origin allow list ('*' is never used; explicit allowlist only).
const allowedOriginsEnv = process.env["MCP_HTTP_ALLOWED_ORIGINS"];
const allowedOrigins = allowedOriginsEnv
  ? new Set(
      allowedOriginsEnv
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    )
  : null;

// Default CORS check for localhost binds when MCP_HTTP_ALLOWED_ORIGINS is
// unset: only localhost origins are allowed.
const LOCALHOST_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function extractBearer(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (typeof auth !== "string") return null;
  const m = /^Bearer\s+(\S+)$/.exec(auth);
  return m?.[1] ?? null;
}

/**
 * Host header check (fail-closed).
 *   - localhost bind: default allow list (DNS rebinding defense), overridable
 *     via user configuration
 *   - non-local bind: MCP_HTTP_ALLOWED_HOSTS must be set explicitly (all
 *     requests are rejected when unset)
 */
function checkHost(req: IncomingMessage): boolean {
  const host = req.headers["host"];
  if (typeof host !== "string") return false;
  if (!isLocalBind && !allowedHostsEnv) {
    // Non-local bind with allowed hosts unset: a warning was printed at
    // startup; reject everything (fail-closed).
    return false;
  }
  return allowedHosts.has(host.toLowerCase());
}

/**
 * CORS header computation (no '*' wildcard).
 *   - Vary: Origin is always set (makes proxies / caches origin-aware)
 *   - Access-Control-Allow-Origin is set only on an allowlist hit; there are
 *     no auth cookies, so Allow-Credentials is unnecessary (auth is
 *     per-request via the Bearer header)
 *   - Non-browser requests with a mismatched or missing origin pass through
 *     unchanged (outside the scope of CORS)
 */
function corsHeadersFor(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, mcp-session-id, mcp-protocol-version, last-event-id",
    "Access-Control-Expose-Headers":
      "mcp-session-id, mcp-protocol-version",
    "Access-Control-Max-Age": "86400",
  };
  const origin = req.headers["origin"];
  if (typeof origin !== "string" || origin.length === 0) return headers;
  let allowed = false;
  if (allowedOrigins !== null) {
    allowed = allowedOrigins.has(origin);
  } else if (isLocalBind) {
    // Localhost bind with no configuration: only localhost origins are
    // allowed by default.
    allowed = LOCALHOST_ORIGIN_PATTERN.test(origin);
  }
  if (allowed) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function applyCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const headers = corsHeadersFor(req);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
}

// Allow sets and helper for strict CORS preflight validation. Keeps the same
// allow policy as corsHeadersFor() in a single source of truth.
const ALLOWED_METHODS_SET = new Set([
  "POST",
  "GET",
  "DELETE",
  "OPTIONS",
]);
const ALLOWED_HEADERS_SET = new Set([
  "authorization",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
]);

function isOriginAllowed(origin: string): boolean {
  if (origin.length === 0) return false;
  if (allowedOrigins !== null) return allowedOrigins.has(origin);
  if (isLocalBind) return LOCALHOST_ORIGIN_PATTERN.test(origin);
  return false;
}

function isPreflightAllowed(req: IncomingMessage): boolean {
  const origin = req.headers["origin"];
  if (typeof origin !== "string" || !isOriginAllowed(origin)) return false;

  // The spec requires Access-Control-Request-Method on preflight requests, so
  // a missing or empty value is also strictly rejected (no undershoot left).
  const reqMethod = req.headers["access-control-request-method"];
  if (typeof reqMethod !== "string" || reqMethod.trim().length === 0) {
    return false;
  }
  if (!ALLOWED_METHODS_SET.has(reqMethod.trim().toUpperCase())) return false;

  const reqHeaders = req.headers["access-control-request-headers"];
  if (typeof reqHeaders === "string" && reqHeaders.length > 0) {
    const requested = reqHeaders
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
    for (const h of requested) {
      if (!ALLOWED_HEADERS_SET.has(h)) return false;
    }
  }
  return true;
}

async function readBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk as Buffer);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error(`request body too large (max ${maxBytes} bytes)`);
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("invalid JSON body");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

// ARGOSVIX_MCP_PROFILE=core exposes only the 11 essential day-to-day tools
// (same convention as stdio).
const HTTP_PROFILE = resolveToolProfile(process.env["ARGOSVIX_MCP_PROFILE"]);
// ARGOSVIX_MCP_LANG = description language (same convention as stdio; unset or
// unknown values fall back to en).
const HTTP_LANG = resolveMcpLang(process.env["ARGOSVIX_MCP_LANG"]);
const httpActiveTools = localizeTools(toolsForProfile(HTTP_PROFILE), HTTP_LANG);
const httpActiveToolNames = new Set(httpActiveTools.map((t) => t.name));
const httpResources = localizeResources(resources, HTTP_LANG);
const httpResourceTemplates = localizeResourceTemplates(
  resourceTemplates,
  HTTP_LANG,
);
const httpPrompts = localizePrompts(prompts, HTTP_LANG);

function createPerRequestServer(apiKey: string): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: httpActiveTools,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!httpActiveToolNames.has(request.params.name)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `tool "${request.params.name}" is not available in the "${HTTP_PROFILE}" profile ` +
          `(set ARGOSVIX_MCP_PROFILE=full to enable all tools)`,
      );
    }
    return dispatchTool({
      name: request.params.name,
      args: request.params.arguments ?? {},
      apiKey,
      apiBase: API_BASE,
    });
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: httpResources,
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: httpResourceTemplates,
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    try {
      return await readResource({
        uri: request.params.uri,
        apiKey,
        apiBase: API_BASE,
      });
    } catch (err) {
      if (err instanceof ResourceNotFoundError) {
        throw new McpError(ErrorCode.InvalidParams, err.message, {
          uri: err.uri,
        });
      }
      throw new McpError(
        ErrorCode.InternalError,
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: httpPrompts,
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    try {
      return getPrompt({
        name: request.params.name,
        args: (request.params.arguments ?? {}) as Record<string, unknown>,
      });
    } catch (err) {
      if (err instanceof PromptNotFoundError) {
        throw new McpError(ErrorCode.InvalidParams, err.message, {
          name: err.promptName,
        });
      }
      throw new McpError(
        ErrorCode.InternalError,
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  return server;
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // 1) Host check (fail-closed for non-local binds)
  if (!checkHost(req)) {
    sendJson(res, 403, { error: "host header not allowed" });
    return;
  }

  // 2) Bearer authentication
  const apiKey = extractBearer(req);
  if (!apiKey) {
    // RFC 6750: communicate the how-to via the WWW-Authenticate header
    if (!res.headersSent) {
      res.setHeader(
        "WWW-Authenticate",
        'Bearer realm="argosvix-mcp", error="invalid_request"',
      );
    }
    sendJson(res, 401, {
      error: "missing or malformed Authorization: Bearer <api-key>",
    });
    return;
  }

  // 3) For POST, parse the body and hand it to the transport (the SDK's
  //    recommended pattern)
  let parsedBody: unknown = undefined;
  if (req.method === "POST") {
    try {
      parsedBody = await readBody(req, MAX_BODY_BYTES);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "request body parse error";
      const status = /too large/i.test(message) ? 413 : 400;
      sendJson(res, status, { error: message });
      return;
    }
  }

  // 4) per-request server + transport (stateless = sessionIdGenerator undefined)
  const server = createPerRequestServer(apiKey);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[argosvix-mcp/http] request error:", err);
    sendJson(res, 500, { error: "internal server error" });
  } finally {
    try {
      await transport.close();
    } catch {
      // ignore
    }
  }
}

export async function runHttp(): Promise<void> {
  if (!isLocalBind && !allowedHostsEnv) {
    // Explicit warning at startup (all requests will get 403)
    // eslint-disable-next-line no-console
    console.error(
      `[argosvix-mcp] WARNING: HOST=${HOST} is non-local but MCP_HTTP_ALLOWED_HOSTS is not set. ` +
        "All requests will be rejected with 403. Set MCP_HTTP_ALLOWED_HOSTS=host1,host2,... to accept.",
    );
  }

  // Once shutdown begins, new requests arriving over keep-alive connections
  // get 503, structurally closing the race where work continues during drain.
  // The flag lives at the top of runHttp because both the handler and
  // shutdown reference it.
  let isShuttingDown = false;

  const httpServer = createServer((req, res) => {
    if (isShuttingDown) {
      res.setHeader("Connection", "close");
      sendJson(res, 503, { error: "server is shutting down" });
      return;
    }

    applyCorsHeaders(req, res);

    if (req.method === "OPTIONS") {
      // Strict CORS preflight: explicitly reject with 403 when the Origin is
      // not allowed, or the requested method or headers fall outside the
      // allowlist.
      if (!isPreflightAllowed(req)) {
        sendJson(res, 403, { error: "cors preflight rejected" });
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    const path = req.url?.split("?")[0] ?? "/";

    if (path === "/health") {
      sendJson(res, 200, {
        status: "ok",
        name: SERVER_NAME,
        version: SERVER_VERSION,
      });
      return;
    }

    if (path === "/mcp") {
      void handleMcpRequest(req, res).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[argosvix-mcp/http] unhandled error:", err);
        sendJson(res, 500, { error: "internal server error" });
      });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  });

  // Track sockets so shutdown has a force-close path.
  const openSockets = new Set<Socket>();
  httpServer.on("connection", (socket) => {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
  });

  // Propagate listen() errors into a Promise rejection.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      // eslint-disable-next-line no-console
      console.error(
        `[argosvix-mcp] HTTP server failed to listen on ${HOST}:${PORT}: ${err.code ?? ""} ${err.message}`,
      );
      reject(err);
    };
    httpServer.once("error", onError);
    httpServer.listen(PORT, HOST, () => {
      httpServer.off("error", onError);
      // Keep a permanent handler for error events that occur after a
      // successful listen, preventing the process-crash path (unhandled error
      // -> uncaught exception -> immediate exit). Attempt shutdown on serious
      // errors.
      httpServer.on("error", (err: NodeJS.ErrnoException) => {
        // eslint-disable-next-line no-console
        console.error("[argosvix-mcp] http server error event:", err);
        if (!isShuttingDown) shutdown(`error:${err.code ?? "unknown"}`);
      });
      // eslint-disable-next-line no-console
      console.error(
        `[argosvix-mcp] ${SERVER_NAME}@${SERVER_VERSION} HTTP transport ready on http://${HOST}:${PORT}/mcp`,
      );
      resolve();
    });
  });

  // Shutdown runs at most once via the flag; force-close after the grace period.
  const shutdown = (signal: string): void => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    // eslint-disable-next-line no-console
    console.error(`[argosvix-mcp] received ${signal}, shutting down...`);
    let exited = false;
    const exit = (code: number): void => {
      if (exited) return;
      exited = true;
      process.exit(code);
    };
    // Close idle keep-alive sockets immediately to speed up the drain
    // (Node 20+). Active sockets get the grace period.
    httpServer.closeIdleConnections?.();
    httpServer.close((err) => {
      if (err) {
        // eslint-disable-next-line no-console
        console.error("[argosvix-mcp] close error:", err);
        exit(1);
        return;
      }
      exit(0);
    });
    setTimeout(() => {
      // eslint-disable-next-line no-console
      console.error(
        `[argosvix-mcp] grace period (${SHUTDOWN_GRACE_MS}ms) expired, force closing ${openSockets.size} socket(s)`,
      );
      for (const s of openSockets) {
        try {
          s.destroy();
        } catch {
          // ignore
        }
      }
      exit(1);
    }, SHUTDOWN_GRACE_MS).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

// Allow standalone execution: `node dist/http.js`
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /http\.(c?js|mjs)$/.test(process.argv[1]);
if (invokedDirectly) {
  await runHttp();
}
