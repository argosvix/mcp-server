/**
 * @argosvix/mcp-server の version 単一 source-of-truth (= Codex round 2 LOW 2 fix、
 * v0.4.0-alpha.1 で 抽出)。
 *
 * package.json の `version` field と 完全一致させる。 stdio / http 両 transport の
 * Server({ version }) と User-Agent header に この値が carry される。 drift 防御は
 * `tools.test.ts` の version drift test (= package.json と 比較) で gate する。
 *
 * 改訂手順:
 *   1. 本 file の MCP_VERSION を更新
 *   2. packages/mcp-server/package.json の `version` も同 値に更新
 *   3. `npm run build && npx vitest run` を pass させてから commit
 */

export const MCP_VERSION = "0.30.0-alpha.14" as const;
