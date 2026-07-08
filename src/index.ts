#!/usr/bin/env node

/**
 * Argosvix MCP server entry point。
 *
 * AI agent (= Claude Desktop / Cursor / Codex CLI 等) から Argosvix の
 * traces / cost / alert を 直接 query するための Model Context Protocol server。
 *
 * Phase 1 (= 2026-05): stdio transport + read-only tools 3 件
 * Phase 2 (= 完了): 書き込み tools (= silence_alert / unsilence_alert)
 * Phase 3 (= 完了): create_alert + read tools 2 件 (get_alert / list_alert_events)
 *                   + HTTP transport (= 本ファイル + http.ts、 2026-05-31)
 *
 * 起動モード:
 *   - stdio (= default):  argosvix-mcp
 *       Claude Desktop / Cursor / Codex CLI が subprocess として spawn する想定。
 *       ARGOSVIX_API_KEY env var が必須。
 *   - HTTP transport:     argosvix-mcp --http
 *       remote MCP server として port (default 3000) で listen。 認証は各 request の
 *       Authorization: Bearer header から。 multi-tenant 用途、 self-host 用。
 *       env: MCP_HTTP_PORT / MCP_HTTP_HOST / MCP_HTTP_ALLOWED_HOSTS。
 *
 * stdio install + use (= Claude Desktop の場合):
 *   1. npm install -g @argosvix/mcp-server
 *   2. Claude Desktop config (= `~/Library/Application Support/Claude/claude_desktop_config.json`)
 *      に 以下を追記:
 *      {
 *        "mcpServers": {
 *          "argosvix": {
 *            "command": "argosvix-mcp",
 *            "env": { "ARGOSVIX_API_KEY": "argk_..." }
 *          }
 *        }
 *      }
 *   3. Claude Desktop 再起動 → tools として 自動認識される
 *
 * HTTP install + use:
 *   1. npm install -g @argosvix/mcp-server (= 同パッケージ)
 *   2. argosvix-mcp --http  # localhost:3000/mcp で listen
 *   3. client は POST /mcp に Authorization: Bearer <key> + JSON-RPC body
 */

const argv = process.argv.slice(2);
// Codex LOW 5 fix: --http のみ受理 (= サブコマンド形式 `argosvix-mcp http` の曖昧
// 判定を撤廃、 将来の引数追加と衝突しないように)
const useHttp = argv.includes("--http");

if (useHttp) {
  const { runHttp } = await import("./http.js");
  await runHttp();
} else {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    ReadResourceRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
    ErrorCode,
    McpError,
  } = await import("@modelcontextprotocol/sdk/types.js");
  const { dispatchTool, resolveToolProfile, toolsForProfile } = await import(
    "./tools.js"
  );
  const {
    resolveMcpLang,
    localizeTools,
    localizeResources,
    localizeResourceTemplates,
    localizePrompts,
  } = await import("./toolDescriptionsEn.js");
  const {
    resources,
    resourceTemplates,
    readResource,
    ResourceNotFoundError,
  } = await import("./resources.js");
  const { prompts, getPrompt, PromptNotFoundError } = await import(
    "./prompts.js"
  );
  const { setupSubscribe } = await import("./subscriptions.js");
  const { MCP_VERSION } = await import("./version.js");

  const API_KEY = process.env["ARGOSVIX_API_KEY"];
  const API_BASE =
    process.env["ARGOSVIX_API_BASE"] ?? "https://ingest.argosvix.com";
  // ARGOSVIX_MCP_PROFILE=core = 日常運用の要点 11 ツールだけを公開(コンテキスト節約)。
  const PROFILE = resolveToolProfile(process.env["ARGOSVIX_MCP_PROFILE"]);
  // ARGOSVIX_MCP_LANG = tool / resource / prompt 説明の言語。 未設定・不明値は en
  // (= 国際標準)。 ja を明示すると正本の日本語 description をそのまま返す。
  const LANG = resolveMcpLang(process.env["ARGOSVIX_MCP_LANG"]);
  const activeTools = localizeTools(toolsForProfile(PROFILE), LANG);
  const activeToolNames = new Set(activeTools.map((t) => t.name));

  if (!API_KEY) {
    // eslint-disable-next-line no-console
    console.error(
      "[argosvix-mcp] ARGOSVIX_API_KEY env var is required for stdio mode. " +
        "Get a key at https://dashboard.argosvix.com/api-keys " +
        "(use --http flag for HTTP transport with per-request auth)",
    );
    process.exit(1);
  }

  const server = new Server(
    {
      name: "argosvix",
      version: MCP_VERSION,
    },
    {
      capabilities: {
        tools: {},
        // v0.10.0-alpha.1 = stdio transport 限定で resources.subscribe を carry。
        // polling 60 秒 で 3 static resources (= account / alerts/active /
        // cost/today) の hash 比較で 変化検出 → notifications/resources/updated。
        // HTTP transport (= packages/mcp-server/src/http.ts) では per-request
        // stateless なので subscribe declare せず、 setupSubscribe も呼ばない。
        resources: { subscribe: true },
        prompts: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: activeTools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!activeToolNames.has(name)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `tool "${name}" is not available in the "${PROFILE}" profile ` +
          `(set ARGOSVIX_MCP_PROFILE=full to enable all tools)`,
      );
    }
    return dispatchTool({
      name,
      args: args ?? {},
      apiKey: API_KEY,
      apiBase: API_BASE,
    });
  });

  // resources / prompts の一覧 description も LANG に追従 (= read 本体は言語非依存)。
  const localizedResources = localizeResources(resources, LANG);
  const localizedResourceTemplates = localizeResourceTemplates(
    resourceTemplates,
    LANG,
  );
  const localizedPrompts = localizePrompts(prompts, LANG);

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: localizedResources,
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: localizedResourceTemplates,
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    try {
      return await readResource({
        uri: request.params.uri,
        apiKey: API_KEY,
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
    prompts: localizedPrompts,
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

  const subscribeManager = setupSubscribe({
    server,
    apiKey: API_KEY,
    apiBase: API_BASE,
  });

  const handleShutdown = (): void => {
    subscribeManager.shutdown();
  };
  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);
  process.on("beforeExit", handleShutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error(
    `[argosvix-mcp] argosvix@${MCP_VERSION} ready on stdio transport (subscribe: 3 resources, poll 60s)`,
  );
}
