import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { dispatchTool, tools } from "./tools.js";
import { MCP_VERSION } from "./version.js";

describe("MCP version source of truth", () => {
  it("src/version.ts MCP_VERSION matches package.json version (= drift 防御)", () => {
    // Codex round 2 LOW 2 fix + v0.4.0 round 2 MEDIUM 1 fix:
    // version は src/version.ts に集約 + package.json と完全一致を CI で gate する。
    // path は import.meta.url (= 本 file の絶対位置) 基準で resolve し、 monorepo root
    // から `npx vitest --root packages/mcp-server` で 走らせた時に process.cwd() が
    // root に なって 誤判定する path を 構造防御 (= round 1 の process.cwd() 採用は
    // overshoot だったので 元に戻した上で 意図を comment 化)。
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version: string;
    };
    expect(MCP_VERSION).toBe(pkg.version);
  });
});

describe("MCP tools metadata", () => {
  it("exposes 87 tools", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      "acknowledge_alert",
      "aggregate_calls",
      "apply_promo_code_to_customer",
      "auto_silence_noisy_alert",
      "bulk_delete_calls",
      "classify_calls_batch",
      "compare_eval_runs",
      "create_alert",
      "create_annotation",
      "create_budget_gate",
      "create_eval_criterion",
      "create_eval_dataset",
      "create_policy_gate",
      "create_project",
      "create_prompt",
      "create_saved_view",
      "create_webhook",
      "delete_alert",
      "delete_annotation",
      "delete_budget_gate",
      "delete_eval_criterion",
      "delete_eval_dataset",
      "delete_policy_gate",
      "delete_project",
      "delete_prompt",
      "delete_saved_view",
      "delete_webhook",
      "deploy_prompt",
      "detect_anomaly",
      "export_calls",
      "extend_customer_trial",
      "get_account_health",
      "get_alert",
      "get_annotation",
      "get_approval",
      "get_budget_gate",
      "get_cost_summary",
      "get_deployed_prompt",
      "get_eval_criterion",
      "get_eval_dataset",
      "get_eval_run",
      "get_llm_budget",
      "get_percentiles",
      "get_policy_gate",
      "get_prompt",
      "get_proposal_thread",
      "get_safety_assessment",
      "list_alert_events",
      "list_alerts",
      "list_annotations_by_label",
      "list_annotations_for_call",
      "list_approvals",
      "list_audit_log",
      "list_eval_criteria",
      "list_eval_datasets",
      "list_eval_runs",
      "list_members",
      "list_projects",
      "list_prompt_deployments",
      "list_prompts",
      "list_proposals",
      "list_safety_assessments",
      "list_saved_views",
      "list_webhooks",
      "propose_alert_rules",
      "propose_eval_criteria",
      "purge_expired_plaintext",
      "query_calls",
      "raise_llm_budget",
      "rename_project",
      "rename_prompt",
      "reply_proposal",
      "request_approval",
      "retry_failed_webhook",
      "rollback_prompt",
      "run_eval",
      "run_eval_dataset",
      "silence_alert",
      "test_webhook",
      "unsilence_alert",
      "update_alert",
      "update_annotation",
      "update_budget_gate",
      "update_eval_criterion",
      "update_policy_gate",
      "update_prompt",
      "update_webhook",
    ]);
  });

  it("each tool has description + inputSchema", () => {
    for (const t of tools) {
      expect(t.description).toBeTruthy();
      expect(t.inputSchema).toBeTruthy();
      expect((t.inputSchema as { type: string }).type).toBe("object");
    }
  });

  it("create_alert.alertType enum matches backend ALERT_TYPES (= enum drift 回帰防止)", () => {
    // backend packages/backend/src/types.ts ALERT_TYPES と完全一致させる。
    // ここが drift すると mismatch した type の create_alert が backend で 400 になる。
    // 2026-06-06 R37 medium #1 fix carry: 旧 hard-coded list は backend と drift
    // していた (= 旧 list: cost_daily / cost_monthly / latency_p95、 backend reality:
    // cost_threshold / monthly_budget / latency_degradation)。 同 hard-code を MCP
    // description から copy していたため drift gate test 自体が drift を検出できない
    // 構造軸だった。 backend `src/alerts/types.ts` の ALERT_TYPES を test 時点で
    // fs.readFileSync で 読み出して regex 抽出 → これで source of truth が backend
    // 側に固定、 backend が enum を 追加すると 本 test が 自動的に拾って fail する。
    const here2 = dirname(fileURLToPath(import.meta.url));
    const backendTypesPath = resolve(here2, "..", "..", "backend", "src", "alerts", "types.ts");
    const backendTypesContent = readFileSync(backendTypesPath, "utf8");
    const arrayMatch = backendTypesContent.match(
      /export const ALERT_TYPES = \[([\s\S]*?)\] as const;/,
    );
    if (!arrayMatch) {
      throw new Error(
        "ALERT_TYPES export not found in backend/src/alerts/types.ts (= drift gate が source-of-truth を 見失った、 backend の ALERT_TYPES export 形を 確認してください)",
      );
    }
    const BACKEND_ALERT_TYPES = Array.from(arrayMatch[1]!.matchAll(/"([^"]+)"/g)).map(
      (m) => m[1]!,
    );
    expect(BACKEND_ALERT_TYPES.length).toBeGreaterThan(0);
    const createAlert = tools.find((t) => t.name === "create_alert");
    const schema = createAlert?.inputSchema as {
      properties?: { alertType?: { enum?: string[] } };
    };
    const enumValues = schema?.properties?.alertType?.enum ?? [];
    expect([...enumValues].sort()).toEqual([...BACKEND_ALERT_TYPES].sort());
  });

  it("aggregate_calls の groupBy / metric enum が backend VALID_GROUP_BY / VALID_METRIC と一致 (= enum drift 回帰防止)", () => {
    // 2026-06-17 = REST に input_tokens/output_tokens metric と groupBy=error を足した時、
    // MCP enum を mirror し忘れて「ダッシュボードで出来るのに AI が問えない」drift が出た
    // (MCP-first 違反)。 backend packages/backend/src/query.ts の allowlist を source of
    // truth に固定し、 backend が増やすと本 test が拾って fail させる。
    const here2 = dirname(fileURLToPath(import.meta.url));
    const queryPath = resolve(here2, "..", "..", "backend", "src", "query.ts");
    const queryContent = readFileSync(queryPath, "utf8");
    const extractSet = (name: string): string[] => {
      const m = queryContent.match(
        new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`),
      );
      if (!m) {
        throw new Error(
          `${name} export not found in backend/src/query.ts (= drift gate が source-of-truth を 見失った)`,
        );
      }
      return Array.from(m[1]!.matchAll(/"([^"]+)"/g)).map((x) => x[1]!);
    };
    const backendGroupBy = extractSet("VALID_GROUP_BY");
    const backendMetric = extractSet("VALID_METRIC");
    expect(backendGroupBy.length).toBeGreaterThan(0);
    expect(backendMetric.length).toBeGreaterThan(0);
    const agg = tools.find((t) => t.name === "aggregate_calls");
    const schema = agg?.inputSchema as {
      properties?: {
        groupBy?: { enum?: string[] };
        metric?: { enum?: string[] };
      };
    };
    expect([...(schema?.properties?.groupBy?.enum ?? [])].sort()).toEqual(
      [...backendGroupBy].sort(),
    );
    expect([...(schema?.properties?.metric?.enum ?? [])].sort()).toEqual(
      [...backendMetric].sort(),
    );
  });

  it("create_alert.channelTargets is an object keyed by channel kind (not array)", () => {
    const createAlert = tools.find((t) => t.name === "create_alert");
    const schema = createAlert?.inputSchema as {
      properties?: { channelTargets?: { type?: string } };
    };
    expect(schema?.properties?.channelTargets?.type).toBe("object");
  });
});

describe("dispatchTool", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/v1/query/calls")) {
          return new Response(JSON.stringify({ records: [], total: 0 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/v1/query/aggregate")) {
          return new Response(
            JSON.stringify({ groups: [{ provider: "openai", costUsd: 1.23 }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/v1/alerts")) {
          return new Response(JSON.stringify({ alerts: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("query_calls POSTs JSON body with rangePreset converted to startTime/endTime", async () => {
    // 0.3.1-alpha.1 fix: backend `/v1/query/calls` は POST 専用 + ISO range を body で
    // 受け取る。 rangePreset は MCP server 側で wall-clock 変換する。
    const res = await dispatchTool({
      name: "query_calls",
      args: { limit: 10, provider: "openai", rangePreset: "7d" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]?.type).toBe("text");
    const parsed = JSON.parse(res.content[0]?.text ?? "{}");
    expect(parsed.records).toEqual([]);
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const fetchedUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(fetchedUrl).toContain("/v1/query/calls");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.limit).toBe(10);
    expect(body.provider).toBe("openai");
    expect(typeof body.startTime).toBe("string");
    expect(typeof body.endTime).toBe("string");
    // 7d 後ろから now まで = 終端より始端が前
    expect(new Date(body.startTime).getTime()).toBeLessThan(
      new Date(body.endTime).getTime(),
    );
  });

  it("R74 HIGH 1 regression: query_calls の latencyMin/Max が outgoing body に乗る (= allowlist 落ち防止)", async () => {
    const res = await dispatchTool({
      name: "query_calls",
      args: { latencyMin: 1500, latencyMax: 2500 },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.latencyMin).toBe(1500);
    expect(body.latencyMax).toBe(2500);
  });

  it("2026-06-12 keyset cursor: query_calls の beforeTimestamp/beforeId が outgoing body に乗る", async () => {
    const res = await dispatchTool({
      name: "query_calls",
      args: { beforeTimestamp: "2026-06-11T12:00:00.000Z", beforeId: "rec_abc" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.beforeTimestamp).toBe("2026-06-11T12:00:00.000Z");
    expect(body.beforeId).toBe("rec_abc");
  });

  it("get_cost_summary uses /v1/query/aggregate endpoint", async () => {
    const res = await dispatchTool({
      name: "get_cost_summary",
      args: { rangePreset: "7d", groupBy: "provider" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content[0]?.text ?? "{}");
    expect(parsed.groups[0].provider).toBe("openai");
  });

  it("list_members GETs /v1/memberships (= #31 Team read tool)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              members: [
                { id: "mem_1", email: "a@example.com", role: "admin", status: "active" },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const res = await dispatchTool({
      name: "list_members",
      args: {},
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const fetchedUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(fetchedUrl).toContain("/v1/memberships");
    // read tool = GET (= 明示 method 指定なし → callApi default GET)
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method ?? "GET").toBe("GET");
    const parsed = JSON.parse(res.content[0]?.text ?? "{}");
    expect(parsed.members[0].role).toBe("admin");
  });

  it("classify_calls_batch POSTs to /v1/safety-assessments/scan-batch with maxRecords", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ scanned: 10, assessed: 9, flagged: 1, failures: 0, skipped: 1 }),
            { status: 200 },
          ),
      ),
    );
    const res = await dispatchTool({
      name: "classify_calls_batch",
      args: { maxRecords: 10 },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const fetchedUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(fetchedUrl).toContain("/v1/safety-assessments/scan-batch");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.maxRecords).toBe(10);
    const parsed = JSON.parse(res.content[0]?.text ?? "{}");
    expect(parsed.scanned).toBe(10);
    expect(parsed.flagged).toBe(1);
  });

  it("classify_calls_batch rejects out-of-range maxRecords client-side", async () => {
    const res = await dispatchTool({
      name: "classify_calls_batch",
      args: { maxRecords: 200 },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("1-100");
  });

  it("propose_eval_criteria POSTs to /v1/eval-criteria/propose with useCaseHint + sampleCallIds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              criteria: [
                {
                  name: "tone_appropriateness",
                  rubric: "Is the tone polite and professional?",
                  scaleMin: 1,
                  scaleMax: 5,
                  reasoning: "Tone matters in customer support.",
                },
              ],
              partialFailures: [],
              budgetSpentUsd: 0.001,
            }),
            { status: 200 },
          ),
      ),
    );
    const res = await dispatchTool({
      name: "propose_eval_criteria",
      args: {
        useCaseHint: "Customer support bot for an e-commerce site",
        sampleCallIds: ["call_abc123", "call_xyz789"],
        maxCriteria: 3,
      },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const fetchedUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(fetchedUrl).toContain("/v1/eval-criteria/propose");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.useCaseHint).toContain("Customer support");
    expect(body.sampleCallIds).toEqual(["call_abc123", "call_xyz789"]);
    expect(body.maxCriteria).toBe(3);
    const parsed = JSON.parse(res.content[0]?.text ?? "{}");
    expect(parsed.criteria).toHaveLength(1);
    expect(parsed.criteria[0].name).toBe("tone_appropriateness");
  });

  it("propose_eval_criteria rejects missing useCaseHint client-side", async () => {
    const res = await dispatchTool({
      name: "propose_eval_criteria",
      args: {},
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("useCaseHint");
  });

  it("propose_eval_criteria rejects sampleCallIds with bad shape", async () => {
    const res = await dispatchTool({
      name: "propose_eval_criteria",
      args: {
        useCaseHint: "Customer bot",
        sampleCallIds: ["bad id with spaces"],
      },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("sampleCallIds");
  });

  it("detect_anomaly flags cost spike when current = 3x baseline (threshold=normal 2x)", async () => {
    const currentCost = JSON.stringify({ total: { value: 30.0, count: 1500 } });
    const currentError = JSON.stringify({ total: { value: 2, count: 1500 } });
    const currentCount = JSON.stringify({ total: { value: 1500, count: 1500 } });
    const currentPercentile = JSON.stringify({ p95: 1100, total: 1500 });
    const baselineCost = JSON.stringify({ total: { value: 10.0, count: 1000 } });
    // backend error_rate metric = percent (0-100)、 2 = 2%
    const baselineError = JSON.stringify({ total: { value: 2, count: 1000 } });
    const baselineCount = JSON.stringify({ total: { value: 1000, count: 1000 } });
    const baselinePercentile = JSON.stringify({ p95: 1000, total: 1000 });
    let aggCalls = 0;
    let pctCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/v1/query/aggregate")) {
          aggCalls += 1;
          if (aggCalls <= 3) {
            return new Response(
              aggCalls === 1 ? currentCost : aggCalls === 2 ? currentError : currentCount,
              { status: 200 },
            );
          }
          return new Response(
            aggCalls === 4 ? baselineCost : aggCalls === 5 ? baselineError : baselineCount,
            { status: 200 },
          );
        }
        if (url.endsWith("/v1/query/percentiles")) {
          pctCalls += 1;
          return new Response(pctCalls === 1 ? currentPercentile : baselinePercentile, {
            status: 200,
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    const res = await dispatchTool({
      name: "detect_anomaly",
      args: { window: "24h", threshold: "normal" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content[0]?.text ?? "{}");
    expect(parsed.window).toBe("24h");
    expect(parsed.threshold).toBe("normal");
    expect(parsed.multiplier).toBe(2);
    const costAnomaly = parsed.anomalies.find(
      (a: { axis: string }) => a.axis === "cost",
    );
    expect(costAnomaly).toBeDefined();
    expect(costAnomaly.ratio).toBe(3);
    expect(costAnomaly.severity).toBe("major");
  });

  it("detect_anomaly returns empty anomalies + warning when baseline records < 10", async () => {
    const tiny = JSON.stringify({ total: { value: 0, count: 0 } });
    const tinyPercentile = JSON.stringify({ p95: null, total: 0 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/v1/query/aggregate")) return new Response(tiny, { status: 200 });
        if (url.endsWith("/v1/query/percentiles"))
          return new Response(tinyPercentile, { status: 200 });
        return new Response("not found", { status: 404 });
      }),
    );
    const res = await dispatchTool({
      name: "detect_anomaly",
      args: {},
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    const parsed = JSON.parse(res.content[0]?.text ?? "{}");
    expect(parsed.anomalies).toEqual([]);
    expect(parsed.warning).toContain("統計強度");
  });

  it("propose_alert_rules generates 4 baseline-derived proposals when no alerts exist", async () => {
    const dailyCost = JSON.stringify({
      groups: Array.from({ length: 14 }, (_, i) => ({
        key: `2026-05-${String(i + 1).padStart(2, "0")}`,
        value: 1.5,
        count: 100,
      })),
      total: { value: 21, count: 1400 },
    });
    // backend error_rate metric = percent (0-100)、 1 = 1%
    const errorRate = JSON.stringify({ total: { value: 1, count: 1400 } });
    const dailyCount = JSON.stringify({
      groups: Array.from({ length: 14 }, (_, i) => ({
        key: `2026-05-${String(i + 1).padStart(2, "0")}`,
        value: 100,
        count: 100,
      })),
      total: { value: 1400, count: 1400 },
    });
    const percentiles = JSON.stringify({ p50: 300, p95: 1500, p99: 3000, total: 1400 });
    const alerts = JSON.stringify({ alerts: [] });
    let aggCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/v1/query/aggregate")) {
          aggCalls += 1;
          const body =
            aggCalls === 1 ? dailyCost : aggCalls === 2 ? errorRate : dailyCount;
          return new Response(body, { status: 200 });
        }
        if (url.endsWith("/v1/query/percentiles"))
          return new Response(percentiles, { status: 200 });
        if (url.includes("/v1/alerts")) return new Response(alerts, { status: 200 });
        return new Response("not found", { status: 404 });
      }),
    );
    const res = await dispatchTool({
      name: "propose_alert_rules",
      args: { lookbackDays: 14 },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content[0]?.text ?? "{}");
    expect(parsed.lookbackDays).toBe(14);
    expect(parsed.baseline.p95Latency).toBe(1500);
    expect(parsed.baseline.totalCalls).toBe(1400);
    expect(parsed.proposals).toHaveLength(4);
    const types = parsed.proposals.map((p: { alertType: string }) => p.alertType).sort();
    // create_alert enum と整合する type 名 (= cost_threshold / latency_degradation)。
    // 旧 cost_daily / latency_p95 は enum 外で create できず dedup も効かなかった回帰。
    expect(types).toEqual([
      "anomaly_cost",
      "cost_threshold",
      "error_rate",
      "latency_degradation",
    ]);
    const latencyRule = parsed.proposals.find(
      (p: { alertType: string }) => p.alertType === "latency_degradation",
    );
    expect(latencyRule.thresholdValue).toBe(2250);
    expect(parsed.skipped).toEqual([]);
  });

  it("propose_alert_rules skips alert types already configured", async () => {
    const dailyCost = JSON.stringify({
      groups: [{ key: "2026-05-01", value: 1.0, count: 200 }],
      total: { value: 1.0, count: 200 },
    });
    // backend error_rate metric = percent (0-100)、 2 = 2%
    const errorRate = JSON.stringify({ total: { value: 2, count: 200 } });
    const dailyCount = JSON.stringify({
      groups: [{ key: "2026-05-01", value: 200, count: 200 }],
      total: { value: 200, count: 200 },
    });
    const percentiles = JSON.stringify({ p50: 100, p95: 800, p99: 1500, total: 200 });
    const alerts = JSON.stringify({
      alerts: [
        { alertType: "cost_threshold", name: "existing cost alert" },
        { alertType: "error_rate", name: "existing error alert" },
      ],
    });
    let aggCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/v1/query/aggregate")) {
          aggCalls += 1;
          return new Response(
            aggCalls === 1 ? dailyCost : aggCalls === 2 ? errorRate : dailyCount,
            { status: 200 },
          );
        }
        if (url.endsWith("/v1/query/percentiles"))
          return new Response(percentiles, { status: 200 });
        if (url.includes("/v1/alerts")) return new Response(alerts, { status: 200 });
        return new Response("not found", { status: 404 });
      }),
    );
    const res = await dispatchTool({
      name: "propose_alert_rules",
      args: {},
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    const parsed = JSON.parse(res.content[0]?.text ?? "{}");
    const proposalTypes = parsed.proposals
      .map((p: { alertType: string }) => p.alertType)
      .sort();
    expect(proposalTypes).toEqual(["anomaly_cost", "latency_degradation"]);
    const skippedTypes = parsed.skipped.map((s: { alertType: string }) => s.alertType).sort();
    expect(skippedTypes).toEqual(["cost_threshold", "error_rate"]);
  });

  it("get_account_health fans out to 6 endpoints in parallel + composes summary", async () => {
    const aggregateCount = JSON.stringify({ total: { value: 1234, count: 1234 } });
    // 注: backend error_rate metric は percent (0-100) で 返る = 2 = 2%
    const aggregateError = JSON.stringify({ total: { value: 2, count: 1234 } });
    const aggregateCost = JSON.stringify({ total: { value: 4.56, count: 1234 } });
    const percentiles = JSON.stringify({ p50: 250, p95: 1100, p99: 2400, total: 1234 });
    const budget = JSON.stringify({ monthlyLimitUsd: 50, usedUsd: 30, remainingUsd: 20 });
    const auditEvents = JSON.stringify({ events: [{ id: 1 }, { id: 2 }] });
    const seen: string[] = [];
    const fetchSpy = vi.fn(async (input: unknown) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/v1/query/aggregate")) {
        const callIdx = seen.filter((u) => u.endsWith("/v1/query/aggregate")).length;
        const body =
          callIdx === 1 ? aggregateCount : callIdx === 2 ? aggregateError : aggregateCost;
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/v1/query/percentiles"))
        return new Response(percentiles, { status: 200 });
      if (url.includes("/v1/account/llm-feature-budget"))
        return new Response(budget, { status: 200 });
      if (url.includes("/v1/audit-log"))
        return new Response(auditEvents, { status: 200 });
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const res = await dispatchTool({
      name: "get_account_health",
      args: { window: "24h" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(6);
    const parsed = JSON.parse(res.content[0]?.text ?? "{}");
    expect(parsed.window).toBe("24h");
    expect(parsed.totals.calls).toBe(1234);
    expect(parsed.totals.errorRate).toBe(2);
    expect(parsed.totals.costUsd).toBe(4.56);
    expect(parsed.latency.p95).toBe(1100);
    expect(parsed.budget.percentUsed).toBe(60);
    expect(parsed.recentEvents).toBe(2);
    expect(parsed.summary).toBe("ok");
  });

  it("get_account_health flips summary=warn when error_rate breaches 3% threshold", async () => {
    const aggregateCount = JSON.stringify({ total: { value: 100, count: 100 } });
    // 5 = 5% error rate (= percent semantics) > 3% warn threshold
    const aggregateError = JSON.stringify({ total: { value: 5, count: 100 } });
    const aggregateCost = JSON.stringify({ total: { value: 1.0, count: 100 } });
    const percentiles = JSON.stringify({ p50: 100, p95: 200, p99: 500, total: 100 });
    const budget = JSON.stringify({ monthlyLimitUsd: 50, usedUsd: 10, remainingUsd: 40 });
    const auditEvents = JSON.stringify({ events: [] });
    let aggCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/v1/query/aggregate")) {
          aggCalls += 1;
          const body =
            aggCalls === 1 ? aggregateCount : aggCalls === 2 ? aggregateError : aggregateCost;
          return new Response(body, { status: 200 });
        }
        if (url.endsWith("/v1/query/percentiles"))
          return new Response(percentiles, { status: 200 });
        if (url.includes("/v1/account/llm-feature-budget"))
          return new Response(budget, { status: 200 });
        return new Response(auditEvents, { status: 200 });
      }),
    );
    const res = await dispatchTool({
      name: "get_account_health",
      args: {},
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content[0]?.text ?? "{}");
    expect(parsed.window).toBe("24h");
    expect(parsed.totals.errorRate).toBe(5);
    expect(parsed.summary).toBe("warn");
  });

  it("get_account_health survives partial endpoint failures", async () => {
    const fetchSpy = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/v1/audit-log"))
        return new Response("server error", { status: 500 });
      if (url.endsWith("/v1/query/aggregate"))
        return new Response(JSON.stringify({ total: { value: 0, count: 0 } }), {
          status: 200,
        });
      if (url.endsWith("/v1/query/percentiles"))
        return new Response(JSON.stringify({ p50: null, p95: null, p99: null, total: 0 }), {
          status: 200,
        });
      return new Response(JSON.stringify({ usedUsd: 0, monthlyLimitUsd: 10 }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const res = await dispatchTool({
      name: "get_account_health",
      args: { window: "1h" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content[0]?.text ?? "{}");
    expect(parsed.window).toBe("1h");
    expect(parsed.partialFailures).toContain("auditLog");
    expect(parsed.summary).toBe("ok");
  });

  it("export_calls uses POST /v1/query/export (regression for path/method drift)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ records: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const res = await dispatchTool({
      name: "export_calls",
      args: { provider: "openai", limit: 1000 },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const fetchedUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(fetchedUrl).toContain("/v1/query/export");
    expect(fetchedUrl).not.toContain("/v1/export?");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.provider).toBe("openai");
    expect(body.limit).toBe(1000);
  });

  it("list_alerts uses /v1/alerts endpoint", async () => {
    const res = await dispatchTool({
      name: "list_alerts",
      args: { includeTriggered: true },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
  });

  it("unknown tool returns isError", async () => {
    const res = await dispatchTool({
      name: "nonexistent_tool",
      args: {},
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("unknown tool");
  });

  it("forwards Bearer apiKey + UA header", async () => {
    await dispatchTool({
      name: "query_calls",
      args: {},
      apiKey: "argosvix_live_secret",
      apiBase: "https://ingest.example.com",
    });
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer argosvix_live_secret",
    );
    expect((init.headers as Record<string, string>)["User-Agent"]).toContain(
      "argosvix-mcp-server",
    );
  });

  it("non-200 response returns isError with status code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    const res = await dispatchTool({
      name: "query_calls",
      args: {},
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("500");
  });

  it("v0.9.2 = stderr log は default で raw body 不在 (= ARGOSVIX_MCP_DEBUG 未設定)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("backend internal secret", { status: 500 })),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env["ARGOSVIX_MCP_DEBUG"];
    try {
      await dispatchTool({
        name: "query_calls",
        args: {},
        apiKey: "argosvix_live_test",
        apiBase: "https://ingest.example.com",
      });
      const allLogged = spy.mock.calls
        .map((c) => String(c[0] ?? ""))
        .join("\n");
      expect(allLogged).toContain("/v1/query/calls -> 500");
      expect(allLogged).not.toContain("body=backend internal secret");
    } finally {
      spy.mockRestore();
    }
  });

  it("v0.9.2 = ARGOSVIX_MCP_DEBUG=1 で raw body を log に carry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("backend debug detail", { status: 500 })),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env["ARGOSVIX_MCP_DEBUG"] = "1";
    try {
      await dispatchTool({
        name: "query_calls",
        args: {},
        apiKey: "argosvix_live_test",
        apiBase: "https://ingest.example.com",
      });
      const allLogged = spy.mock.calls
        .map((c) => String(c[0] ?? ""))
        .join("\n");
      expect(allLogged).toContain("body=backend debug detail");
    } finally {
      delete process.env["ARGOSVIX_MCP_DEBUG"];
      spy.mockRestore();
    }
  });

  it("skips null/undefined body fields for query_calls (POST body)", async () => {
    await dispatchTool({
      name: "query_calls",
      args: { limit: 10, provider: null, model: undefined },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.limit).toBe(10);
    expect(body.provider).toBeUndefined();
    expect(body.model).toBeUndefined();
  });

  it("drops non-allowlisted args for query_calls body (= injection 防御 / Codex r4 HIGH 4 carry)", async () => {
    await dispatchTool({
      name: "query_calls",
      args: {
        limit: 50,
        account_id: "acc_other_user",
        endpoint: "/v1/admin/internal",
        __proto__: { malicious: true },
      },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const fetchedUrl = String(fetchMock.mock.calls[0]?.[0]);
    // path 自体は固定の /v1/query/calls (= injection で 変えられない)
    expect(fetchedUrl).toContain("/v1/query/calls");
    expect(fetchedUrl).not.toContain("/v1/admin/internal");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.limit).toBe(50);
    expect(body.account_id).toBeUndefined();
    expect(body.endpoint).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(body, "__proto__")).toBe(false);
  });

  it("get_cost_summary POSTs body with metric=cost + groupBy normalized", async () => {
    // 0.3.1-alpha.1 fix: groupBy='none' は backend に存在しないので 'provider' に正規化。
    await dispatchTool({
      name: "get_cost_summary",
      args: { rangePreset: "7d", groupBy: "none" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/query/aggregate");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.metric).toBe("cost");
    expect(body.groupBy).toBe("provider");
    expect(typeof body.startTime).toBe("string");
    expect(typeof body.endTime).toBe("string");
  });

  it("get_cost_summary rejects an out-of-schema groupBy (= silent 丸め 防止)", async () => {
    // Codex round 1 MEDIUM 1 fix: backend 内部 enum (= "day" / "tag") や typo を
    // 黙って provider に丸めずに errorResponse で明示 reject する。
    const res = await dispatchTool({
      name: "get_cost_summary",
      args: { rangePreset: "7d", groupBy: "day" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("invalid groupBy");
  });

  it("query_calls User-Agent header carries the current MCP_VERSION", async () => {
    // Codex round 1 LOW 2 fix: User-Agent が 旧 "0.1.0" 固定値だった bug を 動的版に carry。
    await dispatchTool({
      name: "query_calls",
      args: {},
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const ua = (init.headers as Record<string, string>)["User-Agent"];
    // Codex round 2 LOW 3 fix: prerelease (= "-alpha.1" 等) も 明示的に許可する semver
    // regex に carry (= prefix match の暗黙性を解消、 意図を明文化)。
    expect(ua).toMatch(
      /^argosvix-mcp-server\/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
    );
    // 旧固定値 (= 0.1.0) は 含まれない (= regression 防御)
    expect(ua).not.toBe("argosvix-mcp-server/0.1.0");
  });

  it("each tool inputSchema declares additionalProperties: false", () => {
    for (const t of tools) {
      const schema = t.inputSchema as { additionalProperties?: boolean };
      expect(schema.additionalProperties).toBe(false);
    }
  });

  it("silence_alert POSTs to /v1/alerts/:id/silence with JSON body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ silencedUntil: "2026-06-01T00:00:00Z" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const res = await dispatchTool({
      name: "silence_alert",
      args: { alertId: "alt-abc123", until: "2026-06-01T00:00:00Z" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/alerts/alt-abc123/silence");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      until: "2026-06-01T00:00:00Z",
    });
  });

  it("unsilence_alert sends DELETE without body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const res = await dispatchTool({
      name: "unsilence_alert",
      args: { alertId: "alt-xyz789" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    // 204 path = ok:true JSON で carry される
    const parsed = JSON.parse(res.content[0]?.text ?? "{}");
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe(204);
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });

  it("update_alert sends PATCH to /v1/alerts/:id with allowlisted body (= v1.6 #13-4)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: "alt-abc123", name: "renamed" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const res = await dispatchTool({
      name: "update_alert",
      args: {
        alertId: "alt-abc123",
        name: "renamed",
        thresholdValue: 50,
        enabled: false,
        // alertType は schema にないため呼び出し側で混入させない
      },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/alerts/alt-abc123");
    expect(url).not.toContain("/silence");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ name: "renamed", thresholdValue: 50, enabled: false });
    // alertId は path に carry、 body には混入しない
    expect(body.alertId).toBeUndefined();
  });

  it("update_alert rejects invalid alertId (= path injection 防御)", async () => {
    const res = await dispatchTool({
      name: "update_alert",
      args: { alertId: "../../admin/internal", name: "x" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("alertId required");
  });

  it("delete_alert sends DELETE to /v1/alerts/:id without body (= v1.6 #13-4)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const res = await dispatchTool({
      name: "delete_alert",
      args: { alertId: "alt-doomed42" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content[0]?.text ?? "{}");
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe(204);
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/alerts/alt-doomed42");
    expect(url).not.toContain("/silence");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });

  it("delete_alert rejects invalid alertId (= path injection 防御)", async () => {
    const res = await dispatchTool({
      name: "delete_alert",
      args: { alertId: "/etc/passwd" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("alertId required");
  });

  it("create_annotation POSTs allowlisted body to /v1/annotations (= v1.6 #13-3)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: 42, callId: "call-xyz" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const res = await dispatchTool({
      name: "create_annotation",
      args: {
        callId: "call-xyz",
        annotationText: "looks good",
        label: "approved",
        qualityScore: 5,
      },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/annotations");
    expect(url).not.toContain("/v1/annotations/");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      callId: "call-xyz",
      annotationText: "looks good",
      label: "approved",
      qualityScore: 5,
    });
  });

  it("create_annotation rejects invalid callId (= path injection 防御)", async () => {
    const res = await dispatchTool({
      name: "create_annotation",
      args: { callId: "../../admin", annotationText: "x" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("callId required");
  });

  it("update_annotation sends PATCH with allowlisted body (= v1.6 #13-3)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: 7, label: "renamed" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const res = await dispatchTool({
      name: "update_annotation",
      args: {
        annotationId: 7,
        label: "renamed",
        qualityScore: 4,
      },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/annotations/7");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ label: "renamed", qualityScore: 4 });
    // annotationId は path に carry、 body には混入しない
    expect(body.annotationId).toBeUndefined();
  });

  it("delete_annotation sends DELETE to /v1/annotations/:id without body (= v1.6 #13-3)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const res = await dispatchTool({
      name: "delete_annotation",
      args: { annotationId: 99 },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content[0]?.text ?? "{}");
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe(204);
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/annotations/99");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });

  it("create_prompt POSTs allowlisted body to /v1/prompts (= v1.6 #13-1)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: 42, name: "customer_support" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const res = await dispatchTool({
      name: "create_prompt",
      args: {
        name: "customer_support",
        version: "v1",
        template: "Hello {{user}}",
        variables: { user: "world" },
        labels: ["production"],
        description: "primary cs prompt",
      },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/prompts");
    expect(url).not.toContain("/v1/prompts/");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      name: "customer_support",
      version: "v1",
      template: "Hello {{user}}",
      variables: { user: "world" },
      labels: ["production"],
      description: "primary cs prompt",
    });
  });

  it("create_prompt rejects missing name/version/template (= v1.6 #13-1)", async () => {
    const res = await dispatchTool({
      name: "create_prompt",
      args: { name: "x" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("name + version + template required");
  });

  it("update_prompt sends PATCH to /v1/prompts/:id with allowlisted body (= v1.6 #13-1)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: 7, labels: ["production"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const res = await dispatchTool({
      name: "update_prompt",
      args: {
        promptId: 7,
        labels: ["production"],
        description: "renamed",
      },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/prompts/7");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ labels: ["production"], description: "renamed" });
    expect(body.promptId).toBeUndefined();
  });

  it("rename_prompt POSTs to /v1/prompts/:id/rename with name+version body (= v1.6 #13-1)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: 7, name: "customer_support" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const res = await dispatchTool({
      name: "rename_prompt",
      args: { promptId: 7, name: "customer_support", version: "v2" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/prompts/7/rename");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ name: "customer_support", version: "v2" });
  });

  it("rename_prompt rejects missing name/version (= v1.6 #13-1)", async () => {
    const res = await dispatchTool({
      name: "rename_prompt",
      args: { promptId: 7, name: "x" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("name + version required");
  });

  it("delete_prompt sends DELETE to /v1/prompts/:id without body (= v1.6 #13-1)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const res = await dispatchTool({
      name: "delete_prompt",
      args: { promptId: 99 },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content[0]?.text ?? "{}");
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe(204);
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/prompts/99");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });

  it("create_eval_criterion POSTs allowlisted body to /v1/eval-criteria (= v1.6 #13-2)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: 11, name: "helpfulness" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const res = await dispatchTool({
      name: "create_eval_criterion",
      args: {
        name: "helpfulness",
        rubric: "Score how helpful the answer is to the user.",
        scaleMin: 1,
        scaleMax: 5,
      },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/eval-criteria");
    expect(url).not.toContain("/v1/eval-criteria/");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      name: "helpfulness",
      rubric: "Score how helpful the answer is to the user.",
      scaleMin: 1,
      scaleMax: 5,
    });
  });

  it("create_eval_criterion rejects missing required fields (= v1.6 #13-2)", async () => {
    const res = await dispatchTool({
      name: "create_eval_criterion",
      args: { name: "x" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("name + rubric + scaleMin + scaleMax required");
  });

  it("create_webhook POSTs allowlisted body to /v1/webhooks (= 2026-06-27)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ webhooks: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const res = await dispatchTool({
      name: "create_webhook",
      args: {
        url: "https://example.com/hook",
        eventTypes: ["approval.requested"],
        secret: "shh",
        evil: "stripped",
      },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/webhooks");
    expect(url).not.toContain("/v1/webhooks/");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    // allowlist 外の "evil" は除去される
    expect(body.evil).toBeUndefined();
    expect(body.url).toBe("https://example.com/hook");
    expect(body.eventTypes).toEqual(["approval.requested"]);
  });

  it("create_webhook rejects missing url", async () => {
    const res = await dispatchTool({
      name: "create_webhook",
      args: {},
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("url required");
  });

  it("delete_webhook sends DELETE to /v1/webhooks/:id (owh_ id) without body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ webhooks: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const id = "owh_" + "a".repeat(24);
    const res = await dispatchTool({
      name: "delete_webhook",
      args: { webhookId: id },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain(`/v1/webhooks/${id}`);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });

  it("delete_webhook rejects malformed id (path injection 防御)", async () => {
    const res = await dispatchTool({
      name: "delete_webhook",
      args: { webhookId: "../../admin" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("webhookId required");
  });

  it("update_eval_criterion sends PATCH with full body to /v1/eval-criteria/:id (= v1.6 #13-2)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: 11, name: "renamed" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const res = await dispatchTool({
      name: "update_eval_criterion",
      args: {
        criterionId: 11,
        name: "renamed",
        rubric: "Updated rubric narrative here.",
        scaleMin: 1,
        scaleMax: 10,
      },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/eval-criteria/11");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      name: "renamed",
      rubric: "Updated rubric narrative here.",
      scaleMin: 1,
      scaleMax: 10,
    });
    expect(body.criterionId).toBeUndefined();
  });

  it("get_llm_budget hits /v1/account/llm-feature-budget GET (= v1.6 #13-7)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ budgetUsd: 5, spentUsd: 1.2, remainingUsd: 3.8 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const res = await dispatchTool({
      name: "get_llm_budget",
      args: {},
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/account/llm-feature-budget");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method ?? "GET").toBe("GET");
  });

  it("raise_llm_budget PATCHes /v1/account/llm-feature-budget with budgetUsd (= v1.6 #13-7)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ ok: true, budgetUsd: 30, spentUsd: 0, remainingUsd: 30 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const res = await dispatchTool({
      name: "raise_llm_budget",
      args: { budgetUsd: 30 },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/account/llm-feature-budget");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ budgetUsd: 30 });
  });

  it("raise_llm_budget rejects missing budgetUsd (= v1.6 #13-7)", async () => {
    const res = await dispatchTool({
      name: "raise_llm_budget",
      args: {},
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("budgetUsd required");
  });

  it("test_webhook POSTs allowlisted body to /v1/alerts/test-webhook (= v1.6 #13-5)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, delivered: true, message: "test webhook delivered" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const res = await dispatchTool({
      name: "test_webhook",
      args: {
        url: "https://example.com/hook",
        secret: "shhh",
        alertName: "test alert",
      },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/alerts/test-webhook");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      url: "https://example.com/hook",
      secret: "shhh",
      alertName: "test alert",
    });
  });

  it("test_webhook rejects missing url (= v1.6 #13-5)", async () => {
    const res = await dispatchTool({
      name: "test_webhook",
      args: { secret: "shhh" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("url required");
  });

  it("delete_eval_criterion sends DELETE to /v1/eval-criteria/:id without body (= v1.6 #13-2)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const res = await dispatchTool({
      name: "delete_eval_criterion",
      args: { criterionId: 11 },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content[0]?.text ?? "{}");
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe(204);
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/eval-criteria/11");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });

  it("silence_alert rejects invalid alertId (= path injection 防御)", async () => {
    const res = await dispatchTool({
      name: "silence_alert",
      args: { alertId: "../../admin/internal" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("alertId required");
  });

  it("silence_alert rejects missing alertId", async () => {
    const res = await dispatchTool({
      name: "silence_alert",
      args: { until: "2026-06-01T00:00:00Z" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBe(true);
  });

  it("create_alert POSTs allowlisted body to /v1/alerts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: "alert-new" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const res = await dispatchTool({
      name: "create_alert",
      args: {
        name: "Daily cost > $10",
        alertType: "cost_daily",
        thresholdValue: 10,
        windowMinutes: 1440,
        channelKinds: ["email"],
        channelTargets: { email: "dev@example.com" },
      },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/alerts");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body as string);
    expect(sent.name).toBe("Daily cost > $10");
    expect(sent.alertType).toBe("cost_daily");
    expect(sent.channelKinds).toEqual(["email"]);
    expect(sent.channelTargets).toEqual({ email: "dev@example.com" });
  });

  it("create_alert drops non-allowlisted body fields (= injection 防御)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: "alert-new" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await dispatchTool({
      name: "create_alert",
      args: {
        name: "x",
        alertType: "error_rate",
        thresholdValue: 5,
        channelKinds: ["email"],
        channelTargets: { email: "a@b.co" },
        account_id: "acc_evil",
        enabled: true,
      },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const sent = JSON.parse(init.body as string);
    expect(sent.account_id).toBeUndefined();
    expect(sent.enabled).toBe(true);
  });

  it("create_alert propagates a backend 403 (= plan 上限) as isError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "alert limit reached" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const res = await dispatchTool({
      name: "create_alert",
      args: {
        name: "x",
        alertType: "cost_daily",
        thresholdValue: 1,
        channelKinds: ["email"],
        channelTargets: { email: "a@b.co" },
      },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBe(true);
  });

  it("get_alert GETs /v1/alerts/:id with the alertId in the path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: "alt-abc", name: "Cost" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const res = await dispatchTool({
      name: "get_alert",
      args: { alertId: "alt-abc" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/alerts/alt-abc");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method ?? "GET").toBe("GET");
  });

  it("get_alert rejects an invalid alertId (= path injection 防御)", async () => {
    const res = await dispatchTool({
      name: "get_alert",
      args: { alertId: "../../admin" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("alertId required");
  });

  it("list_alert_events GETs /v1/alerts/events with limit + alertId query", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ events: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const res = await dispatchTool({
      name: "list_alert_events",
      args: { limit: 5, alertId: "alt-abc" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/alerts/events");
    expect(url).toContain("limit=5");
    expect(url).toContain("alertId=alt-abc");
  });

  it("acknowledge_alert POSTs to /v1/alerts/events/:eventId/acknowledge with source=mcp", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: "evt-abc",
            acknowledgedAt: "2026-05-31T03:00:00.000Z",
            acknowledgedBy: "mcp",
            alreadyAcknowledged: false,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );
    const res = await dispatchTool({
      name: "acknowledge_alert",
      args: { eventId: "evt-abc" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBeUndefined();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/alerts/events/evt-abc/acknowledge");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    // source は MCP server 側で 強制的に "mcp" carry (= LLM 経由で override 不可)
    expect(body.source).toBe("mcp");
  });

  it("acknowledge_alert rejects invalid eventId (= path injection 防御)", async () => {
    const res = await dispatchTool({
      name: "acknowledge_alert",
      args: { eventId: "../../admin" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("eventId required");
  });

  it("acknowledge_alert rejects missing eventId", async () => {
    const res = await dispatchTool({
      name: "acknowledge_alert",
      args: {},
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    expect(res.isError).toBe(true);
  });

  it("acknowledge_alert drops LLM-supplied source field (= 強制 mcp carry)", async () => {
    // LLM が source: "dashboard" を渡しても、 TOOL_ARG_ALLOWLIST.acknowledge_alert に
    // source が 含まれていないため drop され、 dispatch 側で source: "mcp" 固定が carry。
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: "evt-x" }), { status: 200 }),
      ),
    );
    await dispatchTool({
      name: "acknowledge_alert",
      args: { eventId: "evt-x", source: "dashboard" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.source).toBe("mcp");
  });

  it("list_alert_events drops non-allowlisted args (= injection 防御)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ events: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await dispatchTool({
      name: "list_alert_events",
      args: { limit: 5, account_id: "acc_evil" },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("limit=5");
    expect(url).not.toContain("account_id");
  });

  // 2026-06-09 v1.7 hygiene #13 carry = v1.5/v1.6 で追加した 7 safety/eval
  // read tools の path + method 固定 test。 既存は metadata gate のみで dispatch
  // path/body 軸の structural drift 防御がなかった軸を carry。
  // R51 LOW carry (2026-06-10): toContain → new URL(...).pathname + exact searchParams
  // で suffix/prefix drift を 構造的に検出 (= 旧 path = `/v1/eval-runs` が
  // `/v1/eval-runs/foo` でも pass する弱さを narrow)。

  function urlOf(call: unknown): URL {
    return new URL(String(call));
  }

  it("list_eval_criteria GETs /v1/eval-criteria", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ criteria: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await dispatchTool({
      name: "list_eval_criteria",
      args: {},
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const u = urlOf(fetchMock.mock.calls[0]?.[0]);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(u.pathname).toBe("/v1/eval-criteria");
    expect(Array.from(u.searchParams.keys())).toEqual([]);
    expect(init.method ?? "GET").toBe("GET");
  });

  it("get_eval_criterion GETs /v1/eval-criteria/:id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: 42, name: "accuracy" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await dispatchTool({
      name: "get_eval_criterion",
      args: { criterionId: 42 },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const u = urlOf(fetchMock.mock.calls[0]?.[0]);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(u.pathname).toBe("/v1/eval-criteria/42");
    expect(Array.from(u.searchParams.keys())).toEqual([]);
    expect(init.method ?? "GET").toBe("GET");
  });

  it("list_safety_assessments GETs /v1/safety-assessments with call_id + limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ assessments: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await dispatchTool({
      name: "list_safety_assessments",
      args: { callId: "call_abc123", limit: 25 },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const u = urlOf(fetchMock.mock.calls[0]?.[0]);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(u.pathname).toBe("/v1/safety-assessments");
    expect(u.searchParams.get("call_id")).toBe("call_abc123");
    expect(u.searchParams.get("limit")).toBe("25");
    expect(init.method ?? "GET").toBe("GET");
  });

  it("get_safety_assessment GETs /v1/safety-assessments/:id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: 7, flagged: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await dispatchTool({
      name: "get_safety_assessment",
      args: { assessmentId: 7 },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const u = urlOf(fetchMock.mock.calls[0]?.[0]);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(u.pathname).toBe("/v1/safety-assessments/7");
    expect(Array.from(u.searchParams.keys())).toEqual([]);
    expect(init.method ?? "GET").toBe("GET");
  });

  it("list_eval_runs GETs /v1/eval-runs with limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ runs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await dispatchTool({
      name: "list_eval_runs",
      args: { limit: 15 },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const u = urlOf(fetchMock.mock.calls[0]?.[0]);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(u.pathname).toBe("/v1/eval-runs");
    expect(u.searchParams.get("limit")).toBe("15");
    expect(init.method ?? "GET").toBe("GET");
  });

  it("get_eval_run GETs /v1/eval-runs/:id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: 99, status: "completed" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await dispatchTool({
      name: "get_eval_run",
      args: { runId: 99 },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const u = urlOf(fetchMock.mock.calls[0]?.[0]);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(u.pathname).toBe("/v1/eval-runs/99");
    expect(Array.from(u.searchParams.keys())).toEqual([]);
    expect(init.method ?? "GET").toBe("GET");
  });

  it("run_eval POSTs to /v1/eval-runs with name + recentCount + idempotencyKey", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: 100, status: "queued" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await dispatchTool({
      name: "run_eval",
      args: {
        name: "baseline-2026-06-09",
        recentCount: 30,
        idempotencyKey: "idem-abc",
      },
      apiKey: "argosvix_live_test",
      apiBase: "https://ingest.example.com",
    });
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const u = urlOf(fetchMock.mock.calls[0]?.[0]);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(u.pathname).toBe("/v1/eval-runs");
    expect(Array.from(u.searchParams.keys())).toEqual([]);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      name: "baseline-2026-06-09",
      recentCount: 30,
      idempotencyKey: "idem-abc",
    });
  });
});
