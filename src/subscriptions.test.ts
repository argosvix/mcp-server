import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ErrorCode,
  McpError,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  setupSubscribe,
  SUBSCRIBABLE_URIS_FOR_TEST,
} from "./subscriptions.js";

/**
 * resources.subscribe 軽量 carry の regression 防御。
 *
 * stub server で setRequestHandler / notification の call を capture して、
 * subscribe → polling → 変化検出 → notification の flow を 確認する。
 * 実 polling は 60 秒 interval = unit test では pollNow() で 1 cycle を 即時
 * trigger する。
 */

const ALLOWED_URI = "argosvix://account";
const DISALLOWED_URI = "argosvix://calls/abc123";

interface StubServer {
  setRequestHandler: ReturnType<typeof vi.fn>;
  notification: ReturnType<typeof vi.fn>;
  handlers: Map<unknown, (req: unknown) => Promise<unknown>>;
}

function createStubServer(): StubServer {
  const handlers = new Map<unknown, (req: unknown) => Promise<unknown>>();
  return {
    handlers,
    setRequestHandler: vi.fn((schema, handler) => {
      handlers.set(schema, handler);
    }),
    notification: vi.fn(async () => undefined),
  };
}

describe("setupSubscribe", () => {
  // CI tsc は vi.spyOn(globalThis, "fetch") の MockInstance<fetch overloads> と
  // generic default の MockInstance<(this: unknown, ...args: unknown[]) => unknown>
  // が assignment 不可。 typed alias 経路は globalThis の prop key narrow で別 fail
  // のため、 test スコープ限定で any cast で carry (= 型安全性 loss は test
  // isolation 内に閉じる)。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stubFetch: any;

  beforeEach(() => {
    // global fetch を stub。 1 回目 = {value: 1}、 2 回目 = {value: 2} で 変化検出を
    // simulate。 readResource は /v1/account を 内部 で fetch する。
    let callCount = 0;
    stubFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (): Promise<Response> => {
        callCount += 1;
        const payload = {
          account: {
            id: "acc_test",
            plan: "free",
            retentionDays: 7,
            createdAt: "2026-05-31T00:00:00.000Z",
          },
          usage: {
            recordsThisMonth: callCount,
            quotaRecordsPerMonth: 10000,
            yearMonth: "2026-05",
          },
        };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
  });

  afterEach(() => {
    stubFetch.mockRestore();
  });

  it("subscribable URI を 列挙する", () => {
    expect(SUBSCRIBABLE_URIS_FOR_TEST.has("argosvix://account")).toBe(true);
    expect(SUBSCRIBABLE_URIS_FOR_TEST.has("argosvix://alerts/active")).toBe(
      true,
    );
    expect(SUBSCRIBABLE_URIS_FOR_TEST.has("argosvix://cost/today")).toBe(true);
  });

  it("subscribe → polling 1 cycle で hash 確立、 2 cycle 目で変化 detect → notification", async () => {
    const server = createStubServer();
    const mgr = setupSubscribe({
      server: server as unknown as Parameters<
        typeof setupSubscribe
      >[0]["server"],
      apiKey: "argk_test",
      apiBase: "https://ingest.test",
      pollIntervalMs: 60_000,
    });
    mgr.subscribe(ALLOWED_URI);
    expect(mgr.snapshot().uris).toEqual([ALLOWED_URI]);
    expect(mgr.snapshot().pollerActive).toBe(true);

    // 1 cycle = baseline hash 確立 = notification なし
    await mgr.pollNow();
    expect(server.notification).not.toHaveBeenCalled();

    // 2 cycle = recordsThisMonth が 2 に増えて hash 変化 = notification 1 回
    await mgr.pollNow();
    expect(server.notification).toHaveBeenCalledTimes(1);
    expect(server.notification.mock.calls[0]?.[0]).toEqual({
      method: "notifications/resources/updated",
      params: { uri: ALLOWED_URI },
    });

    mgr.shutdown();
  });

  it("unsubscribe で polling 停止 + 後続 cycle で notification なし", async () => {
    const server = createStubServer();
    const mgr = setupSubscribe({
      server: server as unknown as Parameters<
        typeof setupSubscribe
      >[0]["server"],
      apiKey: "argk_test",
      apiBase: "https://ingest.test",
      pollIntervalMs: 60_000,
    });
    mgr.subscribe(ALLOWED_URI);
    await mgr.pollNow();
    mgr.unsubscribe(ALLOWED_URI);
    expect(mgr.snapshot().uris).toEqual([]);
    expect(mgr.snapshot().pollerActive).toBe(false);
    await mgr.pollNow();
    expect(server.notification).not.toHaveBeenCalled();
    mgr.shutdown();
  });

  it("非 subscribable URI は subscribe で silent skip (= 公開 API)", () => {
    const server = createStubServer();
    const mgr = setupSubscribe({
      server: server as unknown as Parameters<
        typeof setupSubscribe
      >[0]["server"],
      apiKey: "argk_test",
      apiBase: "https://ingest.test",
      pollIntervalMs: 60_000,
    });
    mgr.subscribe(DISALLOWED_URI);
    expect(mgr.snapshot().uris).toEqual([]);
    mgr.shutdown();
  });

  it("非 subscribable URI を MCP request 経由で subscribe = McpError InvalidParams で throw", async () => {
    const server = createStubServer();
    setupSubscribe({
      server: server as unknown as Parameters<
        typeof setupSubscribe
      >[0]["server"],
      apiKey: "argk_test",
      apiBase: "https://ingest.test",
      pollIntervalMs: 60_000,
    });
    // Codex round 1 MEDIUM 4 fix carry = schema identity で handler を取得 (=
    // 旧設計は Array index 0 だったため registration 順序変化で fragile)。
    const subscribeHandler = server.handlers.get(SubscribeRequestSchema);
    expect(subscribeHandler).toBeDefined();
    let caught: unknown = null;
    try {
      await subscribeHandler?.({ params: { uri: DISALLOWED_URI } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).code).toBe(ErrorCode.InvalidParams);
    expect((caught as McpError).message).toMatch(
      /does not support subscriptions/,
    );
  });

  it("unsubscribe が cycle 中の URI に対する notify を抑制", async () => {
    const server = createStubServer();
    const mgr = setupSubscribe({
      server: server as unknown as Parameters<
        typeof setupSubscribe
      >[0]["server"],
      apiKey: "argk_test",
      apiBase: "https://ingest.test",
      pollIntervalMs: 60_000,
    });
    mgr.subscribe(ALLOWED_URI);
    await mgr.pollNow(); // baseline 確立
    // 2 cycle 中で fetch 完了直前 (= 直後の re-check 直前) に unsubscribe シナリオは
    // 実機では race だが、 unsubscribe を pollNow の 前に 呼んで 直後 cycle で
    // notification 抑制を 確認 (= 「unsubscribe 後 cycle で notify 0」)。
    mgr.unsubscribe(ALLOWED_URI);
    await mgr.pollNow();
    expect(server.notification).not.toHaveBeenCalled();
    mgr.shutdown();
  });

  it("shutdown 後の polling は notify を抑制", async () => {
    const server = createStubServer();
    const mgr = setupSubscribe({
      server: server as unknown as Parameters<
        typeof setupSubscribe
      >[0]["server"],
      apiKey: "argk_test",
      apiBase: "https://ingest.test",
      pollIntervalMs: 60_000,
    });
    mgr.subscribe(ALLOWED_URI);
    await mgr.pollNow();
    mgr.shutdown();
    await mgr.pollNow(); // shutdown 後の cycle = 0 notify
    expect(server.notification).not.toHaveBeenCalled();
  });

  it("setRequestHandler は SubscribeRequestSchema + UnsubscribeRequestSchema を登録 (= identity 軸 verify)", () => {
    const server = createStubServer();
    setupSubscribe({
      server: server as unknown as Parameters<
        typeof setupSubscribe
      >[0]["server"],
      apiKey: "argk_test",
      apiBase: "https://ingest.test",
      pollIntervalMs: 60_000,
    });
    expect(server.handlers.has(SubscribeRequestSchema)).toBe(true);
    expect(server.handlers.has(UnsubscribeRequestSchema)).toBe(true);
  });

  // Codex round 2 LOW 1 fix carry = overlap single-flight 検証。 deferred promise
  // で fetch を block して、 並列 pollNow() を 2 回 trigger、 1 つ目だけ fetch
  // 開始 + 2 つ目は即 return を 確認。 fetch 解放後に 3 回目 pollNow() が 通常
  // 動作するか までを 1 sequence で verify。
  it("polling overlap = single-flight guard で 2 回目 cycle skip + 解放後の 3 回目は通常 carry", async () => {
    stubFetch.mockRestore();
    let fetchEntered = 0;
    let releaseFetch: () => void = () => {
      /* placeholder replaced by Promise constructor below */
    };
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    stubFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (): Promise<Response> => {
        fetchEntered += 1;
        await fetchGate;
        return new Response(
          JSON.stringify({
            account: {
              id: "acc_test",
              plan: "free",
              retentionDays: 7,
              createdAt: "2026-05-31T00:00:00.000Z",
            },
            usage: {
              recordsThisMonth: fetchEntered,
              quotaRecordsPerMonth: 10000,
              yearMonth: "2026-05",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

    const server = createStubServer();
    const mgr = setupSubscribe({
      server: server as unknown as Parameters<
        typeof setupSubscribe
      >[0]["server"],
      apiKey: "argk_test",
      apiBase: "https://ingest.test",
      pollIntervalMs: 60_000,
    });
    mgr.subscribe(ALLOWED_URI);

    // 並列に 2 回 trigger、 1 つ目だけ fetch entry。 2 つ目は pollInFlight ガード
    // で 即 return。
    const p1 = mgr.pollNow();
    const p2 = mgr.pollNow();
    // microtask だけ進めて fetchEntered を確認 (= まだ 解放してない = 1 のまま)
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchEntered).toBe(1);

    // fetch 解放、 1 cycle 完了
    releaseFetch();
    await p1;
    await p2;

    // 3 回目 pollNow() は guard 解除済 + cycle 通常 carry
    await mgr.pollNow();
    expect(fetchEntered).toBe(2);

    mgr.shutdown();
  });

  it("shutdown で subscription set クリア + polling 停止", () => {
    const server = createStubServer();
    const mgr = setupSubscribe({
      server: server as unknown as Parameters<
        typeof setupSubscribe
      >[0]["server"],
      apiKey: "argk_test",
      apiBase: "https://ingest.test",
      pollIntervalMs: 60_000,
    });
    mgr.subscribe(ALLOWED_URI);
    expect(mgr.snapshot().pollerActive).toBe(true);
    mgr.shutdown();
    expect(mgr.snapshot().uris).toEqual([]);
    expect(mgr.snapshot().pollerActive).toBe(false);
  });

  it("fetch 失敗時 (= network error) は silent skip + hash 更新なし", async () => {
    // beforeEach の stubFetch を 直接 mockImplementation で override (= 再 assign
    // を避けて vi.spyOn の type 不整合 を 構造防御)。 afterEach の mockRestore で
    // baseline (= success path) に戻る。
    stubFetch.mockImplementation(async () => {
      throw new Error("network error");
    });
    const server = createStubServer();
    const mgr = setupSubscribe({
      server: server as unknown as Parameters<
        typeof setupSubscribe
      >[0]["server"],
      apiKey: "argk_test",
      apiBase: "https://ingest.test",
      pollIntervalMs: 60_000,
    });
    mgr.subscribe(ALLOWED_URI);
    await mgr.pollNow();
    await mgr.pollNow();
    expect(server.notification).not.toHaveBeenCalled();
    mgr.shutdown();
  });
});

// ============================================================
// Codex round 2 LOW 2 fix carry = wire-level JSON-RPC -32602 mapping verify。
// 既存 test は McpError instance + code で 検査していたが、 SDK protocol が
// 実際に JSON-RPC error response の `error.code = -32602` を carry するか は
// in-memory transport pair の wire 経由で 確認しないと regression を捕捉できない。
// ============================================================

describe("subscribe wire-level error mapping (= JSON-RPC -32602)", () => {
  // retry: 1 = InMemoryTransport のハンドシェイク timing による稀な flake
  // (2026-07-03 に CI 全体実行で 1 回 + ローカル 30 回中 1 回観測、単独では
  // 再現せず詳細未捕捉)。恒常的な regression は retry 後も fail するため
  // 検出力は保たれる。根因は MCP SDK 側 transport のタイミングと推定。
  it("非 subscribable URI は wire error.code = -32602 で reject", { retry: 1 }, async () => {
    const { Server } = await import(
      "@modelcontextprotocol/sdk/server/index.js"
    );
    const { Client } = await import(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const { InMemoryTransport } = await import(
      "@modelcontextprotocol/sdk/inMemory.js"
    );
    const { EmptyResultSchema } = await import(
      "@modelcontextprotocol/sdk/types.js"
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    const server = new Server(
      { name: "argosvix-test", version: "0.0.0-test" },
      { capabilities: { resources: { subscribe: true } } },
    );
    setupSubscribe({
      server,
      apiKey: "argk_test",
      apiBase: "https://ingest.test",
      pollIntervalMs: 60_000,
    });
    await server.connect(serverTransport);

    const client = new Client(
      { name: "argosvix-wire-test-client", version: "0.0.0-test" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    let caught: unknown = null;
    try {
      await client.request(
        {
          method: "resources/subscribe",
          params: { uri: "argosvix://calls/abc123" },
        },
        EmptyResultSchema,
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).code).toBe(ErrorCode.InvalidParams);
    // ErrorCode.InvalidParams は JSON-RPC spec の -32602 と一致 (= SDK が
    // McpError.code を そのまま wire error.code に carry する)。
    expect(ErrorCode.InvalidParams).toBe(-32602);
    expect((caught as McpError).message).toMatch(
      /does not support subscriptions/,
    );

    await client.close();
    await server.close();
  });

  it("subscribable URI は wire 経由でも accept + {} return", { retry: 1 }, async () => {
    const { Server } = await import(
      "@modelcontextprotocol/sdk/server/index.js"
    );
    const { Client } = await import(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const { InMemoryTransport } = await import(
      "@modelcontextprotocol/sdk/inMemory.js"
    );
    const { EmptyResultSchema } = await import(
      "@modelcontextprotocol/sdk/types.js"
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    const server = new Server(
      { name: "argosvix-test", version: "0.0.0-test" },
      { capabilities: { resources: { subscribe: true } } },
    );
    setupSubscribe({
      server,
      apiKey: "argk_test",
      apiBase: "https://ingest.test",
      pollIntervalMs: 60_000,
    });
    await server.connect(serverTransport);

    const client = new Client(
      { name: "argosvix-wire-test-client", version: "0.0.0-test" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    const result = await client.request(
      {
        method: "resources/subscribe",
        params: { uri: "argosvix://account" },
      },
      EmptyResultSchema,
    );
    expect(result).toEqual({});

    await client.close();
    await server.close();
  });
});
