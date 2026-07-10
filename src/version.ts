/**
 * Single source of truth for the @argosvix/mcp-server version (extracted in
 * v0.4.0-alpha.1).
 *
 * Must match the `version` field in package.json exactly. This value is used
 * for Server({ version }) on both the stdio and HTTP transports, and for the
 * User-Agent header. Drift is guarded by the version drift test in
 * `tools.test.ts`, which compares against package.json.
 *
 * Release procedure:
 *   1. Update MCP_VERSION in this file
 *   2. Update `version` in packages/mcp-server/package.json to the same value
 *   3. Make `npm run build && npx vitest run` pass, then commit
 */

export const MCP_VERSION = "0.30.0-alpha.14" as const;
