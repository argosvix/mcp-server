/**
 * HTTP transport entry for Argosvix MCP server (Phase 3 = remote MCP server)。
 *
 * @modelcontextprotocol/sdk の `StreamableHTTPServerTransport` (= Streamable HTTP、
 * MCP の modern spec) を 使い、 stateless mode で 1 request = 1 MCP session として
 * carry。 stdio mode と異なり、 認証情報 (= ARGOSVIX_API_KEY) は env var ではなく
 * 各 request の `Authorization: Bearer <key>` header から取り出す。
 *
 * 起動:
 *   argosvix-mcp --http
 *   # オプション:
 *   MCP_HTTP_PORT=4000 MCP_HTTP_HOST=0.0.0.0 \
 *   MCP_HTTP_ALLOWED_HOSTS=mcp.example.com \
 *   MCP_HTTP_ALLOWED_ORIGINS=https://app.example.com \
 *     argosvix-mcp --http
 *
 * client 例 (= MCP message を JSON-RPC で 直接送る):
 *   curl -X POST http://localhost:3000/mcp \
 *     -H "Authorization: Bearer argk_..." \
 *     -H "Content-Type: application/json" \
 *     -H "Accept: application/json, text/event-stream" \
 *     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
 *
 * セキュリティ設計 (= Codex review fix carry):
 *   - localhost bind (= 127.0.0.1 / localhost / ::1) では Host header を localhost
 *     allow list で 厳密検証 (= DNS rebinding 防御)。
 *   - non-local bind (= 0.0.0.0 等) では MCP_HTTP_ALLOWED_HOSTS の明示設定を必須化
 *     (= fail-closed)、 未設定なら起動 warning + 全 request を 403 reject。
 *   - CORS は MCP_HTTP_ALLOWED_ORIGINS で allow list 化 (= '*' は使わない)、
 *     未設定時は localhost-bind なら localhost-origin のみ allow、 それ以外は CORS
 *     header を返さず browser 経由 access を block。
 *   - shutdown は connection tracking + grace period timeout で keep-alive / SSE が
 *     残っても確実に終了する設計、 SIGTERM/SIGINT 多重発火は flag で 1 回限定。
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

// 過大 body による メモリ枯渇防止。 通常の MCP message は 数 KB 未満。
const MAX_BODY_BYTES = 1_048_576; // 1 MiB
// graceful shutdown 用 grace period (= keep-alive / SSE の自然 close を待つ時間)
const SHUTDOWN_GRACE_MS = 10_000;

// localhost bind 判定 (= DNS rebinding / CORS の default 緩和を 限定する閾値)
const isLocalBind =
  HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";

// Host header allow list (= 比較時に大文字小文字 ignore するため格納時 toLowerCase)
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

// CORS Origin allow list (= '*' は使わない、 明示 allowlist 方式)
const allowedOriginsEnv = process.env["MCP_HTTP_ALLOWED_ORIGINS"];
const allowedOrigins = allowedOriginsEnv
  ? new Set(
      allowedOriginsEnv
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    )
  : null;

// localhost-bind かつ MCP_HTTP_ALLOWED_ORIGINS 未設定 のとき、 localhost origin
// だけを許可する default CORS 判定。
const LOCALHOST_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function extractBearer(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (typeof auth !== "string") return null;
  const m = /^Bearer\s+(\S+)$/.exec(auth);
  return m?.[1] ?? null;
}

/**
 * Host header check (Codex MEDIUM 3 fix = fail-closed)。
 *   - localhost bind: 既定 allow list (= DNS rebinding 防御)、 user 設定で上書き可
 *   - non-local bind: MCP_HTTP_ALLOWED_HOSTS の明示設定必須 (= 未設定なら全 reject)
 */
function checkHost(req: IncomingMessage): boolean {
  const host = req.headers["host"];
  if (typeof host !== "string") return false;
  if (!isLocalBind && !allowedHostsEnv) {
    // non-local bind + allowed hosts 未設定 = 起動時 warning 済、 全 reject で fail-closed
    return false;
  }
  return allowedHosts.has(host.toLowerCase());
}

/**
 * CORS header 計算 (Codex MEDIUM 2 fix = '*' 廃止)。
 *   - Vary: Origin は常に付与 (= proxy / cache の origin-aware 化)
 *   - Access-Control-Allow-Origin は allowlist hit 時のみ反映、 認証 cookie ないので
 *     Allow-Credentials は不要 (= Bearer header で per-request 認証)
 *   - origin 不一致 / 未指定の non-browser request はそのまま通過 (= CORS の制約外)
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
    // localhost bind + 設定なし = localhost 系 origin のみ default 許可
    allowed = LOCALHOST_ORIGIN_PATTERN.test(origin);
  }
  if (allowed) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function applyCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const headers = corsHeadersFor(req);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
}

// Codex round 2 MEDIUM 3 fix: CORS preflight 厳格化用の allow set + 判定 helper。
// corsHeadersFor() と同じ allow ポリシーを 1 箇所で source of truth 化する。
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

  // Codex round 3 LOW fix: preflight は仕様上 Access-Control-Request-Method 必須なので、
  // 未指定 / 空文字も 厳格 reject に carry する (= undershoot を 残さない)。
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

// ARGOSVIX_MCP_PROFILE=core = 日常運用の要点 11 ツールだけを公開(stdio と同じ規約)。
const HTTP_PROFILE = resolveToolProfile(process.env["ARGOSVIX_MCP_PROFILE"]);
// ARGOSVIX_MCP_LANG = 説明の言語 (stdio と同じ規約、 未設定・不明値は en)。
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
  // 1) Host check (Codex MEDIUM 3 fix = fail-closed for non-local bind)
  if (!checkHost(req)) {
    sendJson(res, 403, { error: "host header not allowed" });
    return;
  }

  // 2) Bearer 認証
  const apiKey = extractBearer(req);
  if (!apiKey) {
    // RFC 6750 = WWW-Authenticate header で how-to を伝える
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

  // 3) POST の場合 body を parse して transport に渡す (SDK の推奨 pattern)
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
    // Codex MEDIUM 3 fix: 起動時に明示警告 (= 全 request が 403 になる旨)
    // eslint-disable-next-line no-console
    console.error(
      `[argosvix-mcp] WARNING: HOST=${HOST} is non-local but MCP_HTTP_ALLOWED_HOSTS is not set. ` +
        "All requests will be rejected with 403. Set MCP_HTTP_ALLOWED_HOSTS=host1,host2,... to accept.",
    );
  }

  // Codex round 2 HIGH 1 fix: shutdown 開始後は keep-alive 経由の新規 request を 503
  // で返し、 drain 中に処理継続する race を 構造的に塞ぐ。 flag は handler / shutdown
  // 両方から参照するので runHttp の topmost に置く。
  let isShuttingDown = false;

  const httpServer = createServer((req, res) => {
    if (isShuttingDown) {
      res.setHeader("Connection", "close");
      sendJson(res, 503, { error: "server is shutting down" });
      return;
    }

    applyCorsHeaders(req, res);

    if (req.method === "OPTIONS") {
      // Codex round 2 MEDIUM 3 fix: CORS preflight 厳格化。 Origin 不許可 / 要求
      // method が allowlist 外 / 要求 header が allowlist 外 なら 403 で 明示拒否。
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

  // Codex HIGH 1 fix: socket tracking で shutdown 時の force close path を持つ
  const openSockets = new Set<Socket>();
  httpServer.on("connection", (socket) => {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
  });

  // Codex MEDIUM 4 fix: listen() の error を Promise reject に carry
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
      // Codex round 2 MEDIUM 2 fix: listen success 後に発生する error イベントを
      // 常設 handler で受け、 process crash 経路 (= 未処理 error → uncaught exception
      // → 即落ち) を防ぐ。 重大エラーなら shutdown を試みる。
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

  // Codex HIGH 1 fix: shutdown は flag で 1 度限定、 grace period 後 force close
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
    // Codex round 2 HIGH 1 fix 補足: idle keep-alive socket を即座に閉じて drain を
    // 早める (Node 20+)。 active socket は grace period で待つ。
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
