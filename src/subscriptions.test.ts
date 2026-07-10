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
 * Regression guard for the lightweight resources.subscribe support.
 *
 * A stub server captures setRequestHandler / notification calls to verify the
 * subscribe → polling → change detection → notification flow. Real polling
 * runs at a 60-second interval, so unit tests trigger one cycle immediately
 * with pollNow().
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
  // CI tsc cannot assign vi.spyOn(globalThis, "fetch")'s
  // MockInstance<fetch overloads> to the generic default
  // MockInstance<(this: unknown, ...args: unknown[]) => unknown>. A typed
  // alias route fails differently on globalThis prop-key narrowing, so an any
  // cast is used, limited to test scope (the type-safety loss stays confined
  // to test isolation).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stubFetch: any;

  beforeEach(() => {
    // Stub global fetch. The 1st call returns {value: 1}, the 2nd {value: 2},
    // simulating change detection. readResource fetches /v1/account internally.
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

    // Cycle 1: establishes the baseline hash — no notification.
    await mgr.pollNow();
    expect(server.notification).not.toHaveBeenCalled();

    // Cycle 2: recordsThisMonth rises to 2, the hash changes — one notification.
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
    // The handler is fetched by schema identity (an earlier design used array
    // index 0, which was fragile against registration-order changes).
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
    await mgr.pollNow(); // establish baseline
    // The scenario of an unsubscribe landing just before fetch completion
    // (right before the re-check) inside cycle 2 is a race in production; here
    // unsubscribe is called before pollNow to verify notification suppression
    // in the following cycle ("zero notifications in cycles after unsubscribe").
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
    await mgr.pollNow(); // cycles after shutdown produce zero notifications
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

  // Overlap / single-flight verification. Blocks fetch with a deferred
  // promise, triggers two parallel pollNow() calls, and checks that only the
  // first enters fetch while the second returns immediately. The same sequence
  // then verifies that a third pollNow() works normally after the fetch is
  // released.
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

    // Trigger twice in parallel; only the first enters fetch. The second
    // returns immediately via the pollInFlight guard.
    const p1 = mgr.pollNow();
    const p2 = mgr.pollNow();
    // Advance only microtasks and check fetchEntered (not yet released, so
    // it stays at 1).
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchEntered).toBe(1);

    // Release the fetch; cycle 1 completes.
    releaseFetch();
    await p1;
    await p2;

    // The third pollNow() runs normally: the guard has been released.
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
    // Override beforeEach's stubFetch directly via mockImplementation
    // (avoiding reassignment structurally sidesteps the vi.spyOn type
    // mismatch). afterEach's mockRestore returns to the baseline (success
    // path).
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
// Wire-level JSON-RPC -32602 mapping verification. The earlier tests only
// inspected the McpError instance and code; whether the SDK protocol actually
// puts `error.code = -32602` on the JSON-RPC error response can only be
// regression-tested over the wire via an in-memory transport pair.
// ============================================================

describe("subscribe wire-level error mapping (= JSON-RPC -32602)", () => {
  // retry: 1 covers a rare flake from InMemoryTransport handshake timing
  // (observed once in a full CI run and once in 30 local runs; not
  // reproducible in isolation, details uncaptured). A persistent regression
  // still fails after the retry, so detection power is preserved. The root
  // cause is presumed to be transport timing inside the MCP SDK.
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
    // ErrorCode.InvalidParams equals the JSON-RPC spec's -32602 (the SDK puts
    // McpError.code on the wire error.code unchanged).
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
