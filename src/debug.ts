/**
 * DEBUG env gate for the stderr raw-body log (added in v0.9.2).
 *
 * The MCP server logs the raw body of backend error responses to stderr, but
 * leaving sensitive information (backend internal messages, user-supplied tags,
 * internal IDs) in production log aggregators is not ideal. Instead, operators
 * explicitly opt in only when needed (e.g. during a debug session).
 *
 * Usage:
 *   ARGOSVIX_MCP_DEBUG=1 argosvix-mcp                      # raw body shown in stdio mode
 *   ARGOSVIX_MCP_DEBUG=1 argosvix-mcp --http               # same for HTTP mode
 *
 * Default (env unset): the body is omitted and only status + path + requestId are logged.
 */
export function isDebugEnabled(): boolean {
  return process.env["ARGOSVIX_MCP_DEBUG"] === "1";
}
