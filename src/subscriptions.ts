/**
 * MCP resources/subscribe 軽量 carry (= v0.10.0-alpha.1、 v0.8 backlog 倒し込み)。
 *
 * MCP spec の `resources.subscribe` capability を stdio transport で carry する。
 * client が `resources/subscribe` で URI を 登録すると、 polling cycle で 当該
 * resource の hash を 比較し、 変化を 検出した時に `notifications/resources/updated`
 * を send する。
 *
 * 対応 URI (= 3 static resources のみ、 resource templates = calls/{id} 等は対象外):
 *   - argosvix://account
 *   - argosvix://alerts/active
 *   - argosvix://cost/today
 *
 * 設計選択:
 *   - polling = 60 秒 interval (= backend 負荷と更新遅延の妥協点)
 *   - HTTP transport では setupSubscribe を call しない (= per-request stateless で
 *     subscription state が 持てない、 capabilities でも subscribe 宣言なし)
 *   - shutdown / 接続切断時 = polling timer stop + subscription set 全削除
 *   - subscription set は 単一 server instance 単位 (= stdio = 1 client 1 process)
 *   - fetch 失敗 (= 401 / network) は silent skip (= 次回 cycle で 再試行)、 hash は
 *     前回値 keep (= 「fetch 不可 = 変化なし」 と扱い 不要 notify 抑制)
 *   - hash = JSON.stringify + djb2-like rolling 32bit (= 軽量、 暗号目的ではない)
 *
 * Codex / 実装 backlog (= v0.10 では carry しない):
 *   - resource templates の per-id subscribe (= calls/{id} 等、 LLM が個別 call の
 *     更新を 監視する path)
 *   - listChanged notification (= resource list 自体は server lifecycle 内 固定で 不要)
 *   - WebSocket / SSE 経由の HTTP subscribe (= persistent connection 必要、 重い)
 *   - polling interval の env-driven 設定 (= MCP_SUBSCRIBE_POLL_MS で override 可能化)
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ErrorCode,
  McpError,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { isDebugEnabled } from "./debug.js";
import { readResource } from "./resources.js";

const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;
const SUBSCRIBABLE_URIS: ReadonlySet<string> = new Set([
  "argosvix://account",
  "argosvix://alerts/active",
  "argosvix://cost/today",
]);

interface SubscribeContext {
  server: Server;
  apiKey: string;
  apiBase: string;
  /** test 用 override (= 60 秒は long すぎるため unit test では小さい値で carry)。 */
  pollIntervalMs?: number;
}

/**
 * 軽量 32bit hash (= djb2 風)。 暗号目的ではなく、 等価判定の高速軸として carry。
 * 衝突確率は内容比較で十分低いが、 重大判定 (= 課金 / 認証) には使わない。
 */
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function resourceHash(contents: unknown): number {
  return hashString(JSON.stringify(contents));
}

export interface SubscribeManager {
  subscribe(uri: string): void;
  unsubscribe(uri: string): void;
  /** shutdown / 切断時 = polling 停止 + subscription set クリア。 */
  shutdown(): void;
  /** test 用 = polling cycle を 1 回 即時 trigger する。 */
  pollNow(): Promise<void>;
  /** test 用 = 現 subscription set snapshot。 */
  snapshot(): { uris: string[]; pollerActive: boolean };
}

export function setupSubscribe(ctx: SubscribeContext): SubscribeManager {
  const subscriptions = new Set<string>();
  const lastHashes = new Map<string, number>();
  const pollIntervalMs = ctx.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let pollTimer: NodeJS.Timeout | null = null;
  // Codex round 1 HIGH 1 fix carry = single-flight guard。 setInterval は 前 cycle
  // が終わっていなくても 次の cycle を 並列 起動するため、 遅い fetch 1 つ
  // (= 5xx + 長 retry / 60 秒 超過 latency) で polling が overlap し、
  // backend 負荷 spike + 重複 notification を 起こす。
  let pollInFlight = false;
  // Codex round 1 HIGH 2 fix carry = shutdown race 防御。 cycle 開始後に
  // shutdown が来た場合、 残り URI に対する notify を 全 skip する。
  let isShuttingDown = false;

  async function pollOnce(): Promise<void> {
    if (pollInFlight) return;
    if (subscriptions.size === 0) return;
    pollInFlight = true;
    try {
      const uris = Array.from(subscriptions);
      for (const uri of uris) {
        // Codex round 1 HIGH 2 fix carry = cycle 内 unsubscribe / shutdown 検出。
        // uris snapshot 取得後に unsubscribe された URI に対しては notify しない。
        if (isShuttingDown) return;
        if (!subscriptions.has(uri)) continue;
        let result: Awaited<ReturnType<typeof readResource>>;
        try {
          result = await readResource({
            uri,
            apiKey: ctx.apiKey,
            apiBase: ctx.apiBase,
          });
        } catch (err) {
          // 401 / network / 5xx 等の 一時的 failure は silent skip (= 次回 cycle で
          // 再試行)。 hash 更新しない (= 「fetch 不可 = 変化なし」 扱いで 不要
          // notification 抑制)。 debug 時のみ stderr に carry。
          //
          // Codex round 2 LOW 3 fix carry = error.message は upstream の
          // response body / 内部実装文字列を含む可能性があるため、 default は
          // errorClass のみ log。 full message が必要な場合は別途 redact pattern
          // 軸で carry path (= 現状 carry なし)。
          if (isDebugEnabled()) {
            // eslint-disable-next-line no-console
            console.error(
              `[argosvix-mcp] subscribe poll fetch failed (silent skip)`,
              {
                uri,
                errorClass:
                  err instanceof Error ? err.constructor.name : typeof err,
              },
            );
          }
          continue;
        }
        if (isShuttingDown || !subscriptions.has(uri)) continue;
        const h = resourceHash(result.contents);
        const prev = lastHashes.get(uri);
        if (prev === undefined) {
          lastHashes.set(uri, h);
          continue;
        }
        if (prev !== h) {
          lastHashes.set(uri, h);
          try {
            await ctx.server.notification({
              method: "notifications/resources/updated",
              params: { uri },
            });
          } catch (err) {
            // notification 送信失敗 (= transport 切断 / 一時的 error) は silent
            // skip だが、 fetch 失敗と path を分けて log carry (= MEDIUM 2 fix、
            // operational blind spot 解消)。 次回 cycle で 変化検出すれば 再 notify
            // される。 LOW 3 fix carry = errorClass のみ log (= upstream message
            // 経由の情報漏洩 構造防御)。
            if (isDebugEnabled()) {
              // eslint-disable-next-line no-console
              console.error(
                `[argosvix-mcp] subscribe notify failed (silent skip)`,
                {
                  uri,
                  errorClass:
                    err instanceof Error ? err.constructor.name : typeof err,
                },
              );
            }
          }
        }
      }
    } finally {
      pollInFlight = false;
    }
  }

  function startPolling(): void {
    if (pollTimer !== null) return;
    pollTimer = setInterval(() => {
      void pollOnce();
    }, pollIntervalMs);
    // Node.js では setInterval の timer が default で event loop に登録される。
    // unref で 「他に pending task が無くなれば process 終了可能」 にする
    // (= shutdown 漏れ 防御)。 setInterval の戻り値型は Node では unref を
    // 持つが TS 型では optional のため guard。
    if (typeof pollTimer.unref === "function") {
      pollTimer.unref();
    }
  }

  function stopPolling(): void {
    if (pollTimer === null) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  ctx.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (!ctx.apiKey) {
      // introspection-only モード(キー無し起動、2026-07)では購読を受け付けない。
      // 受けると 60 秒ごとの空キー 401 polling が永続する(Codex LOW)。
      throw new McpError(
        ErrorCode.InvalidParams,
        "ARGOSVIX_API_KEY is required for subscriptions. Get a key at " +
          "https://dashboard.argosvix.com/api-keys and set it in the MCP server env.",
      );
    }
    if (!SUBSCRIBABLE_URIS.has(uri)) {
      // Codex round 1 MEDIUM 1 fix carry = McpError(InvalidParams) で throw して
      // client に正しい -32602 を返す (= 旧実装は raw Error で SDK が
      // InternalError に変換、 InvalidParams semantic が落ちる)。
      throw new McpError(
        ErrorCode.InvalidParams,
        `Resource ${uri} does not support subscriptions. Subscribable URIs: ${Array.from(
          SUBSCRIBABLE_URIS,
        ).join(", ")}`,
      );
    }
    subscriptions.add(uri);
    if (subscriptions.size === 1) startPolling();
    return {};
  });

  ctx.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    const uri = request.params.uri;
    subscriptions.delete(uri);
    lastHashes.delete(uri);
    if (subscriptions.size === 0) stopPolling();
    return {};
  });

  return {
    subscribe(uri: string): void {
      if (!SUBSCRIBABLE_URIS.has(uri)) return;
      subscriptions.add(uri);
      if (subscriptions.size === 1) startPolling();
    },
    unsubscribe(uri: string): void {
      subscriptions.delete(uri);
      lastHashes.delete(uri);
      if (subscriptions.size === 0) stopPolling();
    },
    shutdown(): void {
      // Codex round 1 HIGH 2 fix carry = in-flight cycle が ある 場合に
      // notify suppress を 即時有効化。 stopPolling() 後の cycle 内 残 URI
      // への notify を 構造防御。
      isShuttingDown = true;
      stopPolling();
      subscriptions.clear();
      lastHashes.clear();
    },
    pollNow: pollOnce,
    snapshot(): { uris: string[]; pollerActive: boolean } {
      return {
        uris: Array.from(subscriptions),
        pollerActive: pollTimer !== null,
      };
    },
  };
}

export const SUBSCRIBABLE_URIS_FOR_TEST: ReadonlySet<string> = SUBSCRIBABLE_URIS;
