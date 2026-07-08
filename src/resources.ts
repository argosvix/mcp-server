/**
 * MCP resource definitions + reader (= Phase 3、 2026-05-31)。
 *
 * Resource は 「AI agent に 自動的に 文脈として渡す read-only data」 (= tools が
 * 「呼ぶ」 のに対し resource は 「読み込む」)。 host application が 自前で 選んで
 * context に入れるか、 prompt から `resource` content として 埋め込むことができる。
 *
 * v0.7.0-alpha.1 で expose する 3 resources + 1 resource template:
 *   - argosvix://account        = plan / quota / 今月の record 使用量 snapshot
 *                                 (= /v1/account、 Bearer 専用の non-sensitive identity
 *                                 endpoint、 subscription detail は含まない)
 *   - argosvix://alerts/active  = enabled な alert 一覧 (= /v1/alerts、 list_alerts と同 path)
 *   - argosvix://cost/today     = 直近 24h の cost 集計 (= /v1/query/aggregate POST、
 *                                 get_cost_summary(rangePreset=24h, groupBy=provider) と同等)
 *   - argosvix://calls/{id}     = 単一 LLM call record (= /v1/query/calls/:id GET、
 *                                 resource template、 LLM が query_calls の id を
 *                                 直接 context に取り込める)
 *
 * v0.8 backlog: subscribe / listChanged、 alerts/{id} template、 traces/{id} template。
 *
 * dispatch / fetch 規約は tools.ts と揃える (= POST + JSON body、 User-Agent に MCP_VERSION、
 * redirect: error、 Bearer 認証)。 backend 仕様乖離による 405 / 401 を 再発させない。
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

// 2026-05-31 = Phase 3 resource template (= URI template、 client が id を 差し込んで
// 動的 URI を 組み立てる軸)。 backend GET /v1/query/calls/:id と 1:1 対応。
const CALLS_TEMPLATE_URI = "argosvix://calls/{id}";
const CALL_URI_PATTERN = /^argosvix:\/\/calls\/([A-Za-z0-9_-]{1,128})$/;

// 2026-05-31 = Phase 3 alerts/{id} resource template (= 既存 backend GET /v1/alerts/:id
// を 経由、 get_alert tool と 同じ endpoint だが resource として template 経由で
// host application が context に carry できる pattern)。
const ALERTS_TEMPLATE_URI = "argosvix://alerts/{id}";
const ALERT_URI_PATTERN = /^argosvix:\/\/alerts\/([A-Za-z0-9-]{1,64})$/;

// 2026-05-31 = Phase 3 traces/{id} resource template (= backend GET /v1/query/trace/:id
// 新設 endpoint を 経由、 1 trace = 複数 spans の全体像を URI 経由で context に carry)。
// 大量 spans (= LLM context budget 観点で 50+ は重い) は MAX_TRACE_SPANS で 上限 carry。
const TRACES_TEMPLATE_URI = "argosvix://traces/{id}";
const TRACE_URI_PATTERN = /^argosvix:\/\/traces\/([A-Za-z0-9_-]{1,128})$/;

// 2026-06-02 = v1.5 annotations/{id} resource template (= backend GET /v1/annotations/:id
// 経由、 1 annotation の review 詳細を URI 経由で context に carry)。 annotation は
// AUTOINCREMENT integer id (= [1-9]\d{0,9})、 自 account scope は backend WHERE 句で
// 構造防御。 sensitive な PII はないが、 annotation_text に user-controlled string が
// 含まれるので sanitizeText 経由で carry する。
const ANNOTATIONS_TEMPLATE_URI = "argosvix://annotations/{id}";
const ANNOTATION_URI_PATTERN = /^argosvix:\/\/annotations\/([1-9]\d{0,9})$/;

// 2026-06-02 = v1.5 eval-criteria/{id} resource template (= backend GET /v1/eval-criteria/:id
// 経由、 1 criterion の rubric を URI 経由で context に carry)。 LLM-as-judge runner の
// instruction text に直接使える、 AI agent が「どんな軸で評価できるか」を 自動的に context
// に取り込める軸。 global default (= accountId NULL) + 自 account custom 両方 visible、
// 他 account の custom は 構造防御で 404。 rubric は user-controlled string で sanitizeText
// 経由 carry (= prompt 経路の boundary 強化)。
const EVAL_CRITERIA_TEMPLATE_URI = "argosvix://eval-criteria/{id}";
const EVAL_CRITERION_URI_PATTERN = /^argosvix:\/\/eval-criteria\/([1-9]\d{0,9})$/;

// 2026-06-02 = v1.5 Round F prompts/{id} resource template (= backend GET /v1/prompts/:id
// 経由、 user が登録した prompt template を URI 経由で context に carry)。 AI agent が
// 「production 版 customer support の prompt は こう」 という context を 自動で取り込む。
// 自 account scope は backend WHERE 句で 構造防御。 template は user-controlled なので
// sanitizeText 経由で carry (= 50000 char cap、 prompt injection 経路 構造防御)。
const PROMPTS_TEMPLATE_URI = "argosvix://prompts/{id}";
const PROMPT_URI_PATTERN = /^argosvix:\/\/prompts\/([1-9]\d{0,9})$/;

// 2026-06-02 v1.5 closure = safety-assessments/{id} resource template (= backend
// GET /v1/safety-assessments/:id 経由、 OpenAI Moderation cron が書き込んだ
// 単一 assessment を URI 経由で context に carry)。 labels (= flagged
// category 配列) + score + reasoning + classifier_id が含まれるため、 AI agent
// は 「この call は どの policy 軸で flag された?」 を 1 fetch で把握できる。
// 自 account scope は backend WHERE 句で 構造防御。
const SAFETY_ASSESSMENT_TEMPLATE_URI = "argosvix://safety-assessments/{id}";
const SAFETY_ASSESSMENT_URI_PATTERN = /^argosvix:\/\/safety-assessments\/([1-9]\d{0,9})$/;

// 2026-06-02 v1.5 closure = eval-runs/{id} resource template (= backend GET
// /v1/eval-runs/:id 経由、 1 eval run の summary + scores 一覧を URI 経由で
// carry)。 AI agent は 「直近の eval run の score 分布」 や 「criterion 別の
// 平均」 を 1 fetch で把握できる。 自 account scope は backend WHERE 句で
// 構造防御。 scores の reasoning (= judge LLM 出力) は sanitizeText で carry。
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

// 2026-05-31 = Phase 3 resource template list。 client が template の {id} を 置換した
// URI で resources/read を 呼ぶ flow。 自 account scope は backend PK (account_id, id)
// で 構造防御済 (= 他 account の id を 試行的に組んでも 404)。
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

  // resource template (= argosvix://calls/{id} / argosvix://alerts/{id}) を switch 前に
  // 先 match。 switch の case で dynamic expression を 評価する path は TS / readability
  // で 望ましくないため、 template 系は ここで 早期 dispatch する。
  const callMatch = CALL_URI_PATTERN.exec(uri);
  if (callMatch) {
    const callId = callMatch[1]!;
    const json = await fetchJson(
      apiBase,
      `/v1/query/calls/${encodeURIComponent(callId)}`,
      apiKey,
      { method: "GET" },
    );
    // Codex v0.7.0 HIGH 1 fix: assertCallShape (= shape gate) だけでは backend response
    // の raw JSON を そのまま LLM に流すので、 user-controlled JSON (= errorDetails /
    // requestMeta) や 将来 backend 追加 field が prompt-injection 経路に carry される
    // risk が残る。 projectCallForMcp で 明示的 allowlist 経由に carry。
    const projected = projectCallForMcp(json);
    return wrapJsonContent(uri, projected);
  }
  // audit round2 fix = alerts/{id} template は "active" も captureしてしまうため、
  // 完全一致の ALERTS_ACTIVE_URI (= list) を template より優先して除外する。 これが無いと
  // alerts/active が id="active" の単体 fetch に misroute され list resource が壊れる。
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
    // Codex v0.7.0 HIGH 1 fix と 同 pattern = projection allowlist で channelTargets
    // (= 通知先 = sensitive) と accountId (= internal) を 構造的に drop する。
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
    // spans cap + per-span allowlist で context 膨張 / sensitive 漏洩 構造防御
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
    // annotationText (= user-controlled) は sanitizeText 経由で carry、 PII / prompt
    // injection 経路を 構造防御。 createdByUserId (= internal sub) は drop。
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
    // rubric (= user-controlled judge instruction) は sanitizeText 経由で carry、
    // accountId は projection drop (= internal scope、 ただし null/string で plan
    // 軸の narrative 軸あり、 dashboard は表示するが MCP context には不要)。
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
    // template (= user-controlled prompt text) は sanitizeText 経由で carry、
    // accountId / createdByUserId は projection drop (= internal scope)。
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
      // Codex v0.5.0 MEDIUM 2 fix: account response の shape を fail-closed 検証する。
      // alerts/active と同様、 backend が将来 accidental に PII 等の field を 追加した
      // 場合に 「non-sensitive」 前提が崩れたまま LLM に流れる risk を 構造防御する。
      // 期待外 shape は throw → ResourceNotFoundError ではなく InternalError に carry。
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
      // backend `/v1/query/aggregate` は POST 専用 + ISO range body。 0.3.1-alpha.1
      // の tools.ts と同経路を carry。 直近 24h を 今 から逆算する。
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
    // Codex v0.4.0 HIGH 1 fix: backend error body を LLM に直接 expose しない。
    // 内部識別子 / PII / 内部実装 message を含む path を 構造防御。 詳細 debug が必要なら
    // server stderr に raw body を log (= operator 限定)、 client には status + path
    // のみ返す。 x-request-id があれば 突合用に carry。
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
 * Codex v0.5.0 MEDIUM 2 fix: /v1/account response shape の fail-closed 検証。
 * backend が 想定外 field を 追加した時に LLM が 「non-sensitive」 前提で context に
 * 取り込んでしまう risk を 構造防御する。 期待外なら throw。
 *
 * 「allowlist 検証」 方式 = 期待 field 以外が混入していても通すが、 必須 field の
 * 型 / 存在 が崩れたら fail-closed する。 backend 側で additive な field 追加自体は
 * 互換維持で OK (= MCP server を更新せず backend だけ rolling deploy する 運用)、
 * ただし 必須 field の 形式 drift は 即検出 する 軸。
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
  // Codex v0.5.0 round 2 MEDIUM 1 fix + round 3 LOW 1 fix: createdAt は必須 field
  // 且つ 「ISO 8601 相当の文字列 or null」 限定で gate する。
  //   - 欠落 → throw
  //   - null → 通る (= backend toIsoOrNull の Date.parse failure 時 null fallback と整合)
  //   - 空文字 / Date.parse 不能文字列 / 非 string → throw
  // backend で normalize 済の前提だが、 別 backend 経路 や 将来の drift で 不正値が来た
  // 時に LLM が 「invalid date」 を context に取り込むのを 構造防御。
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
 * Codex v0.5.0 MEDIUM 2 fix と 同じ fail-closed pattern (= /v1/query/calls/:id 用)。
 * backend response は `{ call: { id, provider, model, ... } }` shape。 必須 field の型
 * + 存在を gate、 違反は throw → McpError.InternalError に carry。 additive field 追加は
 * そのまま通す (= rolling deploy 互換)。
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
 * Codex v0.7.0 HIGH 1 fix: backend response の raw JSON pass-through を 廃止し、 LLM
 * context に 流す field を 明示 allowlist で carry する。 user-controlled JSON 部分 (=
 * errorDetails / requestMeta = 内部 stack trace / debug-only field) を drop し、 prompt
 * injection 経路 と 内部実装 漏洩 risk を 構造防御する。
 *
 * 含める: id / provider / model / timestamp + token / cost / latency 数値群 + tags (=
 * LLM が分析に使う、 ただし PII は terms §4 で user 投入禁止)、 error + trace ID 群
 * (= debug agent + trace navigation 用途)。
 *
 * 含めない (= drop): errorDetails (= 内部 stack trace)、 requestMeta (= internal
 * implementation detail)、 将来 backend が追加した unknown field。
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
  // optional 数値 / object / string 型 field は 存在 + 期待型 を 個別 check して carry。
  if (typeof c["promptTokens"] === "number") projected["promptTokens"] = c["promptTokens"];
  if (typeof c["completionTokens"] === "number") {
    projected["completionTokens"] = c["completionTokens"];
  }
  // tags は user-defined Record<string, string|number|boolean> = LLM 分析用に carry、
  // ただし PII を 含めるのは Terms §4 違反 で user 責任 (= 既存 narrative carry)。
  // Codex v0.7.0 round 2 LOW 1 fix: prompt surface boundary を 強化、 入れ子 / 配列 /
  // 巨大 string / 制御文字 を sanitizeTags で 構造防御 (= MCP prompt context への
  // 想定外データ流入を 最小化)。
  const sanitized = sanitizeTags(c["tags"]);
  if (sanitized !== undefined) projected["tags"] = sanitized;
  // error は string | null (= summary message)、 errorDetails (= stack trace / internal)
  // は drop。
  if (typeof c["error"] === "string" || c["error"] === null) {
    projected["error"] = c["error"];
  }
  // trace navigation 用 ID 群 (= 別 resource template / dashboard jump 経路で 価値あり)
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
 * v0.8.0 = alerts/{id} resource template の shape gate。 backend response は
 * `{ alert: {...}, events: [...] }` shape (= /v1/alerts/:id)。 必須 field の型 + 存在を
 * fail-closed で gate、 違反は throw → McpError.InternalError に carry。 events array
 * の各 entry も object check のみで、 中身 field は project 側で carry。
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
  // Codex v0.8.0 LOW 4 fix = optional 数値 field の 型ドリフト 検知 (= 存在時のみ型 check、
  // 不在は OK、 型違反は throw)。
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
  // events は array required、 中身 element の shape は project 側で carry。
  const events = obj["events"];
  if (!Array.isArray(events)) {
    throw new Error(
      "unexpected /v1/alerts/:id response shape (missing or invalid events array)",
    );
  }
}

/**
 * v0.8.0 = alerts/{id} projection allowlist。 backend が返す sensitive field
 * (= channelTargets = 通知先 email / webhook URL、 accountId = internal scope) を
 * 構造的に drop し、 LLM context に carry する field を 明示制限する。
 *   - alert: id / name / alertType / thresholdValue / windowMinutes / filterProvider /
 *     filterModel / channelKinds / sleepMinutes / enabled / createdAt / updatedAt /
 *     silencedUntil
 *   - events: id / triggeredAt / observedValue / channelsSent + (将来 ack carry 時) ack
 * channelKinds は文字列 array (= ChannelKind enum)、 channelTargets は drop。
 */
// Codex v0.8.0 MEDIUM 1 fix = events 件数 cap で context 膨張 / DoS 防御。 backend が
// LIMIT 20 で 返す前提だが、 仕様 drift / 試験 endpoint で 大量 返却された場合に
// MCP 側でも cap する。
const MAX_ALERT_EVENTS = 20;

// Codex v0.8.0 MEDIUM 3 fix = channel 種別を 既知 enum に limit (= 不明文字列が prompt
// に carry される path を 構造防御)。 backend `ChannelKind` enum と 同期。
// Codex v0.8.0 round 2 LOW 1 fix = export 化して resources.test.ts の drift gate test で
// backend CHANNEL_KINDS と 完全一致を CI で gate (= backend で 新 kind 追加された時に
// MCP server が 静かに drop する 機能劣化 を 構造防御)。
// Codex v1.5 round 6 MEDIUM 2 fix = "pagerduty" を 追加 (= 2026-05-31 PagerDuty
// channel ship に伴う drift)。
export const ALLOWED_CHANNEL_KINDS = new Set<string>([
  "email",
  "slack",
  "webhook",
  "discord",
  "teams",
  "pagerduty",
]);

/**
 * 2026-05-31 Codex v1.5 round 6 MEDIUM 2 fix = channels_sent に carry される plan
 * skip sentinel。 backend types.ts SKIPPED_BY_PLAN_SENTINEL と同期 (= drift gate
 * test で CI carry)。 filterChannelKinds で sentinel も pass-through、 MCP client
 * (= AI agent) が 「plan で skip された event」 を 正確に観測できる軸。
 */
export const SKIPPED_BY_PLAN_SENTINEL = "__skipped_by_plan__";

function filterChannelKinds(xs: unknown[]): string[] {
  return xs.filter(
    (k): k is string =>
      typeof k === "string" &&
      (ALLOWED_CHANNEL_KINDS.has(k) || k === SKIPPED_BY_PLAN_SENTINEL),
  );
}

// Codex v0.8.0 MEDIUM 2 fix = alert.name の prompt injection 経路を 防御 (= 制御文字
// strip + 100 字 cap)。 backend create_alert で 既に name pattern `^[^\r\n]{1,100}$`
// で gate 済だが、 MCP 側でも boundary を carry (= 過去 row や 別 path で 入った値の
// 防御)。
const MAX_ALERT_NAME_LENGTH = 100;
function sanitizeAlertName(v: unknown): string | undefined {
  // v0.9.1 = sanitizeText 経由に carry で 共通化 (= Codex v0.9.0 round 2 INFO 2)。 
  // sanitizeText は null は null を 返すが、 alert.name は null 想定なし
  // (= 受け取らない場合 string 型 違反として undefined drop) なので そのまま carry。
  const result = sanitizeText(v, MAX_ALERT_NAME_LENGTH);
  return typeof result === "string" ? result : undefined;
}

/**
 * 単一 alert object を allowlist projection する共有 helper。
 * ⚠ channelTargets (= webhook URL/secret/PagerDuty key/email) と accountId は
 * 意図的に drop する (= LLM context への secret/PII 漏洩防止)。 list / detail の
 * 両 path がこの 1 箇所を通ることで raw passthrough を構造排除する (audit round2 SHIP_BLOCKER fix)。
 */
function projectAlertObject(a: Record<string, unknown>): Record<string, unknown> {
  const projAlert: Record<string, unknown> = {
    id: a["id"],
    alertType: a["alertType"],
    enabled: a["enabled"],
  };
  // Codex v0.8.0 MEDIUM 2 fix = name は sanitize 経由で carry。 sanitize 結果が空文字
  // (= 全部 制御文字) なら shape gate 違反扱いで throw (= 表示用 name が必須)。
  const safeName = sanitizeAlertName(a["name"]);
  if (safeName === undefined || safeName.length === 0) {
    throw new Error(
      "unexpected alert.name (expected non-empty string after sanitize)",
    );
  }
  projAlert["name"] = safeName;
  // optional 数値 / string / array field を 個別 carry。
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
    // Codex v0.8.0 MEDIUM 3 fix = ChannelKind enum 集合 のみ accept (= 不明文字列 drop)
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
  // events も 個別 projection。 Codex v0.8.0 MEDIUM 1 fix = MAX_ALERT_EVENTS cap、
  // MEDIUM 3 fix = channelsSent も enum allowlist 経由。
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
 * v0.9.0 = traces/{id} resource template の shape gate。 backend response shape は
 * `{ trace: { id: string, spans: [...] } }`。 spans 配列 は object 内 必須 field check
 * のみ、 中身 field projection は projectTraceForMcp 側で carry。
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
 * v0.9.0 = traces/{id} projection allowlist。 spans 上位 50 件で cap + 各 span は
 * allowlist 経由 carry (= errorDetails / requestMeta = 内部 debug 情報 drop、 tags は
 * sanitizeTags 経由、 error は sanitizeText 経由)。 backend は LIMIT 500 だが LLM
 * context budget で 50 cap が妥当。 response shape の meta で 元 spans 件数と
 * truncated フラグを 返却し、 user が cap 影響を 検知可能。
 *
 * Codex v0.9.0 fix:
 *   - HIGH 1: error 文字列を sanitizeText (= 512 字 cap + 制御文字 strip) で sanitize
 *   - MEDIUM 2: meta.originalSpans / returnedSpans / truncated で silent truncate 解消
 *   - MEDIUM 3: filter → slice 順序 carry で 異常要素先頭時の過剰 drop 回避
 */
const MAX_TRACE_SPANS = 50;
const MAX_ERROR_TEXT_LENGTH = 512;

/**
 * v0.9.1 = sanitizeText を export 化 + 直接 unit test 化 (= Codex v0.9.0 round 2 LOW 1
 * carry)。 既往 traces/{id} の error field + 将来追加の text field で 同 pattern carry。
 *   - null は null carry (= 「明示的 不在」 semantic を 維持)
 *   - string は maxLength で slice + 制御文字 (= U+0000 から U+001F + U+007F) を strip
 *   - 非 string は undefined drop
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
  // Codex MEDIUM 3 fix = filter 先で 異常要素 (= primitive / null) を 落とした後、
  // slice で valid spans の 上位 N 件を carry (= 異常要素先頭時に 有効 spans が
  // 過剰 drop される path を 構造防御)。
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
    // Codex HIGH 1 fix = error も sanitizeText (= 512 字 cap + 制御文字 strip) 経由で
    // carry (= provider 由来の長文 error / 誘導文 が LLM context に 無制限 carry される
    // path を 構造防御、 50 spans 増幅で context DoS を 起こさない)。
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
    // errorDetails / requestMeta は 構造 drop (= 内部 debug)
    return out;
  });
  // Codex MEDIUM 2 fix = silent truncate 解消、 user が cap 影響を 検知できるよう meta
  // で 元 spans 件数と truncated フラグを carry。
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
 * Codex v0.7.0 round 2 LOW 1 fix: tags の prompt surface boundary を 強化する。
 * SDK Terms §4 で user は tags に `Record<string, string|number|boolean>` のみ入れる
 * 規約だが、 不正 SDK / 直接 ingest で 入れ子 object / 配列 / 巨大 string / 制御文字 が
 * 紛れ込んだ場合に LLM context へ そのまま 流れる risk を 構造防御する。
 *
 *   - 非 plain object (= null / array / 非 object) → undefined で 全 drop
 *   - key 長 1-64 文字 を 越える entry は drop
 *   - value = string (= 256 文字 cap + 制御文字 [\x00-\x1F\x7F] を strip) / number
 *     (= Number.isFinite のみ) / boolean のみ carry、 他は drop
 */
// Codex v0.7.0 round 3 MEDIUM 1 fix = tags 件数 cap で context 膨張 / DoS 防御。
const MAX_TAG_ENTRIES = 128;

export function sanitizeTags(
  input: unknown,
): Record<string, string | number | boolean> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  // Codex v0.7.0 round 3 LOW 2 fix = strict plain object only (= Date / class instance
  // / その他 prototype 持ち object を drop)。 null prototype (= Object.create(null))
  // は ingest 経路で 来ない想定だが accept (= Object.entries iteration 安全)。
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
      // 制御文字 strip + 256 文字 cap (= LLM prompt injection mitigation)
      out[k] = v.slice(0, 256).replace(/[\u0000-\u001F\u007F]/g, "");
      kept++;
    } else if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
      kept++;
    } else if (typeof v === "boolean") {
      out[k] = v;
      kept++;
    }
    // それ以外 (= 入れ子 object / 配列 / null / undefined / function 等) は drop
  }
  return out;
}

/**
 * 2026-06-02 v1.5 = annotations/{id} resource template の shape gate + projection。
 * backend response shape は `{ annotation: { id, accountId, callId, createdByUserId,
 * annotationText, label, qualityScore, createdAt, updatedAt } }`。 必須 field の存在 +
 * 型 を fail-closed で gate、 違反は throw。 createdByUserId (= internal user sub) と
 * accountId (= internal scope) は projection で drop、 annotationText / label は
 * sanitizeText (= 制御文字 strip + 上限 cap) 経由で carry。
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
  // accountId / createdByUserId は projection drop (= internal scope)
  return { annotation: projected };
}

/**
 * 2026-06-02 v1.5 = eval-criteria/{id} resource template の shape gate + projection。
 * backend response shape は `{ criterion: { id, accountId, name, rubric, scaleMin,
 * scaleMax, createdAt, updatedAt } }`。 必須 field の存在 + 型 を fail-closed で gate、
 * 違反は throw。 accountId は projection で drop (= internal scope、 global default の
 * NULL / 自 account の string narrative は MCP context に不要)、 name / rubric は
 * sanitizeText 経由で carry。 rubric cap は 4000 字 (= judge instruction が長文 に
 * なり得る軸で annotation より大き目)。
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
  // accountId は drop (= internal scope、 global default NULL / 自 account string の
  // narrative は MCP context に carry しない、 LLM-as-judge 軸では rubric のみで充分)。
  return { criterion: projected };
}

/**
 * 2026-06-02 v1.5 Round F = prompts/{id} resource template の shape gate + projection。
 * backend response shape は `{ prompt: { id, accountId, name, version, template, variables,
 * labels, description, createdByUserId, createdAt, updatedAt } }`。 必須 field の存在 +
 * 型 を fail-closed で gate、 違反は throw。 accountId / createdByUserId は projection で
 * drop (= internal scope)、 template は sanitizeText (= 制御文字 strip + 50000 char cap)
 * 経由で carry (= prompt injection 経路 構造防御)、 description も sanitize 経由。
 * variables / labels は backend で 既 JSON parse 済 (= shape は user 任意)、 そのまま carry。
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
  // labels / variables は backend で JSON parse 済 (= shape は user 任意)、 そのまま carry
  if (Array.isArray(p["labels"]) || p["labels"] === null) {
    projected["labels"] = p["labels"];
  }
  if (p["variables"] !== undefined) {
    projected["variables"] = p["variables"];
  }
  if (typeof p["updatedAt"] === "string") {
    projected["updatedAt"] = p["updatedAt"];
  }
  // accountId / createdByUserId は drop (= internal scope)
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
  // accountId / createdByUserId / assessorCallId は drop (= internal scope)
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
  // summary は plain object 軸 (= scoredCount / failedCount / meanScoreByCriterion)、 そのまま carry
  if (r["summary"] !== undefined) runProjected["summary"] = r["summary"];
  if (r["datasetFilter"] !== undefined) runProjected["datasetFilter"] = r["datasetFilter"];
  // accountId / createdByUserId は drop
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
  // Codex v0.4.0 LOW 4 fix: 期待 shape (= { alerts: [...] }) でない response は
  // silent に raw を carry せず fail-closed で throw (= 将来 backend response shape
  // が変わった時に 意図しない field が LLM に 漏れる risk を 防ぐ)。
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
  // audit round2 SHIP_BLOCKER fix = 旧実装は `{ ...raw, alerts: filtered }` で各 alert を
  // raw passthrough しており、 channelTargets (= webhook URL/secret/PagerDuty key/email) と
  // accountId が そのまま LLM context に漏れていた。 detail path と同じ projectAlertObject
  // allowlist を通して secret/PII を構造的に drop する。 ...raw spread も廃止。
  return {
    alerts: alerts
      .filter((a) => a["enabled"] !== false)
      .map((a) => projectAlertObject(a)),
  };
}
