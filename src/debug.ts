/**
 * v0.9.2 = stderr raw body log の DEBUG env gate (= Codex v0.4.0 round 2 LOW 2 carry)。
 *
 * MCP server は backend error response の raw body を stderr に log するが、 production
 * log aggregator に 機微情報 (= backend internal message / user 投入 tag / 内部 ID) が
 * 残るのは ideal ではない。 operator が 必要時 (= debug session) に明示 opt-in する
 * 軸に carry する。
 *
 * 使い方:
 *   ARGOSVIX_MCP_DEBUG=1 argosvix-mcp                      # stdio mode で raw body 出る
 *   ARGOSVIX_MCP_DEBUG=1 argosvix-mcp --http               # HTTP mode 同じ
 *
 * default (= env unset) = body 不在で status + path + requestId のみ log carry。
 */
export function isDebugEnabled(): boolean {
  return process.env["ARGOSVIX_MCP_DEBUG"] === "1";
}
