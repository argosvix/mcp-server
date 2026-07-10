/**
 * Lightweight MCP resources/subscribe support (added in v0.10.0-alpha.1).
 *
 * Implements the MCP spec's `resources.subscribe` capability on the stdio
 * transport. When a client registers a URI via `resources/subscribe`, each
 * polling cycle compares the resource's hash and sends
 * `notifications/resources/updated` when a change is detected.
 *
 * Supported URIs (the 3 static resources only; resource templates such as
 * calls/{id} are out of scope):
 *   - argosvix://account
 *   - argosvix://alerts/active
 *   - argosvix://cost/today
 *
 * Design choices:
 *   - Polling at a 60-second interval (a compromise between backend load and
 *     update latency)
 *   - The HTTP transport never calls setupSubscribe (per-request stateless, so
 *     subscription state cannot be held; subscribe is not declared in its
 *     capabilities either)
 *   - On shutdown / disconnect: stop the polling timer and clear the whole
 *     subscription set
 *   - The subscription set is per server instance (stdio = 1 client, 1 process)
 *   - Fetch failures (401 / network) are silently skipped (retried next cycle);
 *     the hash keeps its previous value ("cannot fetch" is treated as "no
 *     change" to suppress spurious notifications)
 *   - Hash = JSON.stringify + a djb2-like rolling 32-bit hash (lightweight, not
 *     cryptographic)
 *
 * Deliberately not implemented here (backlog):
 *   - Per-id subscribe for resource templates (calls/{id} etc., the path where
 *     an LLM watches updates to an individual call)
 *   - listChanged notification (the resource list itself is fixed for the
 *     server lifecycle, so it is unnecessary)
 *   - HTTP subscribe via WebSocket / SSE (requires persistent connections;
 *     heavy)
 *   - Env-driven polling interval (overridable via MCP_SUBSCRIBE_POLL_MS)
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
  /** Test override (60 seconds is too long for unit tests, which use a small value). */
  pollIntervalMs?: number;
}

/**
 * Lightweight 32-bit hash (djb2-like). Not cryptographic; used only as a fast
 * equality check. The collision probability is low enough for content
 * comparison, but it must not be used for critical decisions (billing / auth).
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
  /** On shutdown / disconnect: stop polling and clear the subscription set. */
  shutdown(): void;
  /** For tests: trigger one polling cycle immediately. */
  pollNow(): Promise<void>;
  /** For tests: snapshot of the current subscription set. */
  snapshot(): { uris: string[]; pollerActive: boolean };
}

export function setupSubscribe(ctx: SubscribeContext): SubscribeManager {
  const subscriptions = new Set<string>();
  const lastHashes = new Map<string, number>();
  const pollIntervalMs = ctx.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let pollTimer: NodeJS.Timeout | null = null;
  // Single-flight guard. setInterval starts the next cycle in parallel even if
  // the previous one has not finished, so a single slow fetch (5xx with long
  // retries / latency over 60 seconds) would overlap polling cycles, spiking
  // backend load and duplicating notifications.
  let pollInFlight = false;
  // Shutdown race defense: if shutdown arrives after a cycle has started, skip
  // notifications for all remaining URIs.
  let isShuttingDown = false;

  async function pollOnce(): Promise<void> {
    if (pollInFlight) return;
    if (subscriptions.size === 0) return;
    pollInFlight = true;
    try {
      const uris = Array.from(subscriptions);
      for (const uri of uris) {
        // Detect unsubscribe / shutdown within the cycle: never notify for a
        // URI that was unsubscribed after the uris snapshot was taken.
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
          // Transient failures (401 / network / 5xx) are silently skipped and
          // retried on the next cycle. The hash is not updated ("cannot fetch"
          // is treated as "no change" to suppress spurious notifications).
          // Logged to stderr only in debug mode.
          //
          // error.message may contain the upstream response body or internal
          // implementation strings, so by default only errorClass is logged.
          // If the full message is ever needed, it should go through a
          // separate redaction pattern (not implemented today).
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
            // Notification send failures (transport disconnect / transient
            // error) are silently skipped, but logged on a separate path from
            // fetch failures to avoid an operational blind spot. If a change
            // is detected again next cycle, a new notification is sent. Only
            // errorClass is logged, as a structural defense against leaking
            // information through upstream messages.
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
    // In Node.js, a setInterval timer keeps the event loop alive by default.
    // unref lets the process exit once no other pending tasks remain (guards
    // against missed shutdowns). Node's setInterval return value has unref,
    // but the TS type marks it optional, hence the guard.
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
      // In introspection-only mode (keyless startup), subscriptions are not
      // accepted. Accepting one would create a permanent 60-second polling
      // loop of empty-key 401s.
      throw new McpError(
        ErrorCode.InvalidParams,
        "ARGOSVIX_API_KEY is required for subscriptions. Get a key at " +
          "https://dashboard.argosvix.com/api-keys and set it in the MCP server env.",
      );
    }
    if (!SUBSCRIBABLE_URIS.has(uri)) {
      // Throw McpError(InvalidParams) so the client gets the correct -32602.
      // The old implementation threw a raw Error, which the SDK converted to
      // InternalError, losing the InvalidParams semantics.
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
      // If a cycle is in flight, enable notification suppression immediately.
      // This structurally prevents notifications for URIs still being
      // processed within the cycle after stopPolling().
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
