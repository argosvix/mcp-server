#!/usr/bin/env node

/**
 * Argosvix MCP server entry point.
 *
 * A Model Context Protocol server that lets AI agents (Claude Desktop, Cursor,
 * Codex CLI, etc.) query Argosvix traces / cost / alerts directly.
 *
 * Startup modes:
 *   - stdio (default):  argosvix-mcp
 *       Intended to be spawned as a subprocess by Claude Desktop / Cursor /
 *       Codex CLI. Requires the ARGOSVIX_API_KEY env var.
 *   - HTTP transport:   argosvix-mcp --http
 *       Listens on a port (default 3000) as a remote MCP server. Auth comes
 *       from each request's Authorization: Bearer header. For multi-tenant and
 *       self-host use. Env: MCP_HTTP_PORT / MCP_HTTP_HOST / MCP_HTTP_ALLOWED_HOSTS.
 *
 * stdio install + use (Claude Desktop example):
 *   1. npm install -g @argosvix/mcp-server
 *   2. Add the following to the Claude Desktop config
 *      (`~/Library/Application Support/Claude/claude_desktop_config.json`):
 *      {
 *        "mcpServers": {
 *          "argosvix": {
 *            "command": "argosvix-mcp",
 *            "env": { "ARGOSVIX_API_KEY": "argk_..." }
 *          }
 *        }
 *      }
 *   3. Restart Claude Desktop; the tools are then picked up automatically.
 *
 * HTTP install + use:
 *   1. npm install -g @argosvix/mcp-server (same package)
 *   2. argosvix-mcp --http  # listens on localhost:3000/mcp
 *   3. Clients POST to /mcp with Authorization: Bearer <key> + a JSON-RPC body
 */

const argv = process.argv.slice(2);
// Only accept --http. The subcommand form `argosvix-mcp http` had ambiguous
// matching and was removed so it cannot collide with future arguments.
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
  // ARGOSVIX_MCP_PROFILE=core exposes only the 11 essential day-to-day tools
  // (saves context).
  const PROFILE = resolveToolProfile(process.env["ARGOSVIX_MCP_PROFILE"]);
  // ARGOSVIX_MCP_LANG = language for tool / resource / prompt descriptions.
  // Unset or unknown values fall back to en (the international default).
  // Setting ja explicitly returns the canonical Japanese descriptions as-is.
  const LANG = resolveMcpLang(process.env["ARGOSVIX_MCP_LANG"]);
  const activeTools = localizeTools(toolsForProfile(PROFILE), LANG);
  const activeToolNames = new Set(activeTools.map((t) => t.name));

  if (!API_KEY) {
    // Introspection-only mode: the server starts without a key. Needed both
    // for automated directory checks (keyless startup + tools/list response)
    // and for the first-time UX of "let me see the tool list before setting a
    // key". Only tool execution fails, via the CallTool guard below, with a
    // guidance message.
    // eslint-disable-next-line no-console
    console.error(
      "[argosvix-mcp] ARGOSVIX_API_KEY is not set — starting in introspection-only mode. " +
        "Tools are listed but calls will fail until you set ARGOSVIX_API_KEY. " +
        "Get a key at https://dashboard.argosvix.com/api-keys " +
        "(or use --http flag for HTTP transport with per-request auth)",
    );
  }

  const server = new Server(
    {
      name: "argosvix",
      version: MCP_VERSION,
    },
    {
      capabilities: {
        tools: {},
        // resources.subscribe is supported on the stdio transport only
        // (since v0.10.0-alpha.1). A 60-second poll hash-compares the 3 static
        // resources (account / alerts/active / cost/today) to detect changes
        // and emit notifications/resources/updated. The HTTP transport
        // (packages/mcp-server/src/http.ts) is stateless per request, so it
        // neither declares subscribe nor calls setupSubscribe.
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
    if (!API_KEY) {
      // Introspection-only mode: the list is visible but execution returns
      // key-setup guidance. Returned as an isError tool result rather than a
      // protocol error, so the LLM can relay the setup steps to the user
      // directly.
      return {
        content: [
          {
            type: "text",
            text:
              "ARGOSVIX_API_KEY is not set. Get an API key at " +
              "https://dashboard.argosvix.com/api-keys, add it to the env of this " +
              'MCP server config (e.g. "env": { "ARGOSVIX_API_KEY": "argk_..." }), ' +
              "then restart the MCP client.",
          },
        ],
        isError: true,
      };
    }
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

  // Resource / prompt list descriptions also follow LANG (the read payloads
  // themselves are language-independent).
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
        // In introspection-only mode the empty key reaches the API and the
        // 401 comes back as an explicit error (resource reads still require a
        // key).
        apiKey: API_KEY ?? "",
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
    apiKey: API_KEY ?? "",
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
