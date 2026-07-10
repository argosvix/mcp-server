/**
 * MCP resource definitions and reader.
 *
 * A resource is read-only data automatically provided to the AI agent as
 * context (tools are "called", resources are "read"). The host application
 * can pick them into context on its own, or embed them from a prompt as
 * `resource` content.
 *
 * Static resources exposed since v0.7.0-alpha.1:
 *   - argosvix://account        = snapshot of plan / quota / this month's record
 *                                 usage (/v1/account, a Bearer-only non-sensitive
 *                                 identity endpoint; excludes subscription detail)
 *   - argosvix://alerts/active  = list of enabled alerts (/v1/alerts, same path
 *                                 as list_alerts)
 *   - argosvix://cost/today     = cost aggregation for the last 24h
 *                                 (POST /v1/query/aggregate, equivalent to
 *                                 get_cost_summary(rangePreset=24h, groupBy=provider))
 *   - argosvix://calls/{id}     = a single LLM call record (GET /v1/query/calls/:id,
 *                                 resource template; lets the LLM pull a
 *                                 query_calls id directly into context)
 *
 * Dispatch / fetch conventions match tools.ts (POST + JSON body, MCP_VERSION in
 * User-Agent, redirect: error, Bearer auth) to avoid recurring 405 / 401 errors
 * from drifting away from the backend contract.
 */

import type {
  Resource,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/types.js";

import { MCP_VERSION } from "./version.js";
import { isDebugEnabled } from "./debug.js";

const ACCOUNT_URI = "argosvix://account";
const ALERTS_ACTIVE_URI = "argosvix://alerts/active";
const COST_TODAY_URI = "argosvix://cost/today";

// Resource template (URI template; the client substitutes an id to build a
// dynamic URI). Maps 1:1 to backend GET /v1/query/calls/:id.
const CALLS_TEMPLATE_URI = "argosvix://calls/{id}";
const CALL_URI_PATTERN = /^argosvix:\/\/calls\/([A-Za-z0-9_-]{1,128})$/;

// alerts/{id} resource template (via the existing backend GET /v1/alerts/:id;
// same endpoint as the get_alert tool, but exposed as a resource template so
// the host application can bring it into context).
const ALERTS_TEMPLATE_URI = "argosvix://alerts/{id}";
const ALERT_URI_PATTERN = /^argosvix:\/\/alerts\/([A-Za-z0-9-]{1,64})$/;

// traces/{id} resource template (via the backend GET /v1/query/trace/:id
// endpoint; brings the full picture of one trace = multiple spans into context
// via a URI). Large span counts (50+ is heavy for the LLM context budget) are
// capped by MAX_TRACE_SPANS.
const TRACES_TEMPLATE_URI = "argosvix://traces/{id}";
const TRACE_URI_PATTERN = /^argosvix:\/\/traces\/([A-Za-z0-9_-]{1,128})$/;

// annotations/{id} resource template (via backend GET /v1/annotations/:id;
// brings one annotation's review detail into context via a URI). Annotations
// use an AUTOINCREMENT integer id ([1-9]\d{0,9}); own-account scoping is
// structurally enforced by the backend WHERE clause. No sensitive PII, but
// annotation_text contains user-controlled strings, so it goes through
// sanitizeText.
const ANNOTATIONS_TEMPLATE_URI = "argosvix://annotations/{id}";
const ANNOTATION_URI_PATTERN = /^argosvix:\/\/annotations\/([1-9]\d{0,9})$/;

// eval-criteria/{id} resource template (via backend GET /v1/eval-criteria/:id;
// brings one criterion's rubric into context via a URI). Directly usable as
// the LLM-as-judge runner's instruction text, letting an AI agent
// automatically learn "what axes can I evaluate on". Both global defaults
// (accountId NULL) and the account's own custom criteria are visible; other
// accounts' custom criteria return 404 by structural defense. The rubric is a
// user-controlled string and goes through sanitizeText (hardening the prompt
// path boundary).
const EVAL_CRITERIA_TEMPLATE_URI = "argosvix://eval-criteria/{id}";
const EVAL_CRITERION_URI_PATTERN = /^argosvix:\/\/eval-criteria\/([1-9]\d{0,9})$/;

// prompts/{id} resource template (via backend GET /v1/prompts/:id; brings a
// user-registered prompt template into context via a URI). Lets an AI agent
// automatically pick up context like "this is the production customer-support
// prompt". Own-account scoping is structurally enforced by the backend WHERE
// clause. The template is user-controlled, so it goes through sanitizeText
// (50000 char cap; structural defense of the prompt injection path).
const PROMPTS_TEMPLATE_URI = "argosvix://prompts/{id}";
const PROMPT_URI_PATTERN = /^argosvix:\/\/prompts\/([1-9]\d{0,9})$/;

// safety-assessments/{id} resource template (via backend
// GET /v1/safety-assessments/:id; brings a single assessment written by the
// OpenAI Moderation cron into context via a URI). Includes labels (array of
// flagged categories) + score + reasoning + classifier_id, so an AI agent can
// grasp "which policy axes flagged this call?" in one fetch. Own-account
// scoping is structurally enforced by the backend WHERE clause.
const SAFETY_ASSESSMENT_TEMPLATE_URI = "argosvix://safety-assessments/{id}";
const SAFETY_ASSESSMENT_URI_PATTERN = /^argosvix:\/\/safety-assessments\/([1-9]\d{0,9})$/;

// eval-runs/{id} resource template (via backend GET /v1/eval-runs/:id; brings
// one eval run's summary + score list into context via a URI). An AI agent can
// grasp "the score distribution of the latest eval run" or "per-criterion
// averages" in one fetch. Own-account scoping is structurally enforced by the
// backend WHERE clause. Score reasoning (judge LLM output) goes through
// sanitizeText.
const EVAL_RUN_TEMPLATE_URI = "argosvix://eval-runs/{id}";
const EVAL_RUN_URI_PATTERN = /^argosvix:\/\/eval-runs\/([1-9]\d{0,9})$/;

export const resources: Resource[] = [
  {
    uri: ACCOUNT_URI,
    name: "account",
    title: "Argosvix アカウント情報",
    description:
      "現在の plan / quota / 今月の record 使用量 / retention 設定の snapshot。 " +
      "backend /v1/account (= Bearer 専用 read-only) を そのまま JSON で返す。 " +
      "subscription detail (= 次回課金日 / 自動更新フラグ / Stripe 状態) は 含まない。",
    mimeType: "application/json",
  },
  {
    uri: ALERTS_ACTIVE_URI,
    name: "alerts_active",
    title: "現 active alert 一覧",
    description:
      "enabled=true の alert 一覧 (= silenced も含む、 enabled=false は除外)。 " +
      "list_alerts tool が返す shape を snapshot として返す。 LLM が 「今何が監視されてる?」 を " +
      "自動的に context に取り込める用途。",
    mimeType: "application/json",
  },
  {
    uri: COST_TODAY_URI,
    name: "cost_today",
    title: "今日の cost summary",
    description:
      "直近 24 時間の cost 集計を provider 別 breakdown 付きで snapshot。 " +
      "get_cost_summary(rangePreset=\"24h\", groupBy=\"provider\") と同等の response、 " +
      "response.total フィールドで全体合計も同梱。",
    mimeType: "application/json",
  },
];

// Resource template list. The client calls resources/read with a URI where the
// template's {id} has been substituted. Own-account scoping is structurally
// enforced by the backend PK (account_id, id) — probing another account's id
// yields 404.
export const resourceTemplates: ResourceTemplate[] = [
  {
    uriTemplate: CALLS_TEMPLATE_URI,
    name: "call_detail",
    title: "LLM call 詳細",
    description:
      "単一 LLM call record (= provider / model / token / cost / latency / tags / " +
      "error / trace_id) を URI から 直接取得。 id は query_calls tool の response の " +
      "`records[].id` を そのまま使う。 自 account scope (= backend PK 経路) で 他 " +
      "account の id を 試行的に組んでも 404 で 構造防御。 例: argosvix://calls/abc123",
    mimeType: "application/json",
  },
  {
    uriTemplate: ALERTS_TEMPLATE_URI,
    name: "alert_detail",
    title: "Alert 設定 + 直近 trigger 履歴",
    description:
      "単一 alert の rule 設定 (= name / type / threshold / window / filter / " +
      "channel kinds / sleep / enabled / silencedUntil) と 直近 20 件の trigger 履歴を " +
      "URI から 直接取得。 id は list_alerts tool の response の `alerts[].id` を " +
      "そのまま使う。 channelTargets (= 通知先 email / webhook URL = sensitive) は " +
      "構造的に drop し、 channelKinds (= 種別 enum) のみ carry する。 例: " +
      "argosvix://alerts/alt-abc123",
    mimeType: "application/json",
  },
  {
    uriTemplate: TRACES_TEMPLATE_URI,
    name: "trace_detail",
    title: "Trace 全体 (= 複数 spans = 1 trace の time-series)",
    description:
      "単一 trace の全 spans (= 同 trace_id 内の LLM call の時系列) を URI から 直接 " +
      "取得。 id は query_calls / list_alerts tool の response に 含まれる traceId、 " +
      "ま た は dashboard の trace URL から copy。 spans は 上位 50 件で cap (= LLM " +
      "context budget)、 errorDetails / requestMeta は 構造的に drop。 例: " +
      "argosvix://traces/trace-abc123",
    mimeType: "application/json",
  },
  {
    uriTemplate: ANNOTATIONS_TEMPLATE_URI,
    name: "annotation_detail",
    title: "Annotation 1 件 (= user 自身の評価 / コメント)",
    description:
      "単一 annotation の本文 (= annotationText) + label + qualityScore (1-5) + " +
      "callId / createdAt / updatedAt を URI から 直接取得。 id は list_annotations_* " +
      "tool の response の annotation.id を そのまま使う (= AUTOINCREMENT integer)。 " +
      "annotationText は user-controlled なので sanitizeText (= 制御文字 strip + " +
      "2000 字 cap) 経由で carry、 prompt injection 経路を 構造防御。 自 account scope " +
      "は backend WHERE 句で 構造防御 (= 他 account の id は 404)。 例: " +
      "argosvix://annotations/42",
    mimeType: "application/json",
  },
  {
    uriTemplate: EVAL_CRITERIA_TEMPLATE_URI,
    name: "eval_criterion_detail",
    title: "Eval criterion 1 件 (= LLM-as-judge の評価軸)",
    description:
      "単一 evaluation criterion の rubric (= judge への instruction text) + scaleMin / scaleMax + " +
      "name + createdAt を URI から 直接取得。 id は list_eval_criteria tool の response の " +
      "criteria[].id。 global default (= accountId NULL) と 自 account custom の両方を visible、 " +
      "他 account custom は backend WHERE 句で 構造防御 (= 404)。 rubric は user-controlled " +
      "string なので sanitizeText (= 制御文字 strip + 4000 字 cap、 judge instruction が長文 " +
      "になり得るため annotation より cap 大き目) 経由で carry。 例: argosvix://eval-criteria/1",
    mimeType: "application/json",
  },
  {
    uriTemplate: PROMPTS_TEMPLATE_URI,
    name: "prompt_detail",
    title: "Prompt template 1 件 (= user 登録の saved prompt + versioning + labels)",
    description:
      "単一 prompt template の name / version / template (= 本文) / variables (= placeholder 仕様) / " +
      "labels (= production / staging 等の deploy 軸) / description / createdAt / updatedAt を URI から " +
      "直接取得。 id は list_prompts tool の response の prompts[].id。 自 account scope は " +
      "backend WHERE 句で 構造防御 (= 他 account の id は 404)。 template は user-controlled で " +
      "sanitizeText (= 50000 char cap、 prompt injection 経路 構造防御) 経由 carry。 例: argosvix://prompts/42",
    mimeType: "application/json",
  },
  {
    uriTemplate: SAFETY_ASSESSMENT_TEMPLATE_URI,
    name: "safety_assessment_detail",
    title: "Safety assessment 1 件 (= OpenAI Moderation 結果)",
    description:
      "単一 safety assessment の labels (= flagged category 配列) / score (= max category score 0-1) / " +
      "reasoning (= 「flagged: harassment, hate」 narrative) / classifier_id (= openai-moderation-omni-2026 等) / " +
      "source (= 'cron' / 'mcp' (= classify_calls_batch on-demand) / 'human_override' / 'api' / 'auto') / createdAt " +
      "を URI から 直接取得。 id は list_safety_assessments tool の response の " +
      "assessments[].id。 自 account scope は backend WHERE 句で 構造防御。 reasoning は LLM-controlled " +
      "narrative なので sanitizeText (= 制御文字 strip + 4000 字 cap) 経由 carry。 例: argosvix://safety-assessments/42",
    mimeType: "application/json",
  },
  {
    uriTemplate: EVAL_RUN_TEMPLATE_URI,
    name: "eval_run_detail",
    title: "Eval run 1 件 + 各 score 一覧",
    description:
      "単一 eval run の name / status / judge_provider / judge_model / summary (= scoredCount / failedCount / " +
      "meanScoreByCriterion) と 各 (criterion × call) score 配列 (= score / reasoning / criterionId / callId) を URI から " +
      "直接取得。 id は list_eval_runs tool の response の runs[].id。 自 account scope は backend WHERE 句で " +
      "構造防御。 reasoning (= judge LLM 出力) は user-effectively-controlled なので sanitizeText (= 4000 字 cap) 経由 " +
      "carry。 例: argosvix://eval-runs/42",
    mimeType: "application/json",
  },
];

export interface ReadResourceInput {
  uri: string;
  apiKey: string;
  apiBase: string;
}

export interface ResourceContentText {
  uri: string;
  mimeType: string;
  text: string;
}

export class ResourceNotFoundError extends Error {
  constructor(public uri: string) {
    super(`resource not found: ${uri}`);
    this.name = "ResourceNotFoundError";
  }
}

export async function readResource(
  input: ReadResourceInput,
): Promise<{ contents: ResourceContentText[] }> {
  const { uri, apiKey, apiBase } = input;

  // Match resource templates (argosvix://calls/{id} / argosvix://alerts/{id})
  // before the switch. Evaluating dynamic expressions in switch cases is
  // undesirable for TS and readability, so templates are dispatched early here.
  const callMatch = CALL_URI_PATTERN.exec(uri);
  if (callMatch) {
    const callId = callMatch[1]!;
    const json = await fetchJson(
      apiBase,
      `/v1/query/calls/${encodeURIComponent(callId)}`,
      apiKey,
      { method: "GET" },
    );
    // The shape gate (assertCallShape) alone would still stream the backend
    // response's raw JSON to the LLM, leaving a risk that user-controlled JSON
    // (errorDetails / requestMeta) or future backend fields flow into the
    // prompt-injection path. projectCallForMcp routes it through an explicit
    // allowlist instead.
    const projected = projectCallForMcp(json);
    return wrapJsonContent(uri, projected);
  }
  // The alerts/{id} template would also capture "active", so the exact-match
  // ALERTS_ACTIVE_URI (the list) is excluded before the template. Without this,
  // alerts/active gets misrouted to a single fetch with id="active", breaking
  // the list resource.
  const alertMatch =
    uri === ALERTS_ACTIVE_URI ? null : ALERT_URI_PATTERN.exec(uri);
  if (alertMatch) {
    const alertId = alertMatch[1]!;
    const json = await fetchJson(
      apiBase,
      `/v1/alerts/${encodeURIComponent(alertId)}`,
      apiKey,
      { method: "GET" },
    );
    // Same pattern as the call projection: the projection allowlist
    // structurally drops channelTargets (notification destinations =
    // sensitive) and accountId (internal).
    const projected = projectAlertForMcp(json);
    return wrapJsonContent(uri, projected);
  }
  const traceMatch = TRACE_URI_PATTERN.exec(uri);
  if (traceMatch) {
    const traceId = traceMatch[1]!;
    const json = await fetchJson(
      apiBase,
      `/v1/query/trace/${encodeURIComponent(traceId)}`,
      apiKey,
      { method: "GET" },
    );
    // Span cap + per-span allowlist structurally defend against context bloat
    // and leaking sensitive data.
    const projected = projectTraceForMcp(json);
    return wrapJsonContent(uri, projected);
  }
  const annotationMatch = ANNOTATION_URI_PATTERN.exec(uri);
  if (annotationMatch) {
    const annotationId = annotationMatch[1]!;
    const json = await fetchJson(
      apiBase,
      `/v1/annotations/${encodeURIComponent(annotationId)}`,
      apiKey,
      { method: "GET" },
    );
    // annotationText (user-controlled) goes through sanitizeText, structurally
    // defending the PII / prompt-injection path. createdByUserId (internal
    // sub) is dropped.
    const projected = projectAnnotationForMcp(json);
    return wrapJsonContent(uri, projected);
  }
  const criterionMatch = EVAL_CRITERION_URI_PATTERN.exec(uri);
  if (criterionMatch) {
    const criterionId = criterionMatch[1]!;
    const json = await fetchJson(
      apiBase,
      `/v1/eval-criteria/${encodeURIComponent(criterionId)}`,
      apiKey,
      { method: "GET" },
    );
    // The rubric (user-controlled judge instruction) goes through sanitizeText.
    // accountId is dropped by the projection (internal scope; its null/string
    // value does convey plan-related meaning and the dashboard shows it, but
    // it is unnecessary in MCP context).
    const projected = projectCriterionForMcp(json);
    return wrapJsonContent(uri, projected);
  }
  const promptMatch = PROMPT_URI_PATTERN.exec(uri);
  if (promptMatch) {
    const promptId = promptMatch[1]!;
    const json = await fetchJson(
      apiBase,
      `/v1/prompts/${encodeURIComponent(promptId)}`,
      apiKey,
      { method: "GET" },
    );
    // The template (user-controlled prompt text) goes through sanitizeText;
    // accountId / createdByUserId are dropped by the projection (internal
    // scope).
    const projected = projectPromptForMcp(json);
    return wrapJsonContent(uri, projected);
  }
  const safetyMatch = SAFETY_ASSESSMENT_URI_PATTERN.exec(uri);
  if (safetyMatch) {
    const assessmentId = safetyMatch[1]!;
    const json = await fetchJson(
      apiBase,
      `/v1/safety-assessments/${encodeURIComponent(assessmentId)}`,
      apiKey,
      { method: "GET" },
    );
    const projected = projectSafetyAssessmentForMcp(json);
    return wrapJsonContent(uri, projected);
  }
  const evalRunMatch = EVAL_RUN_URI_PATTERN.exec(uri);
  if (evalRunMatch) {
    const runId = evalRunMatch[1]!;
    const json = await fetchJson(
      apiBase,
      `/v1/eval-runs/${encodeURIComponent(runId)}`,
      apiKey,
      { method: "GET" },
    );
    const projected = projectEvalRunForMcp(json);
    return wrapJsonContent(uri, projected);
  }

  switch (uri) {
    case ACCOUNT_URI: {
      const json = await fetchJson(apiBase, "/v1/account", apiKey, {
        method: "GET",
      });
      // Fail-closed validation of the account response shape. As with
      // alerts/active, this structurally defends against the risk that the
      // backend accidentally adds a field (e.g. PII) in the future and it
      // flows to the LLM while the "non-sensitive" assumption no longer holds.
      // Unexpected shapes throw, surfacing as InternalError rather than
      // ResourceNotFoundError.
      assertAccountShape(json);
      return wrapJsonContent(uri, json);
    }
    case ALERTS_ACTIVE_URI: {
      const raw = await fetchJson(apiBase, "/v1/alerts", apiKey, {
        method: "GET",
      });
      const filtered = filterEnabledAlerts(raw);
      return wrapJsonContent(uri, filtered);
    }
    case COST_TODAY_URI: {
      // The backend `/v1/query/aggregate` is POST-only with an ISO range body.
      // Uses the same path as tools.ts. The last 24h are computed back from now.
      const now = Date.now();
      const start = new Date(now - 24 * 3600 * 1000).toISOString();
      const end = new Date(now).toISOString();
      const json = await fetchJson(apiBase, "/v1/query/aggregate", apiKey, {
        method: "POST",
        jsonBody: {
          startTime: start,
          endTime: end,
          groupBy: "provider",
          metric: "cost",
        },
      });
      return wrapJsonContent(uri, json);
    }
    default:
      throw new ResourceNotFoundError(uri);
  }
}

function wrapJsonContent(
  uri: string,
  json: unknown,
): { contents: ResourceContentText[] } {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(json, null, 2),
      },
    ],
  };
}

async function fetchJson(
  apiBase: string,
  path: string,
  apiKey: string,
  opts: { method: "GET" | "POST"; jsonBody?: Record<string, unknown> },
): Promise<unknown> {
  const url = new URL(path, apiBase);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "User-Agent": `argosvix-mcp-server/${MCP_VERSION}`,
  };
  const init: RequestInit = {
    method: opts.method,
    headers,
    redirect: "error",
  };
  if (opts.jsonBody !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.jsonBody);
  }
  const res = await fetch(url.toString(), init);
  if (!res.ok) {
    // Never expose the backend error body directly to the LLM: it can contain
    // internal identifiers / PII / internal implementation messages. When
    // detailed debugging is needed, the raw body is logged to the server's
    // stderr (operator only); the client only gets status + path. If
    // x-request-id is present it is included for correlation.
    const rawBody = await res.text().catch(() => "");
    const requestId = res.headers.get("x-request-id") ?? undefined;
    // eslint-disable-next-line no-console
    console.error(
      `[argosvix-mcp/resources] ${path} -> ${res.status}` +
        (requestId ? ` requestId=${requestId}` : "") +
        (isDebugEnabled() && rawBody ? ` body=${rawBody.slice(0, 300)}` : ""),
    );
    throw new Error(
      `Argosvix API ${path} failed with status ${res.status}` +
        (requestId ? ` (requestId=${requestId})` : ""),
    );
  }
  return await res.json();
}

/**
 * Fail-closed validation of the /v1/account response shape. Structurally
 * defends against the risk that the LLM ingests unexpected backend fields into
 * context under the "non-sensitive" assumption. Throws on anything unexpected.
 *
 * This is allowlist-style validation: extra fields beyond the expected ones
 * pass through, but if a required field's type or presence breaks, it fails
 * closed. Additive backend fields remain compatible (supporting the operation
 * of rolling-deploying only the backend without updating the MCP server),
 * while format drift in required fields is detected immediately.
 */
export function assertAccountShape(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("unexpected /v1/account response shape (not an object)");
  }
  const obj = raw as Record<string, unknown>;
  const account = obj["account"];
  const usage = obj["usage"];
  if (typeof account !== "object" || account === null) {
    throw new Error(
      "unexpected /v1/account response shape (missing or invalid account)",
    );
  }
  if (typeof usage !== "object" || usage === null) {
    throw new Error(
      "unexpected /v1/account response shape (missing or invalid usage)",
    );
  }
  const a = account as Record<string, unknown>;
  const u = usage as Record<string, unknown>;
  if (typeof a["id"] !== "string") {
    throw new Error("unexpected /v1/account.account.id (expected string)");
  }
  if (typeof a["plan"] !== "string") {
    throw new Error("unexpected /v1/account.account.plan (expected string)");
  }
  if (typeof a["retentionDays"] !== "number") {
    throw new Error(
      "unexpected /v1/account.account.retentionDays (expected number)",
    );
  }
  // createdAt is a required field, gated to "an ISO 8601-like string or null":
  //   - missing → throw
  //   - null → passes (consistent with the backend's toIsoOrNull null fallback
  //     on Date.parse failure)
  //   - empty string / un-parseable string / non-string → throw
  // The backend is assumed to normalize this, but if an invalid value arrives
  // via another backend path or future drift, this structurally prevents the
  // LLM from taking an "invalid date" into context.
  if (!("createdAt" in a)) {
    throw new Error(
      "unexpected /v1/account.account.createdAt (missing required field)",
    );
  }
  const createdAt = a["createdAt"];
  if (createdAt !== null) {
    if (typeof createdAt !== "string") {
      throw new Error(
        "unexpected /v1/account.account.createdAt (expected ISO-8601 string|null)",
      );
    }
    if (
      createdAt.length === 0 ||
      Number.isNaN(Date.parse(createdAt))
    ) {
      throw new Error(
        "unexpected /v1/account.account.createdAt (expected ISO-8601 string|null)",
      );
    }
  }
  if (typeof u["recordsThisMonth"] !== "number") {
    throw new Error(
      "unexpected /v1/account.usage.recordsThisMonth (expected number)",
    );
  }
  if (typeof u["quotaRecordsPerMonth"] !== "number") {
    throw new Error(
      "unexpected /v1/account.usage.quotaRecordsPerMonth (expected number)",
    );
  }
  if (typeof u["yearMonth"] !== "string") {
    throw new Error(
      "unexpected /v1/account.usage.yearMonth (expected string)",
    );
  }
}

/**
 * Same fail-closed pattern as assertAccountShape, for /v1/query/calls/:id.
 * The backend response has the shape `{ call: { id, provider, model, ... } }`.
 * Gates the type and presence of required fields; violations throw and surface
 * as McpError.InternalError. Additive fields pass through (rolling-deploy
 * compatible).
 */
export function assertCallShape(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("unexpected /v1/query/calls/:id response shape (not an object)");
  }
  const obj = raw as Record<string, unknown>;
  const call = obj["call"];
  if (typeof call !== "object" || call === null) {
    throw new Error(
      "unexpected /v1/query/calls/:id response shape (missing or invalid call)",
    );
  }
  const c = call as Record<string, unknown>;
  if (typeof c["id"] !== "string") {
    throw new Error("unexpected /v1/query/calls/:id call.id (expected string)");
  }
  if (typeof c["provider"] !== "string") {
    throw new Error(
      "unexpected /v1/query/calls/:id call.provider (expected string)",
    );
  }
  if (typeof c["model"] !== "string") {
    throw new Error("unexpected /v1/query/calls/:id call.model (expected string)");
  }
  if (typeof c["timestamp"] !== "string") {
    throw new Error(
      "unexpected /v1/query/calls/:id call.timestamp (expected string)",
    );
  }
  if (typeof c["totalTokens"] !== "number") {
    throw new Error(
      "unexpected /v1/query/calls/:id call.totalTokens (expected number)",
    );
  }
  if (typeof c["costUsd"] !== "number") {
    throw new Error(
      "unexpected /v1/query/calls/:id call.costUsd (expected number)",
    );
  }
  if (typeof c["latencyMs"] !== "number") {
    throw new Error(
      "unexpected /v1/query/calls/:id call.latencyMs (expected number)",
    );
  }
}

/**
 * Replaces raw JSON pass-through of the backend response with an explicit
 * allowlist of fields that flow into LLM context. Drops the user-controlled
 * JSON parts (errorDetails / requestMeta = internal stack traces / debug-only
 * fields), structurally defending against prompt injection and internal
 * implementation leakage.
 *
 * Included: id / provider / model / timestamp, the token / cost / latency
 * numerics, tags (used by the LLM for analysis; note the terms of service
 * prohibit users from putting PII in tags), and the error + trace ID group
 * (for debug agents and trace navigation).
 *
 * Excluded (dropped): errorDetails (internal stack trace), requestMeta
 * (internal implementation detail), and any unknown fields the backend adds in
 * the future.
 */
function projectCallForMcp(raw: unknown): unknown {
  assertCallShape(raw);
  const c = (raw as { call: Record<string, unknown> }).call;
  const projected: Record<string, unknown> = {
    id: c["id"],
    provider: c["provider"],
    model: c["model"],
    timestamp: c["timestamp"],
    totalTokens: c["totalTokens"],
    costUsd: c["costUsd"],
    latencyMs: c["latencyMs"],
  };
  // Optional number / object / string fields are individually checked for
  // presence and expected type before being carried over.
  if (typeof c["promptTokens"] === "number") projected["promptTokens"] = c["promptTokens"];
  if (typeof c["completionTokens"] === "number") {
    projected["completionTokens"] = c["completionTokens"];
  }
  // tags is a user-defined Record<string, string|number|boolean> carried for
  // LLM analysis; including PII in tags violates the Terms of Service and is
  // the user's responsibility. The prompt surface boundary is hardened:
  // sanitizeTags structurally defends against nested objects / arrays / huge
  // strings / control characters, minimizing unexpected data flowing into MCP
  // prompt context.
  const sanitized = sanitizeTags(c["tags"]);
  if (sanitized !== undefined) projected["tags"] = sanitized;
  // error is string | null (a summary message); errorDetails (stack trace /
  // internal) is dropped.
  if (typeof c["error"] === "string" || c["error"] === null) {
    projected["error"] = c["error"];
  }
  // Trace-navigation ID group (valuable for other resource templates and
  // dashboard jump paths).
  if (typeof c["traceId"] === "string" || c["traceId"] === null) {
    projected["traceId"] = c["traceId"];
  }
  if (typeof c["spanId"] === "string" || c["spanId"] === null) {
    projected["spanId"] = c["spanId"];
  }
  if (typeof c["parentSpanId"] === "string" || c["parentSpanId"] === null) {
    projected["parentSpanId"] = c["parentSpanId"];
  }
  return { call: projected };
}

/**
 * Shape gate for the alerts/{id} resource template. The backend response has
 * the `{ alert: {...}, events: [...] }` shape (/v1/alerts/:id). Gates required
 * fields' type and presence fail-closed; violations throw and surface as
 * McpError.InternalError. Each events entry is only object-checked here; its
 * inner fields are handled on the projection side.
 */
export function assertAlertShape(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(
      "unexpected /v1/alerts/:id response shape (not an object)",
    );
  }
  const obj = raw as Record<string, unknown>;
  const alert = obj["alert"];
  if (typeof alert !== "object" || alert === null) {
    throw new Error(
      "unexpected /v1/alerts/:id response shape (missing or invalid alert)",
    );
  }
  const a = alert as Record<string, unknown>;
  if (typeof a["id"] !== "string") {
    throw new Error("unexpected /v1/alerts/:id alert.id (expected string)");
  }
  if (typeof a["name"] !== "string") {
    throw new Error("unexpected /v1/alerts/:id alert.name (expected string)");
  }
  if (typeof a["alertType"] !== "string") {
    throw new Error(
      "unexpected /v1/alerts/:id alert.alertType (expected string)",
    );
  }
  if (typeof a["enabled"] !== "boolean") {
    throw new Error(
      "unexpected /v1/alerts/:id alert.enabled (expected boolean)",
    );
  }
  // Type-drift detection for optional numeric fields (type-checked only when
  // present; absence is OK, type violations throw).
  if ("thresholdValue" in a && typeof a["thresholdValue"] !== "number") {
    throw new Error(
      "unexpected /v1/alerts/:id alert.thresholdValue (expected number)",
    );
  }
  if ("windowMinutes" in a && typeof a["windowMinutes"] !== "number") {
    throw new Error(
      "unexpected /v1/alerts/:id alert.windowMinutes (expected number)",
    );
  }
  // events must be an array; element shapes are handled on the projection side.
  const events = obj["events"];
  if (!Array.isArray(events)) {
    throw new Error(
      "unexpected /v1/alerts/:id response shape (missing or invalid events array)",
    );
  }
}

/**
 * Projection allowlist for alerts/{id}. Structurally drops the sensitive
 * fields the backend returns (channelTargets = notification email / webhook
 * URLs, accountId = internal scope) and explicitly restricts what is carried
 * into LLM context.
 *   - alert: id / name / alertType / thresholdValue / windowMinutes /
 *     filterProvider / filterModel / channelKinds / sleepMinutes / enabled /
 *     createdAt / updatedAt / silencedUntil
 *   - events: id / triggeredAt / observedValue / channelsSent (+ ack if that
 *     ever gets added)
 * channelKinds is a string array (the ChannelKind enum); channelTargets is
 * dropped.
 */
// Cap on event count to defend against context bloat / DoS. The backend is
// expected to return LIMIT 20, but the MCP side caps too in case of spec
// drift or an experimental endpoint returning a large batch.
const MAX_ALERT_EVENTS = 20;

// Limits channel kinds to the known enum (structurally defending the path
// where unknown strings get carried into the prompt). Kept in sync with the
// backend `ChannelKind` enum.
// Exported so the drift-gate test in resources.test.ts can verify an exact
// match with the backend CHANNEL_KINDS in CI (structural defense against the
// silent-degradation case where the backend adds a new kind and the MCP
// server quietly drops it).
// "pagerduty" was added when the PagerDuty channel shipped.
export const ALLOWED_CHANNEL_KINDS = new Set<string>([
  "email",
  "slack",
  "webhook",
  "discord",
  "teams",
  "pagerduty",
]);

/**
 * Plan-skip sentinel carried in channels_sent. Kept in sync with
 * SKIPPED_BY_PLAN_SENTINEL in the backend's types.ts (guarded by a drift-gate
 * test in CI). filterChannelKinds passes the sentinel through, so the MCP
 * client (AI agent) can accurately observe "events skipped due to plan".
 */
export const SKIPPED_BY_PLAN_SENTINEL = "__skipped_by_plan__";

function filterChannelKinds(xs: unknown[]): string[] {
  return xs.filter(
    (k): k is string =>
      typeof k === "string" &&
      (ALLOWED_CHANNEL_KINDS.has(k) || k === SKIPPED_BY_PLAN_SENTINEL),
  );
}

// Defends the alert.name prompt-injection path (control-character strip +
// 100-char cap). The backend's create_alert already gates the name with the
// pattern `^[^\r\n]{1,100}$`, but the MCP side keeps its own boundary too
// (protecting against values from old rows or other write paths).
const MAX_ALERT_NAME_LENGTH = 100;
function sanitizeAlertName(v: unknown): string | undefined {
  // Shares the implementation via sanitizeText. sanitizeText returns null for
  // null, but alert.name is never expected to be null (a non-string is
  // dropped as undefined = string-type violation), so the result is used as-is.
  const result = sanitizeText(v, MAX_ALERT_NAME_LENGTH);
  return typeof result === "string" ? result : undefined;
}

/**
 * Shared helper that allowlist-projects a single alert object.
 * WARNING: channelTargets (webhook URL / secret / PagerDuty key / email) and
 * accountId are dropped deliberately (prevents leaking secrets / PII into LLM
 * context). Both the list and detail paths go through this single place,
 * structurally eliminating raw passthrough.
 */
function projectAlertObject(a: Record<string, unknown>): Record<string, unknown> {
  const projAlert: Record<string, unknown> = {
    id: a["id"],
    alertType: a["alertType"],
    enabled: a["enabled"],
  };
  // name goes through sanitization. If the sanitized result is empty (all
  // control characters), treat it as a shape-gate violation and throw (a
  // display name is required).
  const safeName = sanitizeAlertName(a["name"]);
  if (safeName === undefined || safeName.length === 0) {
    throw new Error(
      "unexpected alert.name (expected non-empty string after sanitize)",
    );
  }
  projAlert["name"] = safeName;
  // Optional number / string / array fields are carried over individually.
  if (typeof a["thresholdValue"] === "number") {
    projAlert["thresholdValue"] = a["thresholdValue"];
  }
  if (typeof a["windowMinutes"] === "number") {
    projAlert["windowMinutes"] = a["windowMinutes"];
  }
  if (typeof a["sleepMinutes"] === "number") {
    projAlert["sleepMinutes"] = a["sleepMinutes"];
  }
  if (typeof a["filterProvider"] === "string" || a["filterProvider"] === null) {
    projAlert["filterProvider"] = a["filterProvider"];
  }
  if (typeof a["filterModel"] === "string" || a["filterModel"] === null) {
    projAlert["filterModel"] = a["filterModel"];
  }
  if (Array.isArray(a["channelKinds"])) {
    // Only the ChannelKind enum set is accepted (unknown strings are dropped).
    projAlert["channelKinds"] = filterChannelKinds(a["channelKinds"] as unknown[]);
  }
  if (typeof a["createdAt"] === "string") projAlert["createdAt"] = a["createdAt"];
  if (typeof a["updatedAt"] === "string") projAlert["updatedAt"] = a["updatedAt"];
  if (typeof a["silencedUntil"] === "string" || a["silencedUntil"] === null) {
    projAlert["silencedUntil"] = a["silencedUntil"];
  }
  return projAlert;
}

function projectAlertForMcp(raw: unknown): unknown {
  assertAlertShape(raw);
  const obj = raw as { alert: Record<string, unknown>; events: unknown[] };
  const a = obj.alert;
  const projAlert = projectAlertObject(a);
  // Events are projected individually too: capped at MAX_ALERT_EVENTS, and
  // channelsSent also goes through the enum allowlist.
  const projEvents = (obj.events as unknown[])
    .slice(0, MAX_ALERT_EVENTS)
    .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
    .map((e) => {
      const out: Record<string, unknown> = {};
      if (typeof e["id"] === "string") out["id"] = e["id"];
      if (typeof e["triggeredAt"] === "string") out["triggeredAt"] = e["triggeredAt"];
      if (typeof e["observedValue"] === "number") {
        out["observedValue"] = e["observedValue"];
      }
      if (Array.isArray(e["channelsSent"])) {
        out["channelsSent"] = filterChannelKinds(e["channelsSent"] as unknown[]);
      }
      return out;
    });
  return { alert: projAlert, events: projEvents };
}

/**
 * Shape gate for the traces/{id} resource template. The backend response shape
 * is `{ trace: { id: string, spans: [...] } }`. Only the required fields
 * around the spans array are checked here; per-field projection happens in
 * projectTraceForMcp.
 */
export function assertTraceShape(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(
      "unexpected /v1/query/trace/:id response shape (not an object)",
    );
  }
  const obj = raw as Record<string, unknown>;
  const trace = obj["trace"];
  if (typeof trace !== "object" || trace === null) {
    throw new Error(
      "unexpected /v1/query/trace/:id response shape (missing or invalid trace)",
    );
  }
  const t = trace as Record<string, unknown>;
  if (typeof t["id"] !== "string") {
    throw new Error(
      "unexpected /v1/query/trace/:id trace.id (expected string)",
    );
  }
  if (!Array.isArray(t["spans"])) {
    throw new Error(
      "unexpected /v1/query/trace/:id trace.spans (expected array)",
    );
  }
}

/**
 * Projection allowlist for traces/{id}. Spans are capped at the top 50, and
 * each span goes through an allowlist (errorDetails / requestMeta = internal
 * debug info are dropped; tags via sanitizeTags, error via sanitizeText). The
 * backend uses LIMIT 500, but a 50 cap is appropriate for the LLM context
 * budget. The response's meta returns the original span count and a truncated
 * flag so the user can detect the cap's effect.
 *
 * Hardening notes:
 *   - error strings are sanitized via sanitizeText (512-char cap +
 *     control-character strip)
 *   - meta.originalSpans / returnedSpans / truncated eliminate silent truncation
 *   - filter-then-slice ordering avoids over-dropping when malformed elements
 *     appear first
 */
const MAX_TRACE_SPANS = 50;
const MAX_ERROR_TEXT_LENGTH = 512;

/**
 * sanitizeText is exported and unit-tested directly. Used for the traces/{id}
 * error field and for any future text fields following the same pattern.
 *   - null passes through as null (preserving the "explicitly absent" semantic)
 *   - strings are sliced to maxLength and control characters (U+0000 through
 *     U+001F plus U+007F) are stripped
 *   - non-strings are dropped as undefined
 */
export function sanitizeText(
  input: unknown,
  maxLength: number,
): string | null | undefined {
  if (input === null) return null;
  if (typeof input !== "string") return undefined;
  return input.slice(0, maxLength).replace(/[\u0000-\u001F\u007F]/g, "");
}

function projectTraceForMcp(raw: unknown): unknown {
  assertTraceShape(raw);
  const obj = raw as {
    trace: { id: string; spans: unknown[] };
  };
  // Filter first to drop malformed elements (primitives / null), then slice
  // to take the top N valid spans. This structurally prevents valid spans from
  // being over-dropped when malformed elements appear first.
  const validSpans = obj.trace.spans.filter(
    (s): s is Record<string, unknown> => typeof s === "object" && s !== null,
  );
  const projSpans = validSpans.slice(0, MAX_TRACE_SPANS).map((s) => {
    const out: Record<string, unknown> = {};
    if (typeof s["id"] === "string") out["id"] = s["id"];
    if (typeof s["provider"] === "string") out["provider"] = s["provider"];
    if (typeof s["model"] === "string") out["model"] = s["model"];
    if (typeof s["timestamp"] === "string") out["timestamp"] = s["timestamp"];
    if (typeof s["totalTokens"] === "number") out["totalTokens"] = s["totalTokens"];
    if (typeof s["promptTokens"] === "number") out["promptTokens"] = s["promptTokens"];
    if (typeof s["completionTokens"] === "number") {
      out["completionTokens"] = s["completionTokens"];
    }
    if (typeof s["costUsd"] === "number") out["costUsd"] = s["costUsd"];
    if (typeof s["latencyMs"] === "number") out["latencyMs"] = s["latencyMs"];
    // error also goes through sanitizeText (512-char cap + control-character
    // strip), structurally preventing long provider-originated errors or
    // injected instructions from flowing unbounded into LLM context — and
    // avoiding a context DoS when amplified across 50 spans.
    const errSan = sanitizeText(s["error"], MAX_ERROR_TEXT_LENGTH);
    if (errSan !== undefined) out["error"] = errSan;
    if (typeof s["spanId"] === "string" || s["spanId"] === null) {
      out["spanId"] = s["spanId"];
    }
    if (typeof s["parentSpanId"] === "string" || s["parentSpanId"] === null) {
      out["parentSpanId"] = s["parentSpanId"];
    }
    const tagsSan = sanitizeTags(s["tags"]);
    if (tagsSan !== undefined) out["tags"] = tagsSan;
    // errorDetails / requestMeta are structurally dropped (internal debug).
    return out;
  });
  // No silent truncation: meta carries the original span count and a
  // truncated flag so the user can detect the cap's effect.
  const originalSpansCount = obj.trace.spans.length;
  return {
    trace: { id: obj.trace.id, spans: projSpans },
    meta: {
      originalSpans: originalSpansCount,
      returnedSpans: projSpans.length,
      truncated: validSpans.length > MAX_TRACE_SPANS,
    },
  };
}

/**
 * Hardens the prompt surface boundary for tags. The Terms of Service require
 * users to put only `Record<string, string|number|boolean>` into tags, but if
 * a non-conforming SDK or direct ingest sneaks in nested objects / arrays /
 * huge strings / control characters, this structurally defends against them
 * flowing straight into LLM context.
 *
 *   - non-plain objects (null / array / non-object) → fully dropped as undefined
 *   - entries whose key length is outside 1-64 characters are dropped
 *   - values: only string (256-char cap + control characters [\x00-\x1F\x7F]
 *     stripped) / number (Number.isFinite only) / boolean are carried; the
 *     rest are dropped
 */
// Cap on tag entry count to defend against context bloat / DoS.
const MAX_TAG_ENTRIES = 128;

export function sanitizeTags(
  input: unknown,
): Record<string, string | number | boolean> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  // Strict plain objects only (Date / class instances / other objects with a
  // prototype are dropped). A null prototype (Object.create(null)) is not
  // expected via the ingest path but is accepted (Object.entries iteration is
  // safe).
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) {
    return undefined;
  }
  const out: Record<string, string | number | boolean> = {};
  let kept = 0;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (kept >= MAX_TAG_ENTRIES) break;
    if (k.length === 0 || k.length > 64) continue;
    if (typeof v === "string") {
      // Control-character strip + 256-char cap (LLM prompt injection mitigation).
      out[k] = v.slice(0, 256).replace(/[\u0000-\u001F\u007F]/g, "");
      kept++;
    } else if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
      kept++;
    } else if (typeof v === "boolean") {
      out[k] = v;
      kept++;
    }
    // Everything else (nested objects / arrays / null / undefined / functions
    // etc.) is dropped.
  }
  return out;
}

/**
 * Shape gate + projection for the annotations/{id} resource template. The
 * backend response shape is `{ annotation: { id, accountId, callId,
 * createdByUserId, annotationText, label, qualityScore, createdAt,
 * updatedAt } }`. Required fields' presence and type are gated fail-closed;
 * violations throw. createdByUserId (internal user sub) and accountId
 * (internal scope) are dropped by the projection; annotationText / label go
 * through sanitizeText (control-character strip + length cap).
 */
const MAX_ANNOTATION_TEXT_LENGTH = 2000;
const MAX_ANNOTATION_LABEL_LENGTH = 64;

export function assertAnnotationShape(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(
      "unexpected /v1/annotations/:id response shape (not an object)",
    );
  }
  const obj = raw as Record<string, unknown>;
  const annotation = obj["annotation"];
  if (typeof annotation !== "object" || annotation === null) {
    throw new Error(
      "unexpected /v1/annotations/:id response shape (missing or invalid annotation)",
    );
  }
  const a = annotation as Record<string, unknown>;
  if (typeof a["id"] !== "number") {
    throw new Error(
      "unexpected /v1/annotations/:id annotation.id (expected number)",
    );
  }
  if (typeof a["callId"] !== "string") {
    throw new Error(
      "unexpected /v1/annotations/:id annotation.callId (expected string)",
    );
  }
  if (typeof a["createdAt"] !== "string") {
    throw new Error(
      "unexpected /v1/annotations/:id annotation.createdAt (expected string)",
    );
  }
  if (typeof a["updatedAt"] !== "string") {
    throw new Error(
      "unexpected /v1/annotations/:id annotation.updatedAt (expected string)",
    );
  }
}

function projectAnnotationForMcp(raw: unknown): unknown {
  assertAnnotationShape(raw);
  const a = (raw as { annotation: Record<string, unknown> }).annotation;
  const projected: Record<string, unknown> = {
    id: a["id"],
    callId: a["callId"],
    createdAt: a["createdAt"],
    updatedAt: a["updatedAt"],
  };
  const textSan = sanitizeText(a["annotationText"], MAX_ANNOTATION_TEXT_LENGTH);
  if (textSan !== undefined) projected["annotationText"] = textSan;
  const labelSan = sanitizeText(a["label"], MAX_ANNOTATION_LABEL_LENGTH);
  if (labelSan !== undefined) projected["label"] = labelSan;
  if (typeof a["qualityScore"] === "number" || a["qualityScore"] === null) {
    projected["qualityScore"] = a["qualityScore"];
  }
  // accountId / createdByUserId are dropped by the projection (internal scope).
  return { annotation: projected };
}

/**
 * Shape gate + projection for the eval-criteria/{id} resource template. The
 * backend response shape is `{ criterion: { id, accountId, name, rubric,
 * scaleMin, scaleMax, createdAt, updatedAt } }`. Required fields' presence and
 * type are gated fail-closed; violations throw. accountId is dropped by the
 * projection (internal scope; the global-default NULL / own-account string
 * distinction is unnecessary in MCP context). name / rubric go through
 * sanitizeText. The rubric cap is 4000 chars (larger than annotations because
 * judge instructions can be long).
 */
const MAX_CRITERION_NAME_LENGTH = 100;
const MAX_CRITERION_RUBRIC_LENGTH = 4000;

export function assertCriterionShape(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(
      "unexpected /v1/eval-criteria/:id response shape (not an object)",
    );
  }
  const obj = raw as Record<string, unknown>;
  const criterion = obj["criterion"];
  if (typeof criterion !== "object" || criterion === null) {
    throw new Error(
      "unexpected /v1/eval-criteria/:id response shape (missing or invalid criterion)",
    );
  }
  const c = criterion as Record<string, unknown>;
  if (typeof c["id"] !== "number") {
    throw new Error(
      "unexpected /v1/eval-criteria/:id criterion.id (expected number)",
    );
  }
  if (typeof c["name"] !== "string") {
    throw new Error(
      "unexpected /v1/eval-criteria/:id criterion.name (expected string)",
    );
  }
  if (typeof c["rubric"] !== "string") {
    throw new Error(
      "unexpected /v1/eval-criteria/:id criterion.rubric (expected string)",
    );
  }
  if (typeof c["scaleMin"] !== "number") {
    throw new Error(
      "unexpected /v1/eval-criteria/:id criterion.scaleMin (expected number)",
    );
  }
  if (typeof c["scaleMax"] !== "number") {
    throw new Error(
      "unexpected /v1/eval-criteria/:id criterion.scaleMax (expected number)",
    );
  }
}

function projectCriterionForMcp(raw: unknown): unknown {
  assertCriterionShape(raw);
  const c = (raw as { criterion: Record<string, unknown> }).criterion;
  const projected: Record<string, unknown> = {
    id: c["id"],
    scaleMin: c["scaleMin"],
    scaleMax: c["scaleMax"],
  };
  const nameSan = sanitizeText(c["name"], MAX_CRITERION_NAME_LENGTH);
  if (nameSan !== undefined) projected["name"] = nameSan;
  const rubricSan = sanitizeText(c["rubric"], MAX_CRITERION_RUBRIC_LENGTH);
  if (rubricSan !== undefined) projected["rubric"] = rubricSan;
  if (typeof c["createdAt"] === "string") projected["createdAt"] = c["createdAt"];
  if (typeof c["updatedAt"] === "string") projected["updatedAt"] = c["updatedAt"];
  // accountId is dropped (internal scope; the global-default NULL /
  // own-account string distinction is not carried into MCP context — the
  // rubric alone suffices for LLM-as-judge use).
  return { criterion: projected };
}

/**
 * Shape gate + projection for the prompts/{id} resource template. The backend
 * response shape is `{ prompt: { id, accountId, name, version, template,
 * variables, labels, description, createdByUserId, createdAt, updatedAt } }`.
 * Required fields' presence and type are gated fail-closed; violations throw.
 * accountId / createdByUserId are dropped by the projection (internal scope);
 * template goes through sanitizeText (control-character strip + 50000 char
 * cap; structural defense of the prompt injection path), and description is
 * sanitized too. variables / labels are already JSON-parsed by the backend
 * (their shape is user-defined) and are carried as-is.
 */
const MAX_PROMPT_TEMPLATE_LENGTH = 50_000;
const MAX_PROMPT_NAME_LENGTH = 64;
const MAX_PROMPT_DESCRIPTION_LENGTH = 500;

export function assertPromptShape(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("unexpected /v1/prompts/:id response shape (not an object)");
  }
  const obj = raw as Record<string, unknown>;
  const prompt = obj["prompt"];
  if (typeof prompt !== "object" || prompt === null) {
    throw new Error(
      "unexpected /v1/prompts/:id response shape (missing or invalid prompt)",
    );
  }
  const p = prompt as Record<string, unknown>;
  if (typeof p["id"] !== "number") {
    throw new Error("unexpected /v1/prompts/:id prompt.id (expected number)");
  }
  if (typeof p["name"] !== "string") {
    throw new Error("unexpected /v1/prompts/:id prompt.name (expected string)");
  }
  if (typeof p["version"] !== "string") {
    throw new Error("unexpected /v1/prompts/:id prompt.version (expected string)");
  }
  if (typeof p["template"] !== "string") {
    throw new Error("unexpected /v1/prompts/:id prompt.template (expected string)");
  }
  if (typeof p["createdAt"] !== "string") {
    throw new Error("unexpected /v1/prompts/:id prompt.createdAt (expected string)");
  }
}

function projectPromptForMcp(raw: unknown): unknown {
  assertPromptShape(raw);
  const p = (raw as { prompt: Record<string, unknown> }).prompt;
  const projected: Record<string, unknown> = {
    id: p["id"],
    version: p["version"],
    createdAt: p["createdAt"],
  };
  const nameSan = sanitizeText(p["name"], MAX_PROMPT_NAME_LENGTH);
  if (nameSan !== undefined) projected["name"] = nameSan;
  const templateSan = sanitizeText(p["template"], MAX_PROMPT_TEMPLATE_LENGTH);
  if (templateSan !== undefined) projected["template"] = templateSan;
  const descSan = sanitizeText(p["description"], MAX_PROMPT_DESCRIPTION_LENGTH);
  if (descSan !== undefined) projected["description"] = descSan;
  // labels / variables are already JSON-parsed by the backend (shape is
  // user-defined) and carried as-is.
  if (Array.isArray(p["labels"]) || p["labels"] === null) {
    projected["labels"] = p["labels"];
  }
  if (p["variables"] !== undefined) {
    projected["variables"] = p["variables"];
  }
  if (typeof p["updatedAt"] === "string") {
    projected["updatedAt"] = p["updatedAt"];
  }
  // accountId / createdByUserId are dropped (internal scope).
  return { prompt: projected };
}

function assertSafetyAssessmentShape(raw: unknown): void {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("assessment" in raw) ||
    typeof (raw as { assessment: unknown }).assessment !== "object"
  ) {
    throw new Error(
      "unexpected /v1/safety-assessments/:id response shape (expected { assessment: {...} })",
    );
  }
}

function projectSafetyAssessmentForMcp(raw: unknown): unknown {
  assertSafetyAssessmentShape(raw);
  const a = (raw as { assessment: Record<string, unknown> }).assessment;
  const projected: Record<string, unknown> = {
    id: a["id"],
    callId: a["callId"],
    classifierId: a["classifierId"],
    source: a["source"],
    createdAt: a["createdAt"],
  };
  if (Array.isArray(a["labels"])) {
    projected["labels"] = (a["labels"] as unknown[]).filter(
      (x) => typeof x === "string",
    );
  }
  if (typeof a["score"] === "number" || a["score"] === null) {
    projected["score"] = a["score"];
  }
  const reasoning = sanitizeText(a["reasoning"], 4000);
  if (reasoning !== undefined) projected["reasoning"] = reasoning;
  // accountId / createdByUserId / assessorCallId are dropped (internal scope).
  return { assessment: projected };
}

function assertEvalRunShape(raw: unknown): void {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("run" in raw) ||
    typeof (raw as { run: unknown }).run !== "object"
  ) {
    throw new Error(
      "unexpected /v1/eval-runs/:id response shape (expected { run: {...}, scores: [...] })",
    );
  }
}

function projectEvalRunForMcp(raw: unknown): unknown {
  assertEvalRunShape(raw);
  const r = (raw as { run: Record<string, unknown>; scores?: unknown[] }).run;
  const scoresRaw = (raw as { scores?: unknown[] }).scores;
  const runProjected: Record<string, unknown> = {
    id: r["id"],
    name: typeof r["name"] === "string" ? r["name"].slice(0, 120) : undefined,
    status: r["status"],
    judgeProvider: r["judgeProvider"],
    judgeModel: r["judgeModel"],
    promptRegistryId: r["promptRegistryId"],
    triggeredVia: r["triggeredVia"],
    createdAt: r["createdAt"],
    startedAt: r["startedAt"],
    completedAt: r["completedAt"],
  };
  // summary is a plain object (scoredCount / failedCount /
  // meanScoreByCriterion), carried as-is.
  if (r["summary"] !== undefined) runProjected["summary"] = r["summary"];
  if (r["datasetFilter"] !== undefined) runProjected["datasetFilter"] = r["datasetFilter"];
  // accountId / createdByUserId are dropped.
  const scoresProjected = Array.isArray(scoresRaw)
    ? scoresRaw.slice(0, 200).map((s) => {
        if (!s || typeof s !== "object") return null;
        const so = s as Record<string, unknown>;
        const out: Record<string, unknown> = {
          id: so["id"],
          criterionId: so["criterionId"],
          callId: so["callId"],
          score: so["score"],
        };
        const reasoning = sanitizeText(so["reasoning"], 1000);
        if (reasoning !== undefined) out["reasoning"] = reasoning;
        return out;
      }).filter((x) => x !== null)
    : [];
  return { run: runProjected, scores: scoresProjected };
}

function filterEnabledAlerts(raw: unknown): unknown {
  // Responses not matching the expected shape ({ alerts: [...] }) are not
  // silently passed through raw; they throw fail-closed. This prevents the
  // risk of unintended fields leaking to the LLM if the backend response shape
  // changes in the future.
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("alerts" in raw) ||
    !Array.isArray((raw as { alerts: unknown }).alerts)
  ) {
    throw new Error(
      "unexpected /v1/alerts response shape (expected { alerts: Array<...> })",
    );
  }
  const alerts = (raw as { alerts: Array<Record<string, unknown>> }).alerts;
  // A previous implementation passed each alert through raw via
  // `{ ...raw, alerts: filtered }`, leaking channelTargets (webhook URL /
  // secret / PagerDuty key / email) and accountId straight into LLM context.
  // Alerts now go through the same projectAlertObject allowlist as the detail
  // path, structurally dropping secrets / PII. The ...raw spread was removed
  // as well.
  return {
    alerts: alerts
      .filter((a) => a["enabled"] !== false)
      .map((a) => projectAlertObject(a)),
  };
}
