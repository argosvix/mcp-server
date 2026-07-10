/**
 * MCP tool definitions and dispatcher.
 *
 * Each tool defines its input with a JSON Schema, and dispatch forwards it to
 * an Argosvix backend HTTP endpoint.
 *
 * Core read tools:
 * - query_calls = fetch recent LLM call records with filtering + pagination
 * - get_cost_summary = cost / call / token aggregation by period (24h / 7d / 30d)
 * - list_alerts = list of configured alerts + latest status
 * - get_alert = a given alert's detail + recent trigger history
 * - list_alert_events = alert trigger history, newest first
 *
 * Core write tools:
 * - silence_alert / unsilence_alert = alert mute operations
 * - create_alert = create a new alert rule
 * - update_alert / delete_alert = complete the alert lifecycle
 * - create_annotation / update_annotation / delete_annotation = annotation CRUD
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { MCP_VERSION } from "./version.js";
import { isDebugEnabled } from "./debug.js";

/**
 * List of arg keys each tool may forward to the URL. A structural allowlist
 * ensures that extra args outside the schema (e.g. `account_id` / `endpoint`)
 * never reach the URL even if the LLM passes them. inputSchema also sets
 * additionalProperties: false so the MCP SDK validates too — double defense.
 */
const TOOL_ARG_ALLOWLIST: Record<string, ReadonlyArray<string>> = {
  // latencyMin/Max must be in the allowlist: adding them only to the schema
  // and dispatcher meant safeArgs dropped them and they never reached the
  // backend — a silent no-filter bug.
  query_calls: ["limit", "provider", "model", "rangePreset", "latencyMin", "latencyMax", "beforeTimestamp", "beforeId", "tagKey", "tagValue"],
  get_cost_summary: ["rangePreset", "groupBy"],
  list_alerts: ["includeTriggered"],
  // Guardian inbox (read + conversation only; deciding is dashboard-only to
  // prevent self-approval).
  list_proposals: [],
  get_proposal_thread: ["proposalId"],
  reply_proposal: ["proposalId", "body"],
  // Alert mute write tools: alertId is substituted into the path just before
  // the request; only body fields are allowlisted.
  silence_alert: ["alertId", "until"],
  unsilence_alert: ["alertId"],
  // create_alert: only the body fields of backend POST /v1/alerts are
  // allowlisted (structural defense against injecting account_id etc.).
  create_alert: [
    "name",
    "alertType",
    "thresholdValue",
    "windowMinutes",
    "filterProvider",
    "filterModel",
    "channelKinds",
    "channelTargets",
    "sleepMinutes",
    "enabled",
    "conditions",
    "evalCriterionId",
  ],
  // update_alert / delete_alert: wrap backend PATCH/DELETE /v1/alerts/:id.
  // alertType is immutable (the backend's validateUpdate returns 400), so it
  // is left out of the schema too. alertId is substituted into the path just
  // before the request; only body fields are allowlisted.
  update_alert: [
    "alertId",
    "name",
    "thresholdValue",
    "windowMinutes",
    "filterProvider",
    "filterModel",
    "channelKinds",
    "channelTargets",
    "sleepMinutes",
    "enabled",
    "conditions",
  ],
  delete_alert: ["alertId"],
  // Alert read tools: alertId is substituted into the path just before the
  // request (GET /v1/alerts/:id). list_alert_events allowlists only the query
  // params (limit / alertId).
  get_alert: ["alertId"],
  // Trigger-history drill-down: keyset cursor (beforeTriggeredAt + beforeId)
  // parity with the REST API.
  list_alert_events: ["limit", "alertId", "beforeTriggeredAt", "beforeId"],
  // acknowledge_alert: eventId is substituted into the path just before the
  // request; the body is empty (the source is forced to "mcp" on the MCP
  // server side and cannot be overridden by the LLM).
  acknowledge_alert: ["eventId"],
  // Annotation read tools: callId / annotationId / label / limit map to the
  // backend's /v1/annotations?callId=xxx / /v1/annotations/:id /
  // /v1/annotations?label=xxx path / query. User-controlled strings are
  // re-validated on the dispatch side.
  list_annotations_for_call: ["callId"],
  list_annotations_by_label: ["label", "limit"],
  get_annotation: ["annotationId"],
  // Annotation CRUD write tools: wrap backend POST/PATCH/DELETE
  // /v1/annotations through the allowlist. The value ranges of
  // annotation_text / label / quality_score get final validation on the
  // backend (2000 chars / 50 chars + alphanumerics _ - / integer 1-5).
  create_annotation: ["callId", "annotationText", "label", "qualityScore"],
  update_annotation: ["annotationId", "annotationText", "label", "qualityScore"],
  delete_annotation: ["annotationId"],
  // Eval criteria read tools: both global defaults and the account's own
  // custom criteria are visible. criterionId is an AUTOINCREMENT integer,
  // validated on the dispatch side.
  list_eval_criteria: [],
  get_eval_criterion: ["criterionId"],
  // Eval criteria write tools. Pro+ only. create + update are full replace
  // (name + rubric + scaleMin + scaleMax all required); delete works only
  // within the account (global defaults are structurally excluded).
  create_eval_criterion: ["name", "rubric", "scaleMin", "scaleMax", "type", "config", "scoreType", "scope"],
  update_eval_criterion: ["criterionId", "name", "rubric", "scaleMin", "scaleMax", "type", "config", "scoreType", "scope"],
  delete_eval_criterion: ["criterionId"],
  // test_webhook (alert webhook test-send path): wraps backend POST
  // /v1/alerts/test-webhook through the allowlist. The URL is SSRF-guarded
  // (validateWebhookTarget), secret is for HMAC signing, rate limit 5/min.
  test_webhook: ["url", "secret", "alertName"],
  // Outbound event webhook CRUD (/v1/webhooks). list is viewable on Free;
  // create/update/delete are Pro+. url is SSRF-guarded (validateWebhookUrl),
  // secret is for HMAC signing, eventTypes is the array of subscribed event
  // kinds, webhookId is substituted into the path just before the request.
  list_webhooks: [],
  create_webhook: ["url", "secret", "eventTypes", "description", "enabled"],
  update_webhook: ["webhookId", "url", "secret", "eventTypes", "description", "enabled"],
  delete_webhook: ["webhookId"],
  // LLM feature budget tools (the monthly budget cap for the safety
  // classifier + PII audit + eval baseline runner). get is shared by Free /
  // Pro+; raise is Pro+ only, with a $5-$500 hard cap. Defaults to $5 and
  // resets automatically at month rollover.
  get_llm_budget: [],
  raise_llm_budget: ["budgetUsd"],
  // Runtime budget gate tools (runtime control plane): pre-execution
  // enforcement settings for the user's own LLM spend (distinct from
  // llm_feature_budget). get is shared by Free / Pro+; create / update /
  // delete are Pro+ (backend plan gate). gateId is substituted into the path
  // just before the request; range validation is finalized on the backend.
  get_budget_gate: [],
  create_budget_gate: ["monthlyLimitUsd", "enforceMode", "enabled", "projectId", "tagKey", "tagValue"],
  update_budget_gate: ["gateId", "monthlyLimitUsd", "enforceMode", "enabled"],
  delete_budget_gate: ["gateId"],
  // Policy gate tools (runtime control plane): pre-execution enforcement
  // settings for the model allowlist / PII block / secret block. get is
  // shared by Free / Pro+; create / update / delete are Pro+ (backend plan
  // gate).
  // Human approval gate tools: requesting and status-checking only — there is
  // no approve / deny tool (structurally preventing agent self-approval;
  // decisions are made by a human on the dashboard /approvals page or via an
  // email link).
  request_approval: ["action", "summary", "metadata", "timeoutSeconds"],
  get_approval: ["approvalId"],
  list_approvals: ["status"],
  get_policy_gate: [],
  create_policy_gate: ["modelAllowlist", "blockPii", "blockSecrets", "enforceMode", "enabled"],
  update_policy_gate: ["policyId", "modelAllowlist", "blockPii", "blockSecrets", "enforceMode", "enabled"],
  delete_policy_gate: ["policyId"],
  // Prompt registry read tools: fetch the user's saved prompt templates, the
  // path by which an AI agent pulls template + variables + labels into
  // context. name / label / limit are query params; promptId is substituted
  // into the path just before the request.
  list_prompts: ["label", "name", "limit"],
  get_prompt: ["promptId"],
  // Prompt registry write tools. Pro+ only. create = create a new version;
  // update = partial update of template / variables / labels / description;
  // rename = change name + version (for typo fixes; a UNIQUE collision yields
  // 409); delete = deletion (204). Rides the path where the backend handles
  // field validation + plan gating + Origin/Referer CSRF defense.
  create_prompt: ["name", "version", "template", "variables", "labels", "description"],
  update_prompt: ["promptId", "template", "variables", "labels", "description"],
  rename_prompt: ["promptId", "name", "version"],
  delete_prompt: ["promptId"],
  // Prompt deploy / rollback (label = environment). deploy/rollback are Pro+;
  // get_deployed/list are Free. promptId is substituted into the path just
  // before the request; name/label go in the query/body.
  deploy_prompt: ["promptId", "label"],
  rollback_prompt: ["name", "label"],
  get_deployed_prompt: ["name", "label"],
  list_prompt_deployments: ["name", "label"],
  // Safety classifier read tools: the path by which an AI agent views
  // assessments written by the OpenAI Moderation cron. callId maps to the
  // /v1/safety-assessments?call_id= query param; assessmentId is substituted
  // into the path just before the request.
  list_safety_assessments: ["callId", "limit"],
  get_safety_assessment: ["assessmentId"],
  // Eval baseline runner tools: list is GET, detail bundles the scores, run
  // is POST (Pro+, handed to startEvalRun).
  list_eval_runs: ["limit"],
  get_eval_run: ["runId"],
  compare_eval_runs: ["baselineRunId", "candidateRunId"],
  // Dangerous mutations take an optional approvalId: the server atomically
  // verifies and consumes it ("approved + within expiry + action matches +
  // unconsumed"; 1 approval = 1 execution).
  bulk_delete_calls: ["callIds", "dryRun", "approvalId"],
  export_calls: ["startTime", "endTime", "provider", "model", "limit"],
  list_saved_views: [],
  create_saved_view: ["name", "filter"],
  delete_saved_view: ["id"],
  list_audit_log: ["limit", "eventType", "targetKind", "actorUserId", "from", "to", "cursor"],
  aggregate_calls: ["startTime", "endTime", "groupBy", "metric", "provider", "tagKey"],
  get_percentiles: ["startTime", "endTime", "provider", "model", "metric", "groupBy"],
  list_projects: [],
  // Read-only Team tool: list_members wraps GET /v1/memberships. Invite /
  // role-change / removal mutations are permission operations (consistent
  // with the philosophy of the human approval gate returning 403 for Bearer),
  // so they are not plain MCP tools; a future design will route them through
  // chat confirmation cards / the approval gate.
  list_members: [],
  create_project: ["name", "slug"],
  rename_project: ["projectId", "name", "slug"],
  delete_project: ["projectId"],
  // get_account_health: an AI agent gets a health summary of its LLM infra in
  // one call. Fetches 4 existing endpoints (aggregate / percentiles /
  // llm-budget / audit) in parallel and compresses them into one narrative
  // response. Accepts only a window parameter; no new backend endpoint needed
  // (a pure read aggregator).
  get_account_health: ["window"],
  // propose_alert_rules: the AI proposes recommended alert rules from
  // baseline statistics; applying them is a separate create_alert step after
  // customer confirmation. Fetches 4 existing endpoints (aggregate x2 +
  // percentiles + list_alerts) and returns recommendation JSON. No new
  // backend endpoint needed.
  propose_alert_rules: ["lookbackDays"],
  // detect_anomaly: anomaly detection on 4 dimensions (cost / latency /
  // error_rate / call_volume) by comparing the current window against a
  // baseline window. A pure MCP-side aggregator; zero backend changes.
  detect_anomaly: ["window", "threshold"],
  // classify_calls_batch: an AI agent batch-safety-scans unclassified calls
  // on demand (wraps POST /v1/safety-assessments/scan-batch). The Pro+ plan
  // gate and budget gate are handled on the backend.
  classify_calls_batch: ["maxRecords"],
  // propose_eval_criteria: generates eval criterion candidates via LLM judge
  // from useCaseHint + optional sampleCallIds (wraps POST
  // /v1/eval-criteria/propose). The Pro+ and budget gates are handled on the
  // backend; nothing is INSERTed (it only "proposes" — the user's adoption
  // decision is a separate create_eval_criterion step).
  propose_eval_criteria: ["useCaseHint", "sampleCallIds", "maxCriteria"],
  // idempotencyKey is required on this path (so the backend can dedupe when
  // an AI agent retries); the client supplies an opaque string up to 64 chars.
  run_eval: ["name", "recentCount", "label", "promptRegistryId", "idempotencyKey"],
  // Golden dataset tools (a fixed test set with expected outputs).
  // list/get/create are CRUD; run executes against the target model → judge →
  // eval_scores (regression A/B).
  list_eval_datasets: [],
  get_eval_dataset: ["datasetId"],
  create_eval_dataset: ["name", "description", "items", "frozen"],
  run_eval_dataset: ["datasetId", "targetModel", "judgeModel", "idempotencyKey"],
  delete_eval_dataset: ["datasetId"],
  // Autonomous AI ops tools. These are mutations, so dryRun is required; the
  // backend handles audit emission + UPDATE ordering + idempotency.
  purge_expired_plaintext: ["olderThanDays", "dryRun", "approvalId"],
  retry_failed_webhook: ["eventIds", "fromTimestamp", "toTimestamp", "maxRetries", "dryRun", "approvalId"],
  auto_silence_noisy_alert: [
    "alertId",
    "byVolumeThreshold",
    "silenceDurationMinutes",
    "reason",
    "dryRun",
    "approvalId",
  ],
  // Operator-scoped Stripe mutations. These are irreversible (trial extension
  // / promo application); the backend handles audit emission + the Stripe
  // Idempotency-Key, and dryRun=true previews only.
  extend_customer_trial: ["targetAccountId", "extendDays", "reason", "dryRun", "idempotencyKey", "approvalId"],
  apply_promo_code_to_customer: ["targetAccountId", "promoCode", "reason", "dryRun", "idempotencyKey", "approvalId"],
};

export const tools: Tool[] = [
  {
    name: "query_calls",
    description:
      "Argosvix にて記録された直近の LLM 呼び出し record を取得する。 " +
      "provider / model / 期間 / tag (= tagKey + tagValue の組) で filter 可能。 デフォルトは 直近 24 時間 + 100 件。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: {
          type: "integer",
          description: "返却 record 数 (1-500、デフォルト 100)",
          minimum: 1,
          maximum: 500,
          default: 100,
        },
        provider: {
          type: "string",
          description: "filter する provider (= openai / anthropic / gemini / mistral)。 省略で全 provider",
          enum: ["openai", "anthropic", "gemini", "mistral"],
        },
        model: {
          type: "string",
          description: "filter する model 名 (= 部分一致)。 省略で全 model",
        },
        rangePreset: {
          type: "string",
          description: "期間 preset。 デフォルト 24h",
          enum: ["24h", "7d", "30d", "90d"],
          default: "24h",
        },
        latencyMin: {
          type: "number",
          description: "応答時間の下限 (ms、 0 以上)。 外れ値 drill 用 (= 「2 秒超の呼び出しだけ」)",
          minimum: 0,
        },
        latencyMax: {
          type: "number",
          description: "応答時間の上限 (ms、 0 以上)。 latencyMin と併用で範囲指定",
          minimum: 0,
        },
        beforeTimestamp: {
          type: "string",
          description:
            "keyset pagination cursor (= 前ページ最終行の timestamp、 ISO-8601)。 beforeId と必ず併用。 timestamp 降順専用",
        },
        beforeId: {
          type: "string",
          description: "keyset pagination cursor (= 前ページ最終行の id)。 beforeTimestamp と必ず併用",
        },
        tagKey: {
          type: "string",
          description:
            "filter する tag の key (= 英数字 + _ - のみ、 1-64 文字、 先頭と末尾に - は不可)。 tagValue と必ず併用 (= 片方だけは 400)",
        },
        tagValue: {
          type: "string",
          description: "filter する tag の値 (= 完全一致、 1-256 文字)。 tagKey と必ず併用",
        },
      },
    },
  },
  {
    name: "get_cost_summary",
    description:
      "期間別の cost / call 数 / token 数 集計を返す。 provider 別 breakdown も同梱。 " +
      "groupBy=\"none\" を指定した場合は backend 互換上 provider 別 breakdown を返す " +
      "(= 全体合計は response.total フィールドで確認)。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        rangePreset: {
          type: "string",
          description: "集計期間。 デフォルト 7d",
          enum: ["24h", "7d", "30d", "90d"],
          default: "7d",
        },
        groupBy: {
          type: "string",
          description: "集計軸 (= 全体 sum / provider 別 / model 別)。 デフォルト provider",
          enum: ["none", "provider", "model"],
          default: "provider",
        },
      },
    },
  },
  {
    name: "list_alerts",
    description:
      "設定済 alert の一覧 + 直近 24 時間以内の trigger 履歴 を返す。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        includeTriggered: {
          type: "boolean",
          description: "true = trigger 履歴 (= triggered_at last 24h) も同梱",
          default: true,
        },
      },
    },
  },
  {
    name: "list_proposals",
    description:
      "Argosvix の番人が見つけた未対応の改善提案(品質ドリフト / 信頼性異常 / コスト切替 / 安全 / うるさいアラートのサイレンス)の一覧を返す。承認・却下・実行はダッシュボードの受信箱で行う(エージェントは閲覧と会話のみ)。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "get_proposal_thread",
    description:
      "指定 proposal のスレッド(これまでの質問と AI の返信)を返す。proposalId は list_proposals で取得。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["proposalId"],
      properties: {
        proposalId: {
          type: "string",
          description: "対象 proposal の ID (= list_proposals で取得、prp_ で始まる)",
        },
      },
    },
  },
  {
    name: "reply_proposal",
    description:
      "指定 proposal に質問を投稿し、その提案について AI の返信を得る(受信箱内の会話と同じ)。説明のみで実行は伴わない。proposalId は list_proposals で取得。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["proposalId", "body"],
      properties: {
        proposalId: {
          type: "string",
          description: "対象 proposal の ID (= list_proposals で取得)",
        },
        body: {
          type: "string",
          description: "提案についての質問(例: なぜ劣化した? 直すべき?)",
        },
      },
    },
  },
  {
    name: "silence_alert",
    description:
      "指定 alert を一時的にミュートする (= notification 送信を停止)。デフォルト 24 時間、 until に ISO-8601 タイムスタンプを指定すると 任意期限。 list_alerts で得た alertId を渡す。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["alertId"],
      properties: {
        alertId: {
          type: "string",
          description: "対象 alert の ID (= list_alerts で取得)",
          pattern: "^[A-Za-z0-9-]{1,64}$",
        },
        until: {
          type: "string",
          description: "ミュート解除時刻 ISO-8601 (= 例: 2026-06-01T00:00:00Z)。省略で 24 時間後",
        },
      },
    },
  },
  {
    name: "unsilence_alert",
    description: "ミュート中の alert を解除する。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["alertId"],
      properties: {
        alertId: {
          type: "string",
          description: "対象 alert の ID",
          pattern: "^[A-Za-z0-9-]{1,64}$",
        },
      },
    },
  },
  {
    name: "create_alert",
    description:
      "新しい alert ルールを作成する。 cost / error rate / latency / anomaly の閾値超過を監視し、 " +
      "指定した通知チャンネルへ送信する。 例: 「1 日のコストが $10 を超えたら email で通知」。 " +
      "channelKinds は有効化するチャンネル種別の配列、 channelTargets はその種別をキーにした宛先オブジェクト " +
      "(= 例 channelKinds:[\"email\"], channelTargets:{\"email\":\"dev@example.com\"})。 channelKinds に挙げた全 kind の宛先を channelTargets に含めること。 " +
      "anomaly_* タイプは thresholdValue を標準偏差の倍率 (0.5-10、 例 3 = 3σ) として解釈する。 " +
      "Free プランは email チャンネルのみ + alert 3 件まで (超過時は backend が 403 を返す)。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "name",
        "alertType",
        "thresholdValue",
        "channelKinds",
        "channelTargets",
      ],
      properties: {
        name: {
          type: "string",
          description: "alert の表示名 (1-100 文字、 改行不可)",
          minLength: 1,
          maxLength: 100,
          // The backend rejects names containing CR/LF (email header / Slack
          // text injection defense). Rejecting on the schema side too avoids a
          // wasted 400.
          pattern: "^[^\\r\\n]{1,100}$",
        },
        alertType: {
          type: "string",
          description:
            "監視する指標。 cost_threshold=単発コスト閾値 (USD) / monthly_budget=月次予算 (USD) / " +
            "error_rate=エラー率(%) / latency_degradation=レイテンシ劣化 (ms) / " +
            "anomaly_cost / anomaly_latency / anomaly_error_rate=異常検知 (= windowMinutes は 60 固定) / " +
            "eval_score=品質 SLO (= evalCriterionId 必須、 直近 window の平均 score が thresholdValue 未満で発火) / " +
            "guardian_findings=発見の外部通知 (= 受信箱の新しい発見を通知。 thresholdValue / windowMinutes は未使用なので 0 と 60 を渡す)",
          enum: [
            "cost_threshold",
            "error_rate",
            "latency_degradation",
            "monthly_budget",
            "anomaly_cost",
            "anomaly_latency",
            "anomaly_error_rate",
            "eval_score",
            "guardian_findings",
          ],
        },
        thresholdValue: {
          type: "number",
          description:
            "閾値 (= 0 以上)。 cost 系は USD、 error_rate は %、 latency_degradation は ms。 " +
            "anomaly 系は標準偏差の倍率 (= 例 3 = 3σ)",
          minimum: 0,
        },
        windowMinutes: {
          type: "integer",
          description:
            "集計時間窓 (分、5-43200)。 デフォルト 60。 anomaly 系では無視され 60 固定。",
          minimum: 5,
          maximum: 43200,
          default: 60,
        },
        filterProvider: {
          type: "string",
          description:
            "この provider のみを対象にする (= openai / anthropic / gemini / mistral)。 省略で全 provider",
          enum: ["openai", "anthropic", "gemini", "mistral"],
        },
        filterModel: {
          type: "string",
          description: "この model 名のみを対象にする (= 部分一致)。 省略で全 model",
          maxLength: 128,
        },
        channelKinds: {
          type: "array",
          description:
            "有効化する通知チャンネル種別の配列 (= channelTargets に同名キーの宛先が必要)。 " +
            "Free プランは email のみ利用可。",
          minItems: 1,
          items: {
            type: "string",
            enum: ["email", "slack", "webhook", "discord", "teams"],
          },
        },
        channelTargets: {
          type: "object",
          additionalProperties: false,
          description:
            "チャンネル種別をキー、宛先を値とするオブジェクト (= channelKinds に挙げた各 kind の宛先を必ず含める)。 " +
            "例: {\"email\": \"dev@example.com\"}。 email はメールアドレス、 " +
            "slack/discord/teams/webhook は各サービスの webhook URL。",
          properties: {
            email: { type: "string", description: "通知先メールアドレス" },
            slack: {
              type: "string",
              description: "Slack Incoming Webhook URL (https://hooks.slack.com/services/...)",
            },
            webhook: { type: "string", description: "汎用 webhook URL (https)" },
            discord: {
              type: "string",
              description: "Discord webhook URL (https://discord.com/api/webhooks/...)",
            },
            teams: {
              type: "string",
              description: "Microsoft Teams Incoming Webhook URL",
            },
          },
        },
        sleepMinutes: {
          type: "integer",
          description:
            "連続通知の抑制時間 (分、5-10080)。 一度発火したら この時間は再通知しない。 デフォルト 60。",
          minimum: 5,
          maximum: 10080,
          default: 60,
        },
        enabled: {
          type: "boolean",
          description: "作成直後に有効化するか。 デフォルト true。",
          default: true,
        },
        evalCriterionId: {
          type: "integer",
          description:
            "alertType=eval_score のとき必須。 監視する eval criterion の id (= list_eval_criteria.criteria[].id)。 直近 window の平均 score が thresholdValue 未満で発火する。",
          minimum: 1,
        },
        conditions: {
          type: "object",
          description:
            "複合条件 alert (= multi-condition)。 指定すると alertType + thresholdValue + " +
            "windowMinutes の単 metric 評価が ignored になり、 conditions JSON で AND/OR 集約 path に " +
            "switch する。 例: {\"operator\":\"AND\",\"conditions\":[{\"metric\":\"cost_threshold\",\"threshold\":100,\"windowMinutes\":60,\"comparator\":\">\"},{\"metric\":\"error_rate\",\"threshold\":0.05,\"windowMinutes\":60,\"comparator\":\">\"}]}。" +
            " backend で parseConditionsJson で shape 検証 (= operator AND/OR、 conditions 1-8 件、 各 metric/threshold/windowMinutes/comparator 必須)。 不要なら 省略 (= null) で 単 metric 評価のまま。",
          required: ["operator", "conditions"],
          additionalProperties: false,
          properties: {
            operator: {
              type: "string",
              enum: ["AND", "OR"],
              description: "複合条件の集約演算子。 AND = 全 sub が pass で trigger、 OR = 1 つ以上 pass で trigger。",
            },
            conditions: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              description: "1-8 件の sub-condition。 8 件超は backend が 400 を返す。",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["metric", "threshold", "windowMinutes", "comparator"],
                properties: {
                  metric: {
                    type: "string",
                    description: "対象 metric。 alert type と同じ値 (cost_threshold / error_rate / latency_degradation / monthly_budget 等) を使う。 それ以外の値 (例 latency_p95) は評価されず、 その条件は永遠に成立しない。",
                  },
                  threshold: {
                    type: "number",
                    description: "閾値 (= 単位は metric 依存、 cost は USD、 error_rate は %、 latency は ms)。",
                  },
                  windowMinutes: {
                    type: "integer",
                    minimum: 5,
                    maximum: 43200,
                    description: "集計時間窓 (分、 5-43200)。 sub 毎に独立。",
                  },
                  comparator: {
                    type: "string",
                    enum: [">", "<", ">=", "<="],
                    description: "閾値との比較演算子。",
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    name: "update_alert",
    description:
      "既存 alert の設定を更新する (= PATCH /v1/alerts/:id)。 alertType (= 監視タイプ) は immutable で、 " +
      "変更したい場合は新規 alert を作成してから旧 alert を delete する (= alert lifecycle 完結)。 " +
      "閾値 / 評価窓 / 通知チャンネル / 名前 / 有効化フラグ / 複合条件 を 部分 update 可能 (= 全フィールド optional)。 " +
      "例: 「月予算 alert の threshold を $100 → $50 に下げて」 / 「通知チャンネルを Slack に追加」。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["alertId"],
      properties: {
        alertId: {
          type: "string",
          description: "対象 alert の ID (= list_alerts で取得)",
          pattern: "^[A-Za-z0-9-]{1,64}$",
        },
        name: {
          type: "string",
          description: "alert の表示名 (1-100 文字、 改行不可)。 省略で 既存値維持",
          minLength: 1,
          maxLength: 100,
          pattern: "^[^\\r\\n]{1,100}$",
        },
        thresholdValue: {
          type: "number",
          description: "閾値 (= 0 以上)。 省略で 既存値維持",
          minimum: 0,
        },
        windowMinutes: {
          type: "integer",
          description: "集計時間窓 (分、 5-43200)。 省略で 既存値維持",
          minimum: 5,
          maximum: 43200,
        },
        filterProvider: {
          type: "string",
          description: "対象 provider。 省略で 既存値維持。 フィルター解除は この tool からは不可 (= 必要なら delete_alert + create_alert で作り直す)",
          enum: ["openai", "anthropic", "gemini", "mistral"],
        },
        filterModel: {
          type: "string",
          description: "対象 model (部分一致)。 省略で 既存値維持。 フィルター解除は この tool からは不可 (= 必要なら delete_alert + create_alert で作り直す)",
          maxLength: 128,
        },
        channelKinds: {
          type: "array",
          description: "有効化する通知チャンネル種別。 省略で 既存値維持。 channelTargets と同時更新推奨",
          minItems: 1,
          items: { type: "string", enum: ["email", "slack", "webhook", "discord", "teams"] },
        },
        channelTargets: {
          type: "object",
          description: "channelKinds に挙げた各 kind の宛先 object。 省略で 既存値維持",
          additionalProperties: false,
          properties: {
            email: { type: "string", description: "通知先メールアドレス" },
            slack: { type: "string", description: "Slack Incoming Webhook URL" },
            webhook: { type: "string", description: "汎用 webhook URL (https)" },
            discord: { type: "string", description: "Discord webhook URL" },
            teams: { type: "string", description: "Microsoft Teams Incoming Webhook URL" },
          },
        },
        sleepMinutes: {
          type: "integer",
          description: "連続通知の抑制時間 (分、 5-10080)。 省略で 既存値維持",
          minimum: 5,
          maximum: 10080,
        },
        enabled: {
          type: "boolean",
          description: "alert の有効化フラグ。 false で 一時的に評価を止める (= silence と違い再 enable には PATCH 必要)",
        },
        conditions: {
          type: "object",
          description:
            "複合条件 alert (= multi-condition) の更新。 指定すると 単 metric 評価を ignore し " +
            "AND/OR 集約に switch。 既存の 単 metric / multi-condition の どちらにも上書き可能。",
          required: ["operator", "conditions"],
          additionalProperties: false,
          properties: {
            operator: { type: "string", enum: ["AND", "OR"] },
            conditions: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["metric", "threshold", "windowMinutes", "comparator"],
                properties: {
                  metric: { type: "string" },
                  threshold: { type: "number" },
                  windowMinutes: { type: "integer", minimum: 5, maximum: 43200 },
                  comparator: { type: "string", enum: [">", "<", ">=", "<="] },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    name: "delete_alert",
    description:
      "alert を 削除する (= DELETE /v1/alerts/:id)。 関連する alert_events も CASCADE 削除される。 " +
      "誤削除防御のため、 必要に応じて事前に get_alert で 詳細確認を推奨。 " +
      "alert を一時停止したいだけなら delete でなく silence_alert (= ミュート) または update_alert で " +
      "enabled=false を 推奨 (= 復活可能)。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["alertId"],
      properties: {
        alertId: {
          type: "string",
          description: "対象 alert の ID (= list_alerts で取得)",
          pattern: "^[A-Za-z0-9-]{1,64}$",
        },
      },
    },
  },
  {
    name: "get_alert",
    description:
      "指定 alert の詳細設定と直近の trigger 履歴を返す。 list_alerts で得た alertId を渡す。 " +
      "閾値 / 通知チャンネル / silence 状態 / いつ発火したかを確認するのに使う。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["alertId"],
      properties: {
        alertId: {
          type: "string",
          description: "対象 alert の ID (= list_alerts で取得)",
          pattern: "^[A-Za-z0-9-]{1,64}$",
        },
      },
    },
  },
  {
    name: "list_alert_events",
    description:
      "alert の発火 (trigger) 履歴を新しい順で返す。 account 横断 (= 全 alert の最近の発火) が " +
      "デフォルト。 alertId を指定すると その alert のみに絞る。 「最近どの alert が何回発火したか」 " +
      "「コスト超過アラートはいつ鳴ったか」 等の確認に使う。 各 event の id は acknowledge_alert " +
      "tool に そのまま渡せる。 acknowledgedAt / acknowledgedBy は 未 ack なら null。 " +
      "各 event は発火時点の thresholdValue / windowMinutes / alertType snapshot を含む " +
      "(= 後から rule を編集しても発火当時の条件が分かる)。 次ページは最終 event の " +
      "triggeredAt + id を beforeTriggeredAt + beforeId に渡す (= keyset cursor)。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: {
          type: "integer",
          description: "返却する event 数 (1-100、 デフォルト 20)",
          minimum: 1,
          maximum: 100,
          default: 20,
        },
        alertId: {
          type: "string",
          description: "特定 alert に絞る場合の ID。 省略で全 alert の発火履歴",
          pattern: "^[A-Za-z0-9_-]{1,64}$",
        },
        beforeTriggeredAt: {
          type: "string",
          description: "ページング cursor (= 前ページ最終 event の triggeredAt)。 beforeId と必ず同時指定",
          format: "date-time",
        },
        beforeId: {
          type: "string",
          description: "ページング cursor (= 前ページ最終 event の id)。 beforeTriggeredAt と必ず同時指定",
          pattern: "^[A-Za-z0-9_-]{1,64}$",
        },
      },
    },
  },
  {
    name: "acknowledge_alert",
    description:
      "個別の alert 発火 (event) を 「対応 / 確認済」 mark する。 silence_alert (= alert rule 全体 " +
      "を 一時 mute) と 異なり、 ack は 1 つの event 単位の受領印で 同 rule の再発火は 通常通り " +
      "受け取れる。 eventId は list_alert_events で 得た id を そのまま渡す。 既 ack の event を " +
      "再 ack しても 既存の ack 情報 (= 最初の acknowledgedAt / acknowledgedBy) を 上書きせず " +
      "200 を返す (= idempotent、 alreadyAcknowledged フラグで 判別可)。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["eventId"],
      properties: {
        eventId: {
          type: "string",
          description: "ack 対象の event id (= list_alert_events.events[].id)",
          pattern: "^[A-Za-z0-9_-]{1,64}$",
        },
      },
    },
  },
  {
    name: "list_annotations_for_call",
    description:
      "指定 LLM call (= query_calls の records[].id) に紐付く annotation 一覧を返す。 " +
      "annotation = user 自身がつけた評価 (= rating / コメント / ラベル) で、 各 annotation の " +
      "annotationText / label / qualityScore / createdAt / updatedAt を含む。 " +
      "「この呼び出しに human review が付いているか」 「過去のレビュー履歴は何か」 を確認するのに使う。 " +
      "Pro+ 平文機能とは独立 (= annotation は平文を有効化していなくても利用可)。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["callId"],
      properties: {
        callId: {
          type: "string",
          description: "対象 call の id (= query_calls.records[].id)",
          pattern: "^[A-Za-z0-9_-]{1,128}$",
        },
      },
    },
  },
  {
    name: "list_annotations_by_label",
    description:
      "指定ラベルが付いた annotation を 新しい順に返す (= account 横断、 上限 100 件)。 " +
      "「good 評価された呼び出しを集める」 「bug ラベルの human review を一覧する」 等で使う。 " +
      "label は ASCII / 数字 / アンダースコア / ハイフン のみ (= [a-zA-Z0-9_-]、 64 字まで)。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["label"],
      properties: {
        label: {
          type: "string",
          description: "対象ラベル (= annotation 作成時の label と完全一致)",
          pattern: "^[A-Za-z0-9_-]{1,64}$",
        },
        limit: {
          type: "integer",
          description: "返却 annotation 数 (1-100、デフォルト 20)",
          minimum: 1,
          maximum: 100,
          default: 20,
        },
      },
    },
  },
  {
    name: "get_annotation",
    description:
      "指定 annotation id (= list_annotations_* で取得した id) の詳細を 1 件取得する。 " +
      "annotationText / label / qualityScore / callId / createdAt / updatedAt / createdByUserId を含む。 " +
      "他 account の id を指定しても 404 で構造防御。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["annotationId"],
      properties: {
        annotationId: {
          type: "integer",
          description: "対象 annotation の id (= AUTOINCREMENT 数値)",
          minimum: 1,
        },
      },
    },
  },
  {
    name: "create_annotation",
    description:
      "LLM call に対する新規 annotation (= human review / ラベル付け) を作成する。 " +
      "annotationText / label / qualityScore のうち少なくとも 1 つを指定する (= 「空 annotation」 は backend で 400)。 " +
      "用例: 「Claude、 この call を 『badly-summarized』 ラベルで quality 2 にして」、 " +
      "「eval ループ用に positive / negative の 二極ラベルを 大量付与する」。 " +
      "eval baseline runner (= run_eval) と 組み合わせると、 annotation を ground truth として 評価軸 を 校正できる。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["callId"],
      properties: {
        callId: {
          type: "string",
          description: "対象 call の id (= query_calls.records[].id)",
          pattern: "^[A-Za-z0-9_-]{1,128}$",
        },
        annotationText: {
          type: "string",
          description: "自由記述コメント (0-2000 文字)。 backend で長さ validation",
          maxLength: 2000,
        },
        label: {
          type: "string",
          description: "ラベル (0-50 文字、 英数 + _ - のみ)。 dashboard filter で 使える",
          maxLength: 50,
          pattern: "^[A-Za-z0-9_-]{0,50}$",
        },
        qualityScore: {
          type: "integer",
          description: "品質スコア (= 1-5 integer)。 省略で NULL",
          minimum: 1,
          maximum: 5,
        },
      },
    },
  },
  {
    name: "update_annotation",
    description:
      "既存 annotation の annotationText / label / qualityScore を 部分更新する (= PATCH /v1/annotations/:id)。 " +
      "callId は immutable。 「ラベルを 修正したい」 「qualityScore を 再評価して 4 → 5 に上げる」 用途。 " +
      "annotation_id は list_annotations_for_call で取得した annotations[].id を渡す。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["annotationId"],
      properties: {
        annotationId: {
          type: "integer",
          description: "対象 annotation の id (= AUTOINCREMENT 数値)",
          minimum: 1,
        },
        annotationText: {
          type: "string",
          description: "新しいコメント (0-2000 文字)。 省略で 既存値維持",
          maxLength: 2000,
        },
        label: {
          type: "string",
          description: "新しいラベル (0-50 文字、 英数 + _ - のみ)。 省略で 既存値維持",
          maxLength: 50,
          pattern: "^[A-Za-z0-9_-]{0,50}$",
        },
        qualityScore: {
          type: "integer",
          description: "新しい品質スコア (= 1-5)。 省略で 既存値維持",
          minimum: 1,
          maximum: 5,
        },
      },
    },
  },
  {
    name: "delete_annotation",
    description:
      "annotation を 削除する (= DELETE /v1/annotations/:id)。 関連 row は他に存在しないので CASCADE 影響なし。 " +
      "誤削除防御のため、 必要に応じて事前に get_annotation で 詳細確認を推奨。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["annotationId"],
      properties: {
        annotationId: {
          type: "integer",
          description: "対象 annotation の id (= AUTOINCREMENT 数値)",
          minimum: 1,
        },
      },
    },
  },
  {
    name: "list_eval_criteria",
    description:
      "LLM-as-judge の評価軸 (criteria) 一覧を返す。 global default 5 軸 " +
      "(helpfulness / accuracy / relevance / safety / conciseness) + 自 account で 作成した " +
      "custom criteria を まとめて 返却する。 各 criterion は id / name / rubric (= judge への " +
      "instruction text) / scaleMin / scaleMax を持つ。 「eval を 走らせる前に どの軸で 評価できるか」 " +
      "確認するのに使う。 Free plan でも 全 criteria 取得可 (= custom 作成は Pro+ 限定だが 既存 " +
      "row は 解約後も visible 維持)。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "get_eval_criterion",
    description:
      "指定 criterion id の詳細 (= name / rubric / scaleMin / scaleMax / createdAt) を 1 件取得する。 " +
      "id は list_eval_criteria で取得した criteria[].id。 global default (= accountId NULL) も " +
      "自 account custom も accept、 他 account の custom は 404 で構造防御。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["criterionId"],
      properties: {
        criterionId: {
          type: "integer",
          description: "対象 criterion の id (= AUTOINCREMENT 数値)",
          minimum: 1,
        },
      },
    },
  },
  {
    name: "create_eval_criterion",
    description:
      "自 account custom eval criterion を 1 件作成する (= Pro+ 専用)。 " +
      "name + rubric + scaleMin + scaleMax は必須。 同 account 内で 同 name 既存 = 409。 " +
      "global default と同 name は 構造的に重複可 (= UNIQUE (account_id, name) で account_id IS NULL と分離)。 " +
      "type 既定は 'llm_judge' (= judge LLM 採点)。 type に決定的評価器 (exact_match / contains / regex / json_schema / json_path) を " +
      "指定すると LLM を呼ばず無料・即時で採点 (= pass→scaleMax / fail→scaleMin)。 決定的 type は config 必須。 " +
      "AI agent が 自分の workload を 評価する中で 「この基準を追加」 と判断した時に使う。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "rubric", "scaleMin", "scaleMax"],
      properties: {
        name: {
          type: "string",
          description: "criterion 名 (= 1-50 文字、 英数始まり、 [A-Za-z0-9 _\\-.] のみ)。 例 'helpfulness' / 'concise'",
          pattern: "^[A-Za-z0-9][A-Za-z0-9 _\\-.]{0,49}$",
          minLength: 1,
          maxLength: 50,
        },
        rubric: {
          type: "string",
          description: "scoring rubric 本文 (= 10-2000 文字、 judge LLM が score の根拠とする 説明文。 決定的評価器でも人間向け説明として必須)",
          minLength: 10,
          maxLength: 2000,
        },
        scaleMin: {
          type: "integer",
          description: "score 下限 (= 1-100 範囲、 scaleMax より小さい)",
          minimum: 1,
          maximum: 100,
        },
        scaleMax: {
          type: "integer",
          description: "score 上限 (= 1-100 範囲、 scaleMin より大きい)",
          minimum: 1,
          maximum: 100,
        },
        type: {
          type: "string",
          description:
            "評価器の種別 (= 既定 'llm_judge')。 決定的評価器は LLM を呼ばず無料・即時: " +
            "'exact_match' / 'contains' / 'regex' / 'json_schema' / 'json_path'",
          enum: ["llm_judge", "exact_match", "contains", "regex", "json_schema", "json_path"],
        },
        config: {
          type: "object",
          description:
            "type 別の設定 (= llm_judge では不要)。 exact_match: {expectedOutput}、 " +
            "contains: {substring, caseSensitive?}、 regex: {pattern, flags?}、 " +
            "json_schema: {schema}、 json_path: {path, expectedValue?}。 " +
            "categorical 採点では config.categories(worst→best の 2-10 個)も必須。",
          additionalProperties: true,
        },
        scoreType: {
          type: "string",
          description:
            "採点型(既定 numeric)。 boolean=pass/fail、 categorical は config.categories が必須(llm_judge 専用)",
          enum: ["numeric", "boolean", "categorical"],
        },
        scope: {
          type: "string",
          description:
            "評価スコープ(既定 call)。 call=呼び出し単位、 trajectory=同一 trace の複数呼び出し+ステップを 1 軌跡として採点(llm_judge 専用)",
          enum: ["call", "trajectory"],
        },
      },
    },
  },
  {
    name: "update_eval_criterion",
    description:
      "自 account custom criterion を full replace で更新する (= Pro+ 専用、 PATCH /v1/eval-criteria/:id)。 " +
      "name + rubric + scaleMin + scaleMax は必須 (= 部分更新ではない、 全 field 上書き)。 " +
      "type / config も full replace 対象 (= 省略時は 'llm_judge' / config なしに戻る)。 決定的 type は config 必須。 " +
      "global default (= account_id IS NULL) は 構造的に対象外 (= 404)、 他 account の custom も 404。 " +
      "同 account 内 で 同 name 衝突 = 409。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["criterionId", "name", "rubric", "scaleMin", "scaleMax"],
      properties: {
        criterionId: {
          type: "integer",
          description: "対象 criterion の id (= list_eval_criteria.criteria[].id)",
          minimum: 1,
        },
        name: {
          type: "string",
          description: "新 name (= 1-50 文字、 英数始まり、 [A-Za-z0-9 _\\-.] のみ)",
          pattern: "^[A-Za-z0-9][A-Za-z0-9 _\\-.]{0,49}$",
          minLength: 1,
          maxLength: 50,
        },
        rubric: {
          type: "string",
          description: "新 rubric (= 10-2000 文字)",
          minLength: 10,
          maxLength: 2000,
        },
        scaleMin: {
          type: "integer",
          description: "新 scaleMin (= 1-100、 scaleMax より小さい)",
          minimum: 1,
          maximum: 100,
        },
        scaleMax: {
          type: "integer",
          description: "新 scaleMax (= 1-100、 scaleMin より大きい)",
          minimum: 1,
          maximum: 100,
        },
        type: {
          type: "string",
          description:
            "評価器の種別 (= 省略時 'llm_judge')。 決定的: 'exact_match' / 'contains' / 'regex' / 'json_schema' / 'json_path'",
          enum: ["llm_judge", "exact_match", "contains", "regex", "json_schema", "json_path"],
        },
        config: {
          type: "object",
          description:
            "type 別の設定 (= llm_judge では不要)。 exact_match: {expectedOutput}、 " +
            "contains: {substring, caseSensitive?}、 regex: {pattern, flags?}、 " +
            "json_schema: {schema}、 json_path: {path, expectedValue?}。 " +
            "categorical 採点では config.categories(worst→best の 2-10 個)も必須。",
          additionalProperties: true,
        },
        scoreType: {
          type: "string",
          description:
            "採点型(既定 numeric)。 boolean=pass/fail、 categorical は config.categories が必須(llm_judge 専用)",
          enum: ["numeric", "boolean", "categorical"],
        },
        scope: {
          type: "string",
          description:
            "評価スコープ(既定 call)。 call=呼び出し単位、 trajectory=軌跡単位(llm_judge 専用)",
          enum: ["call", "trajectory"],
        },
      },
    },
  },
  {
    name: "get_llm_budget",
    description:
      "現在の LLM feature 月予算 (= safety classifier + PII 二次 audit + eval baseline runner の 3 軸 LLM cost cap) を取得する。 " +
      "response = { budgetUsd, spentUsd, remainingUsd, periodStart, defaultBudgetUsd, minBudgetUsd, maxBudgetUsd }。 " +
      "Free / Pro+ 共通で読み取り可能、 「予算 80% 到達したか?」 「raise すべきか?」 を AI agent が 判断する path で使う。 " +
      "default = $5/月、 月跨ぎ (= YYYY-MM 単位) で 自動 reset。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "raise_llm_budget",
    description:
      "LLM feature 月予算 を 引き上げる / 引き下げる (= Pro+ 専用)。 " +
      "range = $5 - $500 (= hard cap で runaway 防御)、 0.01 USD 単位。 既存 spent は そのまま維持、 月跨ぎ で 自動 reset。 " +
      "用例: 「予算が 80% 到達した、 今月だけ $30 に上げて」 / 「使いすぎたから来月は $10 に下げて」。 " +
      "新規 値 < 現 spent でも accept (= remaining が 0 になるだけ、 月跨ぎで 0 から計上し直す)。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["budgetUsd"],
      properties: {
        budgetUsd: {
          type: "number",
          description: "新 月予算 USD (= 5-500、 0.01 単位)。 例 30 / 50.5 / 100",
          minimum: 5,
          maximum: 500,
        },
      },
    },
  },
  {
    name: "get_budget_gate",
    description:
      "runtime 予算ゲート (= ランタイム制御プレーンの一部) の設定一覧 + 当月 LLM 消費額を取得する。 " +
      "response = { gates: [{ id, projectId, monthlyLimitUsd, enforceMode, enabled, ... }], spentUsdThisMonth, monthStart, ttlSeconds }。 monthStart は UTC 月初 (= JST では月初日 09:00 にリセット)。 " +
      "SDK の budgetGate opt-in が実行前に評価するのと同じ source。 get_llm_budget (= Argosvix 内部 AI 機能の費用 cap) とは別物で、 こちらは user 自身の LLM 支出の月次上限。 " +
      "用例: 「今月の予算ゲートの残りは?」 「ゲートは fail_open になってる?」",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "create_budget_gate",
    description:
      "runtime 予算ゲートを作成する (= Pro+ 専用)。 account 全体の月次 LLM 支出上限 (USD) を設定し、 SDK (budgetGate opt-in) が超過呼び出しを実行前に block する。 " +
      "enforce は楽観方式 (= 消費額は 60 秒 cache + 実行中の呼び出し分は通るため、 上限は厳密な hard cap ではなく目安として超過しうる)。 " +
      "enforceMode = fail_open (default、 backend 不達時は通す) / fail_closed (不達時も止める。 SDK が設定を一度も取得できていない cold start は SDK 側の failClosed opt-in が別途必要)。 " +
      "projectId 省略 = account 全体 gate (= 1 つだけ、 既存ありで 409)。 projectId 指定 = そのプロジェクト専用 gate (= account gate と AND で最も厳しい上限が勝つ、 1 project 1 つ)。 " +
      "tagKey + tagValue 指定 = そのタグを持つ呼び出し専用 gate (例 tagKey=service / tagValue=checkout で service=checkout の月次支出に上限。 account gate と AND、 1 (tagKey,tagValue) 1 つ)。 tagKey/tagValue は両方指定が必須で projectId とは排他。 " +
      "用例: 「月 $50 で予算ゲートを作って」 「プロジェクト X に月 $10 上限のゲートを設定」 「service=checkout のタグに月 $20 上限」",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["monthlyLimitUsd"],
      properties: {
        monthlyLimitUsd: {
          type: "number",
          description: "月次上限 USD (= 0.01 - 1000000、 0.01 単位)。 例 50 / 100.5",
          minimum: 0.01,
          maximum: 1000000,
        },
        enforceMode: {
          type: "string",
          enum: ["fail_open", "fail_closed"],
          description: "backend 不達時の挙動 (default fail_open)",
        },
        enabled: {
          type: "boolean",
          description: "gate の有効状態 (default true)",
        },
        projectId: {
          type: "string",
          description: "proj_ 形式の project ID (省略時は account 全体 gate)。 指定 project は自 account 所有・非 archived 必須",
        },
        tagKey: {
          type: "string",
          description: "タグ別 gate のタグ key (例 service)。 tagValue と必ず同時指定、 projectId とは排他。 1-128 文字",
        },
        tagValue: {
          type: "string",
          description: "タグ別 gate のタグ value (例 checkout)。 tagKey と必ず同時指定。 1-128 文字",
        },
      },
    },
  },
  {
    name: "update_budget_gate",
    description:
      "runtime 予算ゲートを更新する (= Pro+ 専用)。 monthlyLimitUsd / enforceMode / enabled のいずれかを部分更新。 " +
      "用例: 「上限を $100 に上げて」 「ゲートを一時的に無効化して」 「fail_closed に切り替えて」",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["gateId"],
      properties: {
        gateId: {
          type: "string",
          description: "対象 gate の id (= get_budget_gate で取得、 bg_ 始まり)",
        },
        monthlyLimitUsd: {
          type: "number",
          description: "新 月次上限 USD (= 0.01 - 1000000、 0.01 単位)",
          minimum: 0.01,
          maximum: 1000000,
        },
        enforceMode: {
          type: "string",
          enum: ["fail_open", "fail_closed"],
          description: "backend 不達時の挙動",
        },
        enabled: {
          type: "boolean",
          description: "gate の有効状態",
        },
      },
    },
  },
  {
    name: "delete_budget_gate",
    description:
      "runtime 予算ゲートを削除する (= Pro+ 専用)。 削除後は SDK の実行前 enforce が無効になる。 一時停止だけなら update_budget_gate の enabled: false を推奨。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["gateId"],
      properties: {
        gateId: {
          type: "string",
          description: "対象 gate の id (= get_budget_gate で取得、 bg_ 始まり)",
        },
      },
    },
  },
  {
    name: "request_approval",
    description:
      "人間承認ゲート (= ランタイム制御プレーンの一部) に承認依頼を作成する (= Pro+ 専用)。 危険操作 (削除 / 送金 / 退会等) の前に呼ぶと account owner へ email 通知が飛び、 人間が dashboard か email link で承認 / 否認する。 " +
      "重要: 承認 / 否認を実行する MCP tool は存在しない (= AI agent は自分の依頼を自己承認できない)。 結果は get_approval で polling して確認する。 " +
      "timeoutSeconds (default 3600) 切れは expired = 否認扱い。 " +
      "server-side 消費: 危険 mutation tool (bulk_delete_calls / purge_expired_plaintext / retry_failed_webhook / auto_silence_noisy_alert / extend_customer_trial / apply_promo_code_to_customer) に approvalId を渡すと backend が action 一致 + approved + 期限内 + 未消費を検証して実行時に消費する (= 1 approval = 1 実行)。 この場合 action は対象 tool 名と完全一致で作成すること。 " +
      "用例: 「user usr_123 の削除は危険操作なので人間の承認を取って」",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action", "summary"],
      properties: {
        action: {
          type: "string",
          description: "操作の識別子 (= 1-128 文字、 英数 ._: - と空白)。 例 delete_user",
        },
        summary: {
          type: "string",
          description: "人間が読む 1 行説明 (= 1-500 文字、 承認 email にそのまま載る)",
        },
        metadata: {
          type: "object",
          description: "補足 JSON object (= 4KB まで、 任意)",
        },
        timeoutSeconds: {
          type: "integer",
          description: "承認期限秒 (= 60-86400、 default 3600)",
          minimum: 60,
          maximum: 86400,
        },
      },
    },
  },
  {
    name: "get_approval",
    description:
      "承認依頼の現在状態を取得する。 status = pending / approved / denied / expired。 approved 以外なら対象操作を実行しないこと (= default-deny)。 危険 mutation tool は approvalId param で server-side 消費にも対応 (= request_approval の説明参照)。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["approvalId"],
      properties: {
        approvalId: {
          type: "string",
          description: "request_approval が返した id (= apr_ 始まり)",
        },
      },
    },
  },
  {
    name: "list_approvals",
    description:
      "承認依頼の一覧を取得する (= 最新 50 件)。 status filter = pending (default) / approved / denied / expired / all。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: ["pending", "approved", "denied", "expired", "all"],
          description: "status filter (default pending)",
        },
      },
    },
  },
  {
    name: "get_policy_gate",
    description:
      "runtime ポリシーゲート (= ランタイム制御プレーンの一部) の設定を取得する。 " +
      "response = { policy: { id, modelAllowlist, blockPii, blockSecrets, enforceMode, enabled, ... } | null }。 " +
      "SDK の policyGate opt-in が LLM 呼び出し前にローカル評価する設定 (= モデル allowlist 完全一致 + PII / secret 検知で block)。 " +
      "用例: 「いまのモデル制限は?」 「PII block は有効?」",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "create_policy_gate",
    description:
      "runtime ポリシーゲートを作成する (= Pro+ 専用)。 account 全体のモデル allowlist / PII block / secret block を設定し、 SDK (policyGate opt-in) が違反呼び出しを実行前に block する。 " +
      "少なくとも 1 つのルール (modelAllowlist / blockPii / blockSecrets) が必要。 account に 1 つだけ (= 既存ありで 409)。 redact モードは未対応 (= block のみ)。 " +
      "用例: 「gpt-5.5 と claude-fable-5 だけ許可して」 「PII を含む呼び出しを止めて」",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        modelAllowlist: {
          type: "array",
          items: { type: "string" },
          description:
            "許可モデル名の配列 (= 1-100 件、 完全一致)。 省略 = モデル制限なし",
        },
        blockPii: {
          type: "boolean",
          description:
            "PII 検知で block。 検知範囲 = email / カード番号 (Luhn 検証付) / 区切りあり電話番号 / 区切りあり個人番号 / IPv4 / IPv6 (完全形 + 主要圧縮形)。 区切りなし連続数字の電話・個人番号は誤遮断防止のため対象外",
        },
        blockSecrets: {
          type: "boolean",
          description: "API key / private key らしき token 検知で block",
        },
        enforceMode: {
          type: "string",
          enum: ["fail_open", "fail_closed"],
          description: "backend 不達時の挙動 (default fail_open)",
        },
        enabled: {
          type: "boolean",
          description: "gate の有効状態 (default true)",
        },
      },
    },
  },
  {
    name: "update_policy_gate",
    description:
      "runtime ポリシーゲートを更新する (= Pro+ 専用)。 modelAllowlist (= null で制限解除) / blockPii / blockSecrets / enforceMode / enabled を部分更新。 " +
      "用例: 「allowlist に gpt-4o-mini を足して」 「secret block を有効化」",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["policyId"],
      properties: {
        policyId: {
          type: "string",
          description: "対象 policy の id (= get_policy_gate で取得、 pg_ 始まり)",
        },
        modelAllowlist: {
          type: ["array", "null"],
          items: { type: "string" },
          description: "新 allowlist (= null でモデル制限解除)",
        },
        blockPii: { type: "boolean" },
        blockSecrets: { type: "boolean" },
        enforceMode: {
          type: "string",
          enum: ["fail_open", "fail_closed"],
        },
        enabled: { type: "boolean" },
      },
    },
  },
  {
    name: "delete_policy_gate",
    description:
      "runtime ポリシーゲートを削除する (= Pro+ 専用)。 一時停止だけなら update_policy_gate の enabled: false を推奨。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["policyId"],
      properties: {
        policyId: {
          type: "string",
          description: "対象 policy の id (= get_policy_gate で取得、 pg_ 始まり)",
        },
      },
    },
  },
  {
    name: "test_webhook",
    description:
      "指定 URL に 1 件 fabricated alert を 試送する (= Pro+ 専用)。 " +
      "user が webhook URL を 登録する 前 に 「届くか」 を 確認する 主用途。 " +
      "SSRF 防御で https 必須 + private / loopback / cloud metadata IP は reject。 " +
      "secret 指定時は HMAC-SHA256 署名 (= X-Argosvix-Signature) を 添付。 " +
      "rate limit = account 単位 5/分 (= 60s sliding window、 worker instance 越境で 超過余地あり)。 " +
      "response.delivered = receiver が 5s 以内に 2xx 返した か。 false の場合は 「URL 不正 / timeout / 5xx / network error」 のいずれか。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: {
          type: "string",
          description: "送信先 webhook URL (= https、 SSRF 防御済、 1-500 chars)",
          minLength: 1,
          maxLength: 500,
        },
        secret: {
          type: "string",
          description: "HMAC-SHA256 署名用 secret (= 任意、 1-256 chars、 receiver 側で X-Argosvix-Signature 検証)",
          minLength: 1,
          maxLength: 256,
        },
        alertName: {
          type: "string",
          description: "fabricated alert の name (= 任意、 1-64 chars、 [A-Za-z0-9 _\\-.] のみ)。 省略時は 'argosvix test alert'",
          pattern: "^[A-Za-z0-9][A-Za-z0-9 _\\-.]{0,63}$",
          minLength: 1,
          maxLength: 64,
        },
      },
    },
  },
  {
    name: "delete_eval_criterion",
    description:
      "自 account custom criterion を 削除する (= Pro+ 専用、 DELETE /v1/eval-criteria/:id、 204)。 " +
      "global default (= account_id IS NULL) は 構造防御で対象外 = 404、 他 account も 404。 " +
      "⚠ 過去全 eval_run の 該当 criterion score 行 (= eval_scores) も ON DELETE CASCADE で 同時に物理削除される、 " +
      "履歴比較や score 推移分析が 永久に不可になる。 " +
      "AI agent が 「criterion 整理」 で 軽い気持ちで 呼ぶ tool ではない、 過去 run の 該当 score が要らないと user が明示確認した時のみ実行する。 " +
      "rename したい だけ なら update_eval_criterion (= full replace) で name + rubric + scaleMin + scaleMax を 渡す 方が 履歴を 失わずに 済む。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["criterionId"],
      properties: {
        criterionId: {
          type: "integer",
          description: "対象 criterion の id (= list_eval_criteria.criteria[].id)",
          minimum: 1,
        },
      },
    },
  },
  {
    name: "list_webhooks",
    description:
      "登録済みの外向き event webhook 一覧を返す (= GET /v1/webhooks)。 各 webhook は " +
      "id / url / hasSecret / enabled / eventTypes / lastStatus / consecutiveFailures 等を含む " +
      "(secret 本体は返らない)。 account の出来事(承認依頼・提案の実行/取消)を外部 endpoint へ " +
      "署名付き POST で通知する購読面。 Free でも閲覧可。",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "create_webhook",
    description:
      "外向き event webhook を 1 件登録する (= Pro+ 専用、 POST /v1/webhooks)。 " +
      "url(HTTPS 必須、 SSRF 防御で private/loopback 拒否)+ 任意の secret(HMAC-SHA256 署名キー)+ " +
      "eventTypes(購読する event 種別の配列、 省略 / 空 = 全件購読)。 account あたり最大 10 件。 " +
      "配信 payload = { event, eventId, occurredAt, accountId, data }、 secret 設定時は X-Argosvix-Signature ヘッダ付き。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: {
          type: "string",
          description: "通知先 URL(HTTPS 必須、 private/loopback host は拒否)",
        },
        secret: {
          type: "string",
          description: "任意。HMAC-SHA256 署名キー(設定すると X-Argosvix-Signature を付与)",
        },
        eventTypes: {
          type: "array",
          description:
            "購読する event 種別の配列(省略 / 空配列 = 全件購読)。 利用可能: approval.requested / proposal.executed / proposal.reversed",
          items: {
            type: "string",
            enum: ["approval.requested", "proposal.executed", "proposal.reversed"],
          },
        },
        description: { type: "string", description: "表示用メモ(任意、 最大 200 文字)" },
        enabled: { type: "boolean", description: "有効フラグ(既定 true)" },
      },
    },
  },
  {
    name: "update_webhook",
    description:
      "外向き event webhook を部分更新する (= Pro+ 専用、 PATCH /v1/webhooks/:id)。 " +
      "指定した field のみ変更(url / secret / eventTypes / description / enabled)。 " +
      "secret は省略で 既存値維持、 空文字 \"\" を送ると署名解除 (= null は schema 上送れない)。 enabled=true で再有効化すると連続失敗カウンタもリセット。 " +
      "他 account の webhook は 404。 webhookId は list_webhooks の id。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["webhookId"],
      properties: {
        webhookId: { type: "string", description: "対象 webhook の id (= owh_...)" },
        url: { type: "string", description: "新 URL(HTTPS 必須)" },
        secret: { type: "string", description: "新 secret。 省略で 既存値維持、 空文字 \"\" で署名解除(null は送れない)" },
        eventTypes: {
          type: "array",
          description: "購読 event 種別の配列(空 = 全件)",
          items: {
            type: "string",
            enum: ["approval.requested", "proposal.executed", "proposal.reversed"],
          },
        },
        description: { type: "string", description: "表示用メモ" },
        enabled: { type: "boolean", description: "有効フラグ" },
      },
    },
  },
  {
    name: "delete_webhook",
    description:
      "外向き event webhook を削除する (= Pro+ 専用、 DELETE /v1/webhooks/:id)。 " +
      "他 account の webhook は 404。 webhookId は list_webhooks の id。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["webhookId"],
      properties: {
        webhookId: { type: "string", description: "対象 webhook の id (= owh_...)" },
      },
    },
  },
  {
    name: "list_prompts",
    description:
      "user が登録した prompt template の一覧を返す。 " +
      "各 prompt は id / name / version / template / variables / labels / description / createdAt を含む。 " +
      "「production」 等の label で filter (= ?label=xxx) または 同 name の全 version 取得 " +
      "(= ?name=xxx) が可能。 上限 200 件、 sort = name ASC + created_at DESC。 user が dashboard で " +
      "登録した prompt を AI agent が 直接読んで 使う 主要 path。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        label: {
          type: "string",
          description: "label filter (= 例 'production' / 'staging' / 'experiment')。 完全一致。",
          pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$",
        },
        name: {
          type: "string",
          description: "name filter (= 同 name の全 version を 取得)。 完全一致。",
          pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
        },
        limit: {
          type: "integer",
          description: "返却 prompt 数 (1-200、 デフォルト 200)",
          minimum: 1,
          maximum: 200,
          default: 200,
        },
      },
    },
  },
  {
    name: "get_prompt",
    description:
      "指定 prompt id の詳細を 1 件取得する。 id は list_prompts の prompts[].id を そのまま使う。 " +
      "template + variables + labels + description を含む、 自 account scope (= backend WHERE 句で 構造防御、 他 account の id は 404)。 " +
      "argosvix://prompts/{id} resource template と 同 endpoint。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["promptId"],
      properties: {
        promptId: {
          type: "integer",
          description: "対象 prompt の id (= AUTOINCREMENT 数値)",
          minimum: 1,
        },
      },
    },
  },
  {
    name: "create_prompt",
    description:
      "新 prompt template を 1 件登録する (= Pro+ 専用)。 name + version + template が 必須、 " +
      "variables / labels / description は 任意。 同 (name, version) が 既存 = 409 を 返す (= UNIQUE 制約)。 " +
      "AI agent が eval / experiment 用の template を 自動登録する path で 使う。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "version", "template"],
      properties: {
        name: {
          type: "string",
          description: "prompt 名 (= 同 series 識別子、 [A-Za-z0-9][A-Za-z0-9_-]{0,63})。 例 'customer_support'",
          pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
        },
        version: {
          type: "string",
          description: "version 識別子 (= [A-Za-z0-9][A-Za-z0-9._-]{0,63})。 例 'v1' / '1.0.2' / '2026-06-03'",
          pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
        },
        template: {
          type: "string",
          description: "prompt body 本文 (= 非空、 最大 50000 文字)。 {{var}} で variables 補完。",
          minLength: 1,
          maxLength: 50000,
        },
        variables: {
          type: "object",
          description: "template 内 {{var}} の default 値 (= plain object、 JSON 化後 4096 bytes 上限)。 任意。",
          additionalProperties: true,
        },
        labels: {
          type: "array",
          description: "label 配列 (= 最大 8 件、 各 [A-Za-z0-9][A-Za-z0-9_-]{0,31})。 例 ['production', 'staging']。",
          items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$" },
          maxItems: 8,
        },
        description: {
          type: "string",
          description: "説明文 (= 最大 500 文字)。 任意。",
          maxLength: 500,
        },
      },
    },
  },
  {
    name: "update_prompt",
    description:
      "既存 prompt の template / variables / labels / description を 部分更新する (= Pro+ 専用、 PATCH /v1/prompts/:id)。 " +
      "name + version は immutable (= 変更は rename_prompt 経由)。 promptId 必須、 残 field は 指定 した もの のみ 更新。 " +
      "AI agent が label の付け替え (= 'staging' → 'production' 昇格) や 微修正 patch path で 使う。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["promptId"],
      properties: {
        promptId: {
          type: "integer",
          description: "対象 prompt の id (= list_prompts.prompts[].id)",
          minimum: 1,
        },
        template: {
          type: "string",
          description: "新 template 本文 (= 非空、 最大 50000 文字)。",
          minLength: 1,
          maxLength: 50000,
        },
        variables: {
          type: "object",
          description: "新 variables (= plain object)。 省略で 既存値維持 (= null は schema 上送れない)。 全消ししたい場合は 空 object {} を渡す (= 空の variables で上書き)。",
          additionalProperties: true,
        },
        labels: {
          type: "array",
          description: "新 labels (= 完全置換、 最大 8 件、 各 [A-Za-z0-9][A-Za-z0-9_-]{0,31})。",
          items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$" },
          maxItems: 8,
        },
        description: {
          type: "string",
          description: "新 description (= 1-500 文字)。 省略すると 既存 description を維持。 空文字 '' は schema 拒否 (= LLM の hallucination で 既存 description が 消える 事故防止)。 既存 description の clear は この tool からは 不可。",
          minLength: 1,
          maxLength: 500,
        },
      },
    },
  },
  {
    name: "rename_prompt",
    description:
      "既存 prompt の name + version を 変更する (= Pro+ 専用、 POST /v1/prompts/:id/rename)。 " +
      "typo 修正軸 (= 'customer_supprt' → 'customer_support') が 主用途。 同 account 内で 既存 (name, version) と 衝突 = 409。 " +
      "update_prompt が name/version を 変えない 規約な ので、 rename は 別 tool で 意味的分離。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["promptId", "name", "version"],
      properties: {
        promptId: {
          type: "integer",
          description: "対象 prompt の id (= list_prompts.prompts[].id)",
          minimum: 1,
        },
        name: {
          type: "string",
          description: "新 name (= [A-Za-z0-9][A-Za-z0-9_-]{0,63})",
          pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
        },
        version: {
          type: "string",
          description: "新 version (= [A-Za-z0-9][A-Za-z0-9._-]{0,63})",
          pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
        },
      },
    },
  },
  {
    name: "delete_prompt",
    description:
      "既存 prompt を 削除する (= Pro+ 専用、 DELETE /v1/prompts/:id、 204 No Content)。 " +
      "自 account scope (= 他 account の id は 404)。 ⚠ 物理削除な ので 復元不可、 " +
      "過去の eval_runs の prompt_registry_id は SET NULL になり 「どの prompt template で run したか」 の trace が失われる (= 履歴比較で 紐付き 不可)。 " +
      "AI agent は 「rotation で 旧 version を sunset」 で 使う 場合 でも、 過去 run trace が 残っている うちは update_prompt で labels を 'sunset' 等に 付け替えて 論理 sunset する 方が安全。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["promptId"],
      properties: {
        promptId: {
          type: "integer",
          description: "対象 prompt の id (= list_prompts.prompts[].id)",
          minimum: 1,
        },
      },
    },
  },
  {
    name: "deploy_prompt",
    description:
      "prompt の特定 version を label(= production / staging 等の環境)にデプロイする " +
      "(= Pro+ 専用、 POST /v1/prompts/:id/deploy)。 既存デプロイがあれば直前版を previous に控え、 " +
      "rollback_prompt で 1-click で戻せる。 同一版の再デプロイは previous を作らない。 " +
      "label は prompt name 単位(= 各 name が独自の production 版を持つ)。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["promptId", "label"],
      properties: {
        promptId: {
          type: "integer",
          description: "デプロイする version の id (= list_prompts.prompts[].id)",
          minimum: 1,
        },
        label: {
          type: "string",
          description: "環境ラベル(英数 + _ - 、 1-32 文字。 例 'production' / 'staging')",
          pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$",
        },
      },
    },
  },
  {
    name: "rollback_prompt",
    description:
      "label にデプロイ中の prompt を直前版へ戻す(= Pro+ 専用、 POST /v1/prompts/deployments/rollback)。 " +
      "previous が無い(初回デプロイのみ)場合は 409、 直前版が既に削除済みなら 409。 " +
      "戻した後はもう一度 rollback で行き来できる(current ⇄ previous の入替)。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "label"],
      properties: {
        name: {
          type: "string",
          description: "対象 prompt name",
          pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
        },
        label: {
          type: "string",
          description: "環境ラベル",
          pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$",
        },
      },
    },
  },
  {
    name: "get_deployed_prompt",
    description:
      "指定環境(name + label)に現在デプロイされている prompt version を解決して返す " +
      "(= GET /v1/prompts/resolve、 Free でも可)。 agent が実行時に「本番プロンプト」を引く主経路。 " +
      "返り = その version の template / variables / labels / version。 未デプロイは 404。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "label"],
      properties: {
        name: { type: "string", description: "prompt name", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" },
        label: { type: "string", description: "環境ラベル", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$" },
      },
    },
  },
  {
    name: "list_prompt_deployments",
    description:
      "現在のデプロイ状態一覧を返す(= GET /v1/prompts/deployments、 Free でも可)。 " +
      "各行 = { promptName, label, currentVersion, canRollback, deployedAt }。 " +
      "name / label で絞り込み可(両省略で全件)。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "prompt name で絞り込み(任意)", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" },
        label: { type: "string", description: "label で絞り込み(任意)", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$" },
      },
    },
  },
  {
    name: "list_safety_assessments",
    description:
      "safety classifier (= OpenAI Moderation) が 書き込んだ assessment を 一覧取得する。 " +
      "source は 'cron' (= 定期 batch) / 'mcp' (= classify_calls_batch on-demand) / 'human_override' / 'api' / 'auto' を含む。 " +
      "callId 指定 = 同 call の 全 classifier assessment、 callId 省略 = 自 account 全体で flagged 優先 + 直近 ORDER。 " +
      "OPENAI_API_KEY 未 provision の environment では cron が走らず空配列 (= classify_calls_batch も 503)。 " +
      "前提: safety classification は既定では無効 (= サービス側で段階的に有効化する切替) で、 自 account で有効化されるまで assessment は生成されない。 " +
      "空配列は「故障」ではなく「未有効化 / flagged 該当なし」を意味する。 " +
      "AI agent は 「最近 flagged な call の review」 や 「特定 call の policy 違反候補確認」 path で使う。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        callId: {
          type: "string",
          description: "対象 call id (= llm_calls.id、 [A-Za-z0-9_-]{1,128})。 省略で account 全体。",
          pattern: "^[A-Za-z0-9_-]{1,128}$",
        },
        limit: {
          type: "integer",
          description: "返却件数 (1-200、 デフォルト 50)",
          minimum: 1,
          maximum: 200,
          default: 50,
        },
      },
    },
  },
  {
    name: "get_safety_assessment",
    description:
      "指定 assessment id の 1 件 detail を 取得する。 id は list_safety_assessments の assessments[].id を そのまま使う。 " +
      "labels (= flagged category 配列) + score (= max category score 0-1) + reasoning + classifier_id + source を含む。 " +
      "argosvix://safety-assessments/{id} resource template と 同 endpoint。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["assessmentId"],
      properties: {
        assessmentId: {
          type: "integer",
          description: "対象 assessment の id (= AUTOINCREMENT 数値)",
          minimum: 1,
        },
      },
    },
  },
  {
    name: "list_eval_runs",
    description:
      "eval baseline runner の run 履歴を 一覧取得する。 自 account 限定、 直近 ORDER。 " +
      "summary.scoredCount / failedCount / meanScoreByCriterion を含むので、 AI agent は 「直近の eval 結果サマリ」 や 「criterion 別の score 推移」 を 1 件で把握できる。 " +
      "Free user でも 過去 run が あれば 読み取り可能。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: {
          type: "integer",
          description: "返却件数 (1-50、 デフォルト 20)",
          minimum: 1,
          maximum: 50,
          default: 20,
        },
      },
    },
  },
  {
    name: "get_eval_run",
    description:
      "指定 eval run の detail + 各 (criterion × call) score 一覧 を 取得する。 id は list_eval_runs の runs[].id を そのまま使う。 " +
      "scores 配列に score (= criterion scale 内 integer) + reasoning (= judge の理由説明) を含む。 " +
      "argosvix://eval-runs/{id} resource template と 同 endpoint。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId"],
      properties: {
        runId: {
          type: "integer",
          description: "対象 eval run の id (= AUTOINCREMENT 数値)",
          minimum: 1,
        },
      },
    },
  },
  {
    name: "get_percentiles",
    description:
      "calls の percentile metrics を 取得 (= POST /v1/query/percentiles)。 metric = 'latency' (= レイテンシ ms) or 'cost' (= USD)、 全期間 1 数値 or groupBy='day'/'hour'/'minute' で 時系列 series。 " +
      "「先週の p95 latency 推移を 日次で」 のような依頼に 1 call で答えられる。 percentile は nearest-rank 法で計算。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        startTime: {
          type: "string",
          description: "範囲開始 ISO timestamp (= UTC、 省略 = 全期間)",
        },
        endTime: {
          type: "string",
          description: "範囲終了 ISO timestamp",
        },
        provider: { type: "string", description: "provider filter" },
        model: { type: "string", description: "model filter" },
        metric: {
          type: "string",
          description: "metric 種別、 default = 'latency'",
          enum: ["latency", "cost"],
          default: "latency",
        },
        groupBy: {
          type: "string",
          description:
            "時系列 分割 軸 (省略 = 全期間 1 数値、 'day' = 日次、 'hour' = 時間別、 'minute' = 分別)",
          enum: ["day", "hour", "minute"],
        },
      },
    },
  },
  {
    name: "list_projects",
    description:
      "自 account の active projects を 一覧取得 (= GET /v1/projects、 archived 除外)。 " +
      "dev / staging / prod のような 環境別の観測に使う。 Pro 5 件 / Team unlimited、 Free は default のみ。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "list_members",
    description:
      "Team account のメンバー一覧を取得 (= GET /v1/memberships、 removed 除外)。 " +
      "各メンバーの email / role (admin/member/viewer) / status / 参加日時を返す read-only tool。 " +
      "招待・ロール変更・削除の mutation は権限操作のため MCP では非提供 (= dashboard か将来の承認ゲート経由)。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "create_project",
    description:
      "新規 project を 作成 (= POST /v1/projects)。 name = 表示名、 slug = URL-safe 短い識別子 (= /^[a-z][a-z0-9-]{0,31}$/)。 " +
      "Pro 5 件上限、 Team unlimited、 Free は 不可 (= 403)。 mutation = session 認証時 Origin/Referer 強制 (= dashboard 経由前提)。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "slug"],
      properties: {
        name: {
          type: "string",
          description: "project 表示名 (1-64 文字)",
          minLength: 1,
          maxLength: 64,
        },
        slug: {
          type: "string",
          description:
            "URL-safe 短い識別子 (= /^[a-z][a-z0-9-]{0,31}$/、 32 字以内、 先頭小文字、 hyphens 可)",
          pattern: "^[a-z][a-z0-9-]{0,31}$",
        },
      },
    },
  },
  {
    name: "rename_project",
    description:
      "既存 project の name / slug を 更新 (= PATCH /v1/projects/:id)。 name と slug は どちらか一方 / 両方指定可。 slug は URL-safe 制約 (= /^[a-z][a-z0-9-]{0,31}$/)。 default project の rename は 許可。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["projectId"],
      properties: {
        projectId: {
          type: "string",
          description: "対象 project の id (= list_projects で 取得した UUID)",
          minLength: 1,
          maxLength: 64,
        },
        name: {
          type: "string",
          description: "新しい表示名 (省略時 不変)",
          minLength: 1,
          maxLength: 64,
        },
        slug: {
          type: "string",
          description: "新しい slug (省略時 不変、 /^[a-z][a-z0-9-]{0,31}$/)",
          pattern: "^[a-z][a-z0-9-]{0,31}$",
        },
      },
    },
  },
  {
    name: "delete_project",
    description:
      "project を soft delete (= DELETE /v1/projects/:id、 archived_at 設定で 論理削除)。 default project は 削除不可 (= accounts.default_project_id 参照 整合 のため 400)。 " +
      "archived 後 calls / alerts は そのまま (= 過去観測は keep)、 新規 record は 別 project に 振り分ける 運用。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["projectId"],
      properties: {
        projectId: {
          type: "string",
          description: "削除対象 project の id (= list_projects 経由)",
          minLength: 1,
          maxLength: 64,
        },
      },
    },
  },
  {
    name: "classify_calls_batch",
    description:
      "未 classified な calls を on-demand で 一括 safety classify (= OpenAI Moderation 経由、 POST /v1/safety-assessments/scan-batch)。 cron (= 15 分間隔 50 件) を 「今すぐ」 補完する path で、 AI agent が 「先週分の全 call を まとめて 分類して」 を 1 prompt で完結できる。 " +
      "Pro+ plan 限定 (= Free は cron に任せる)、 backend で plan gate + budget gate を enforce。 maxRecords (= 1-100、 default 50)、 返却 = { scanned, assessed, flagged, failures, skipped }。 source='mcp' で 記録 (= cron 由来と 区別、 dashboard で 「on-demand 分類」 を 視覚化できる)。 " +
      "監査 = safety.scan_batch_run event を audit_log に emit。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxRecords: {
          type: "integer",
          description: "1 リクエストあたりの 最大 scan 件数 (= 1-100、 default 50)。 OpenAI 1000 RPM 制限 + 1 worker request の CPU/IO 上限 10s 考慮の cap",
          minimum: 1,
          maximum: 100,
          default: 50,
        },
      },
    },
  },
  {
    name: "propose_eval_criteria",
    description:
      "useCaseHint (= 「カスタマーサポート bot」 等 1 行) と 任意の sampleCallIds (= 自 account の 代表 call、 最大 5 件) を 元に、 LLM-judge (= gpt-4o-mini) が eval criterion 候補を 提案 (= POST /v1/eval-criteria/propose)。 AI agent が 「うちの prompt の品質を測る criterion を提案して」 を 1 prompt で完結できる。 " +
      "Pro+ plan 限定 (= backend で plan gate + budget gate を enforce)、 INSERT しない (= 「propose」 のみ、 user 採用判断は create_eval_criterion で別 step、 LLM hallucination 影響は構造的に限定)。 sampleCallIds の decrypt 失敗は partialFailures に 報告 (= sample なしでも LLM call は走る)。 " +
      "【prompt sample のプライバシー軸】 sampleCallIds 指定時は backend で 該当 call の prompt/response 復号 → OpenAI gpt-4o-mini に excerpt (各 1500 char cap) を 送信する。 元の call が OpenAI 宛てなら同 vendor への再送信だが、 Gemini / Mistral など他 provider の call を sample に指定した場合は その内容が OpenAI に 新規に渡る点に 注意。 sample 軸の心配がある場合は sampleCallIds なしで useCaseHint のみで 走らせる選択肢。 " +
      "【結果は advisory】 返却 criteria は LLM の 提案 で、 構造的に valid でも 意味的に 弱い rubric (= 「helpful」 過剰多用 / 重複)が混ざる可能性。 採用前に user 確認推奨、 create_eval_criterion に blind 投入は NG。 " +
      "返却 = { criteria: [{ name (snake_case 32 chars), rubric (1-200), scaleMin (=1), scaleMax (5 or 10), reasoning (1-200) }], partialFailures: string[], budgetSpentUsd, proposedRawCount (= LLM が返した raw 件数), droppedCount (= validator で 削除した件数) } 形式。 監査 = eval.propose_criteria event を audit_log に emit。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["useCaseHint"],
      properties: {
        useCaseHint: {
          type: "string",
          description: "想定 use case の 1-2 行 説明 (= 「カスタマーサポート bot for e-commerce returns + refunds」 等、 1-500 chars 必須)",
          minLength: 1,
          maxLength: 500,
        },
        sampleCallIds: {
          type: "array",
          description: "context として 渡す 自 account の call_id 配列 (= 任意、 最大 5 件、 [A-Za-z0-9_-]{1,128})。 LLM の提案を 自分の data に grounding する",
          items: {
            type: "string",
            pattern: "^[A-Za-z0-9_-]{1,128}$",
          },
          maxItems: 5,
        },
        maxCriteria: {
          type: "integer",
          description: "返却する criterion の最大数 (= 1-10、 default 5)",
          minimum: 1,
          maximum: 10,
          default: 5,
        },
      },
    },
  },
  {
    name: "purge_expired_plaintext",
    description:
      "自 account の 平文 record のうち olderThanDays 経過したものを 一括 purge (= POST /v1/tier2/plaintext/purge-expired)。 利用規約 v2.1 の 「90 日 まで 保管可能」 と整合する 自動 retention で、 AI agent が 「30 日 経過の 平文 data を 自動 purge」 を 1 prompt で完結できる。 " +
      "dryRun=true (= 迷ったら選ぶ safe 側) で count + sample 5 件の call_id を 返す、 dryRun=false で 実 UPDATE。 emit → UPDATE 順序 + deterministic idempotencyId (= sha1(endpoint+accountId+olderThanDays+cutoff_date)) で webhook retry 同等の semantics。 **Pro+ プラン限定 (= Free は 403)。 実 purge (dryRun=false) は approvalId 必須** = request_approval (action: 'purge_expired_plaintext') で人間承認を取ってから実行する (= 平文 NULL 化は不可逆のため)。 自 account のみ purge。 " +
      "返却 dryRun=true = { dryRun: true, targetCount, cutoffTimestamp, olderThanDays, sampleTargetCallIds }、 dryRun=false = { dryRun: false, purgedCount, cutoffTimestamp, olderThanDays, purgedAt }。 audit = tier2.purge_expired_plaintext を emit。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        olderThanDays: {
          type: "integer",
          description: "purge 対象の経過日数 (= 1-365、 default 30、 利用規約 v2.1 と整合)",
          minimum: 1,
          maximum: 365,
          default: 30,
        },
        dryRun: {
          type: "boolean",
          description: "true = preview のみ (= mutation ゼロ)、 false = 実 UPDATE。 default false (= MCP 規律で 明示 dryRun 推奨)",
          default: false,
        },
        approvalId: {
          type: "string",
          description:
            "request_approval で 承認された approval id (= apr_ + 32 hex、 action は 'purge_expired_plaintext' で作成)。 指定すると server-side で approved + 期限内 + action 一致 + 未消費 を検証し、 実 purge 時に atomic 消費 (= 1 approval = 1 実行)。 dryRun は検証のみで消費しない",
          pattern: "^apr_[a-f0-9]{32}$",
        },
      },
    },
  },
  {
    name: "retry_failed_webhook",
    description:
      "失敗した Stripe webhook event (= billing_dead_letter テーブル) を 再処理 marker として audit log に記録する (= POST /v1/tier2/webhook-events/retry)。 「先週 Stripe webhook が 一時失敗してた件を 全部 retry して」 を 1 prompt で完結できる。 " +
      "eventIds (= 特定 event 単体、 最大 100 件) または fromTimestamp/toTimestamp (= range、 7 日 cap) で 対象 select。 dryRun=true で list preview、 dryRun=false で 各 event を audit log に 「marked_for_manual_redispatch」 として 残す (= 実 retry は Argosvix 運営が手動で実施、 完全自動 re-dispatch は今後の対応予定)。 " +
      "emit は deterministic idempotencyId (= sha1(endpoint+accountId+eventId)) を使い、 同 args の 二重実行は silent skip。 **内部運用ツール (= 決済 webhook 復旧用、 customer account は 403)**。 billing_dead_letter は account 横断の内部 table で、 実 re-dispatch も手動運用前提のため一般開放の予定はない。 " +
      "返却 dryRun=true = { dryRun: true, targetCount, events: [{eventId, eventType, reason, receivedAt}] }、 dryRun=false = { dryRun: false, targetCount, succeeded: string[], failed: [{eventId, reason}], skipped: string[], narrative, retriedAt }。 audit = tier2.retry_failed_webhook を 各 event 毎に emit。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        eventIds: {
          type: "array",
          description: "retry 対象の Stripe event id 配列 (= evt_xxx 形式、 最大 100 件)。 fromTimestamp と同時指定可能",
          items: { type: "string", minLength: 1, maxLength: 256 },
          maxItems: 100,
        },
        fromTimestamp: {
          type: "string",
          description: "range 軸 開始時刻 (= ISO-8601、 7 日 以上前は 400)",
          format: "date-time",
        },
        toTimestamp: {
          type: "string",
          description: "range 軸 終了時刻 (= ISO-8601、 任意)",
          format: "date-time",
        },
        maxRetries: {
          type: "integer",
          description: "1 request あたりの 上限 (= 1-100、 default 10)",
          minimum: 1,
          maximum: 100,
          default: 10,
        },
        dryRun: {
          type: "boolean",
          description: "true = preview のみ、 false = 実 marker emit。 default false",
          default: false,
        },
        approvalId: {
          type: "string",
          description:
            "request_approval で 承認された approval id (= apr_ + 32 hex、 action は 'retry_failed_webhook' で作成)。 server-side 検証 + 実実行時に atomic 消費 (= 1 approval = 1 実行)。 dryRun は検証のみ",
          pattern: "^apr_[a-f0-9]{32}$",
        },
      },
    },
  },
  {
    name: "auto_silence_noisy_alert",
    description:
      "過去 1 時間 で 一定回数以上 firing している noisy alert を 一括 silence (= POST /v1/tier2/alerts/auto-silence)。 「同じ alert が 1 時間 で 50 回 鳴ってる、 1 時間 silence して」 を 1 prompt で完結できる。 " +
      "alertId (= 単体 silence) または byVolumeThreshold (= 1 時間 N+ 回 firing の alerts 全部) の どちらか一方 を 指定。 silenceDurationMinutes は 5-1440 (= 5 分〜24 時間)、 default 60 分。 reason も 付随可能。 " +
      "dryRun=true で 対象 list + fireCount preview、 dryRun=false で UPDATE alerts.silenced_until + audit emit per alert (= tier2.auto_silence_noisy_alert event)。 reversible な mutation (= 既存 unsilence_alert で 解除可能) + per-account 完全 scoping (= 他 account の alert は 影響なし) のため 特別な権限は不要、 Pro+ user が 直接呼び出せる。 " +
      "返却 dryRun=true = { dryRun: true, targetCount, silenceUntil, silenceDurationMinutes, lookbackStart, targets: [{alertId, name, fireCount}] }、 dryRun=false = { dryRun: false, targetCount, silenceUntil, silenceDurationMinutes, succeeded: string[], failed: [{alertId, reason}], skipped: string[], reason }。 idempotencyId = sha1(endpoint+accountId+alertId+silenceUntil の 分単位) で 同 minute 内の 二重実行を coalesce。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        alertId: {
          type: "string",
          description: "単体 silence の alert id (= alrt_xxx 形式)。 byVolumeThreshold と 同時指定不可",
          minLength: 1,
          maxLength: 64,
        },
        byVolumeThreshold: {
          type: "integer",
          description: "過去 1 時間 の firing 回数が N+ の alerts 全部を batch silence。 alertId と 同時指定不可",
          minimum: 1,
          maximum: 1000,
        },
        silenceDurationMinutes: {
          type: "integer",
          description: "silence 期間 (= 分単位、 5-1440 = 5 分〜24 時間)、 default 60 分",
          minimum: 5,
          maximum: 1440,
          default: 60,
        },
        reason: {
          type: "string",
          description: "silence 理由 (= audit log に記録、 200 char 上限)",
          maxLength: 200,
        },
        dryRun: {
          type: "boolean",
          description: "true = preview のみ (= mutation ゼロ)、 false = 実 silence。 default false",
          default: false,
        },
        approvalId: {
          type: "string",
          description:
            "request_approval で 承認された approval id (= apr_ + 32 hex、 action は 'auto_silence_noisy_alert' で作成)。 server-side 検証 + 実 silence 時に atomic 消費 (= 1 approval = 1 実行)。 dryRun は検証のみ",
          pattern: "^apr_[a-f0-9]{32}$",
        },
      },
    },
  },
  {
    name: "extend_customer_trial",
    description:
      "自 account の Stripe subscription trial 期間を 1-30 日 延長 (= POST /v1/tier2/trial/extend)。 **内部運用ツール (= サポート用、 customer account は 403)**。 trial 延長は収益に直結するため一般開放の予定はない。 累計 60 日 上限 (= 過去 30 日 audit 集計)、 status='trialing' でなければ 409。 " +
      "dryRun は 必須明示 (= 暗黙 false で mutation する事故 防御)、 dryRun=false 時 は idempotencyKey も 必須 (16-128 alphanumeric+'_-')。 同 key 再呼び出しは tier2_idempotency table 経由で cached result 返却 (= retry double-extend を 構造防御)。 " +
      "dryRun=true で previousTrialEnd / newTrialEnd / 累計の preview のみ (= Stripe call なし)。 dryRun=false で 実 Stripe mutation + accounts_subscription 同期 update。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["targetAccountId", "extendDays", "reason", "dryRun"],
      properties: {
        targetAccountId: {
          type: "string",
          description: "対象 account id (= 当面 自 account のみ、 別 user 指定は 403)",
          minLength: 1,
          maxLength: 64,
        },
        extendDays: {
          type: "integer",
          description: "延長 日数 (= 1-30、 累計 60 日 上限)",
          minimum: 1,
          maximum: 30,
        },
        reason: {
          type: "string",
          description: "延長 理由 (= audit log に記録、 必須、 200 char 上限)",
          minLength: 1,
          maxLength: 200,
        },
        dryRun: {
          type: "boolean",
          description: "必須明示。 true = preview のみ、 false = 実 trial 延長 + Stripe mutation",
        },
        idempotencyKey: {
          type: "string",
          description: "dryRun=false 時 必須。 16-128 char alphanumeric+'_-'、 同 key 再呼び出しは cached result 返却",
          minLength: 16,
          maxLength: 128,
          pattern: "^[A-Za-z0-9_-]+$",
        },
        approvalId: {
          type: "string",
          description:
            "request_approval で 承認された approval id (= apr_ + 32 hex、 action は 'extend_customer_trial' で作成)。 server-side 検証 + fresh 実行時に atomic 消費 (= 1 approval = 1 実行チェーン、 同 idempotencyKey の retry では再消費しない)。 dryRun は検証のみ",
          pattern: "^apr_[a-f0-9]{32}$",
        },
      },
    },
  },
  {
    name: "apply_promo_code_to_customer",
    description:
      "自 account の Stripe subscription に user-facing promotion code (= 既 Stripe で 登録済の 「LAUNCH50」 等) を 適用 (= POST /v1/tier2/promo/apply)。 **内部運用ツール (= サポート用、 customer account は 403)**。 経済影響のある操作の規約整備とセットでないと開放しない方針 (= 解放未定)。 既 active discount があれば 409 (= 重ね掛け 構造防御)、 status が canceled / incomplete_expired は 409。 " +
      "promotion_code 経由で Stripe redeem 判定を委ねる構造 (= coupon 直接適用は 制約 bypass で禁止)、 dryRun 必須明示 + dryRun=false 時 idempotencyKey 必須。 同 key 再呼び出しは tier2_idempotency table 経由で cached result 返却、 concurrent apply を 構造直列化。 " +
      "dryRun=true で resolve + 既 active 判定 + 推定割引の preview のみ (= Stripe mutation なし)。 dryRun=false で 実 promotion_code 適用。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["targetAccountId", "promoCode", "reason", "dryRun"],
      properties: {
        targetAccountId: {
          type: "string",
          description: "対象 account id (= 当面 自 account のみ、 別 user 指定は 403)",
          minLength: 1,
          maxLength: 64,
        },
        promoCode: {
          type: "string",
          description: "Stripe で 既 登録済の promotion code (= 「LAUNCH50」 等、 alphanumeric + '_-'、 64 char 上限)",
          minLength: 1,
          maxLength: 64,
          pattern: "^[A-Za-z0-9_-]+$",
        },
        reason: {
          type: "string",
          description: "適用 理由 (= audit log に記録、 必須、 200 char 上限)",
          minLength: 1,
          maxLength: 200,
        },
        dryRun: {
          type: "boolean",
          description: "必須明示。 true = preview のみ、 false = 実 promotion_code 適用 + Stripe mutation",
        },
        idempotencyKey: {
          type: "string",
          description: "dryRun=false 時 必須。 16-128 char alphanumeric+'_-'、 同 key 再呼び出しは cached result 返却",
          minLength: 16,
          maxLength: 128,
          pattern: "^[A-Za-z0-9_-]+$",
        },
        approvalId: {
          type: "string",
          description:
            "request_approval で 承認された approval id (= apr_ + 32 hex、 action は 'apply_promo_code_to_customer' で作成)。 server-side 検証 + fresh 実行時に atomic 消費 (= 1 approval = 1 実行チェーン、 同 idempotencyKey の retry では再消費しない)。 dryRun は検証のみ",
          pattern: "^apr_[a-f0-9]{32}$",
        },
      },
    },
  },
  {
    name: "detect_anomaly",
    description:
      "現 window と baseline window (= 同 length の 1 期前) を 比較して cost / latency / error_rate / call_volume の 4 軸で 異常を検出 (= AI が 1 prompt で 「何か変なことが起きてないか」 を把握できる)。 " +
      "threshold で 感度 調整可能: sensitive (= 1.5×) / normal (= 2×、 default) / conservative (= 3×)。 detection 数 0-4 件、 各 anomaly は 説明文 (narrative) 付き。 " +
      "返却 = { window, threshold, multiplier (= threshold の倍率数値), current: {...}, baseline: {...}, anomalies: [{ axis, severity: 'minor'|'major'|'critical', current, baseline, ratio, narrative }], partialFailures?: string[] (= 'current:xxx' / 'baseline:xxx' 形式で 取得に失敗した軸、 全成功時は省略) } 形式。 errorRate は percent (0-100) で 評価 + 表示 (= backend aggregate と同 単位)。 baseline data 不足 (= 期間 record < 10) は anomalies: [] + warning message を返す (= この経路は multiplier を含まず、 partialFailures は同様に optional)。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        window: {
          type: "string",
          description: "観測 window (= '1h' / '24h' / '7d'、 default '24h')",
          enum: ["1h", "24h", "7d"],
          default: "24h",
        },
        threshold: {
          type: "string",
          description: "感度 (= 'sensitive' 1.5× / 'normal' 2× / 'conservative' 3×、 default 'normal')",
          enum: ["sensitive", "normal", "conservative"],
          default: "normal",
        },
      },
    },
  },
  {
    name: "propose_alert_rules",
    description:
      "過去 lookbackDays (= 7-30、 default 14) の calls pattern を 分析して、 cost / latency / error_rate / anomaly の 推奨 alert rule を JSON で提案する。 " +
      "適用は customer 確認後 create_alert で別 step (= propose のみ、 副作用ゼロ)。 既存 alerts と同 type の rule は原則提案しない (= list_alerts で 既存 type を fetch。 ただし list_alerts の取得に失敗した場合は 既存集合を空として扱うため、 既存 alert と重複する提案が返り得る。 失敗軸は partialFailures で報告)。 " +
      "返却 = { lookbackDays, baseline: {meanDailyCost (= USD), p95Latency (= ms), errorRate (= percent 0-100), dailyCalls, totalCalls}, proposals: [{ name, alertType, thresholdValue, windowMinutes, reasoning }], skipped: [{ alertType, reason }], partialFailures?: string[] (= 取得に失敗した軸、 全成功時は省略) } 形式。 error_rate proposal の thresholdValue も percent (= backend create_alert と整合)。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        lookbackDays: {
          type: "integer",
          description: "baseline 算出の lookback 日数 (= 7-30、 default 14)",
          minimum: 7,
          maximum: 30,
          default: 14,
        },
      },
    },
  },
  {
    name: "get_account_health",
    description:
      "自社 LLM infra の健康状態 サマリを 1 call で取得する。 既存 4 endpoint (= aggregate_calls / get_percentiles / get_llm_budget / list_audit_log) を 並列 fetch して 1 response に圧縮。 " +
      "返却 = { window, totals: {calls, costUsd, errorRate (= percent 0-100)}, latency: {p50, p95, p99 (= ms)}, budget: {used, limit, percentUsed (= 0-100)}, recentEvents: 件数, summary: 'ok' | 'warn' | 'critical', partialFailures?: string[] (= 取得に失敗した軸、 全成功時は省略) } 形式。 critical = errorRate≥10% / budget≥90% / p95≥10s、 warn = ≥3% / ≥70% / ≥3s。 " +
      "「今うちの LLM infra どう？」 を 1 prompt で答えられる。 純 read aggregator で、 個別 endpoint 失敗は partial で 返す (= 1 軸の timeout が summary を 止めず、 失敗軸は partialFailures に載る)。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        window: {
          type: "string",
          description: "観測窓 (= '1h' / '24h' / '7d'、 default '24h')",
          enum: ["1h", "24h", "7d"],
          default: "24h",
        },
      },
    },
  },
  {
    name: "aggregate_calls",
    description:
      "calls の 集計 cube を 取得 (= POST /v1/query/aggregate)。 groupBy (= provider / model / day / hour / minute / tag / error) × metric (= cost / latency / tokens / input_tokens / output_tokens / cached_tokens / cache_savings / count / error_rate) で、 AI agent が 「今月の cost を model 別 に集計」 を 1 call で完結できる。 " +
      "tag mode は tagKey 必須 (= alphanumeric + _ - のみ、 例: 'env' / 'feature')。 error mode は エラー行のみを error 文字列で種類別集計 (= どのエラーが何件か。 metric=count 推奨)。 hour mode は 168h / minute mode は 60min まで (= 超過 400)。 cost = SUM(cost_usd) / latency = AVG(latency_ms) / tokens = SUM(total_tokens) / input_tokens = SUM(prompt_tokens) / output_tokens = SUM(completion_tokens) / cached_tokens = SUM(cached_read_tokens) / cache_savings = SUM(cache_savings_usd) / count = COUNT(*) / error_rate = error ÷ total。 " +
      "返却 = { groups: [{key, value, count}], total: {value, count} } 形式。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        startTime: {
          type: "string",
          description: "範囲開始 ISO timestamp (= UTC、 省略 = 全期間)",
        },
        endTime: {
          type: "string",
          description: "範囲終了 ISO timestamp (= UTC、 省略 = 現在)",
        },
        groupBy: {
          type: "string",
          description: "集約軸 (= 'provider' / 'model' / 'day' / 'hour' / 'minute' / 'tag' / 'error')、 default = 'provider'。 hour は 168h / minute は 60min まで。 error はエラー行のみを種類別に集計",
          enum: ["provider", "model", "day", "hour", "minute", "tag", "error"],
          default: "provider",
        },
        metric: {
          type: "string",
          description: "metric 種別 (= 'cost' / 'latency' / 'tokens' / 'input_tokens' / 'output_tokens' / 'cached_tokens' / 'cache_savings' / 'reasoning_tokens' / 'audio_tokens' / 'ttft' / 'count' / 'error_rate')、 default = 'cost'。 cached_tokens = SUM(cached_read_tokens)、 cache_savings = SUM(cache_savings_usd)(プロンプトキャッシュの節約額)、 reasoning_tokens = SUM(推論トークン)、 audio_tokens = SUM(音声トークン)、 ttft = AVG(初回トークンまでの ms)",
          enum: ["cost", "latency", "tokens", "input_tokens", "output_tokens", "cached_tokens", "cache_savings", "reasoning_tokens", "audio_tokens", "ttft", "count", "error_rate"],
          default: "cost",
        },
        provider: {
          type: "string",
          description: "provider filter (= 'openai' / 'anthropic' 等)、 省略 = 全 provider",
        },
        tagKey: {
          type: "string",
          description:
            "groupBy='tag' の時必須。 tags JSON 内 key 名 (alphanumeric + _- のみ、 1-64 文字)",
          pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
        },
      },
    },
  },
  {
    name: "list_audit_log",
    description:
      "audit log を 一覧 取得 (= GET /v1/audit-log)。 自 account 限定、 admin role のみ許可 (= viewer/member は 403)。 " +
      "AI agent が 「最近の招待 / API key revoke / プロジェクト変更」 等の 操作履歴 を 自律参照できる。 " +
      "filter = eventType (= 'invitation.created' / 'api_key.revoked' 等) / targetKind / actorUserId / from / to。 " +
      "cursor pagination 対応 (= nextCursor 形式 = 'created_at|id')、 max limit 200。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: {
          type: "integer",
          description: "返却件数 (1-200、 デフォルト 50)",
          minimum: 1,
          maximum: 200,
          default: 50,
        },
        eventType: {
          type: "string",
          description:
            "event_type 完全一致 filter (= 'invitation.created' / 'api_key.revoked' / 'membership.removed' 等)",
        },
        targetKind: {
          type: "string",
          description: "target_kind filter (= 'invitation' / 'api_key' / 'membership' 等)",
        },
        actorUserId: {
          type: "string",
          description: "actor_user_id filter (= 特定 user の操作のみ抽出)",
        },
        from: {
          type: "string",
          description: "範囲開始 ISO timestamp (= UTC)",
        },
        to: {
          type: "string",
          description: "範囲終了 ISO timestamp (= UTC)",
        },
        cursor: {
          type: "string",
          description: "ページ送り cursor (= 前 response の nextCursor を そのまま渡す、 'created_at|id' 形式)",
        },
      },
    },
  },
  {
    name: "list_saved_views",
    description:
      "保存済 saved views 一覧を 取得 (= GET /v1/saved-views)。 saved view = /calls page で よく使う filter (startDate/endDate/provider/model/limit) の組み合わせを 名前付きで 保存したもの。 " +
      "AI agent は 「いつもの先週の OpenAI filter で 呼び出し見せて」 のような依頼に応えられる。 account 単位、 max 20 件。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "create_saved_view",
    description:
      "新規 saved view を 作成 / 同名なら上書き (= POST /v1/saved-views)。 name は account 内一意。 filter は SavedViewFilter shape (= startDate / endDate / provider / model / limit / preset / sortBy? / sortOrder?)。 " +
      "AI agent が よく使う filter を 名前付きで保存できる。 例: 「直近 7 日 GPT-4 のみ」 view を 作って 後で呼ぶ。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "filter"],
      properties: {
        name: {
          type: "string",
          description: "saved view の名前 (1-80 文字、 改行不可)。 同名で 既存なら 上書き",
          minLength: 1,
          maxLength: 80,
        },
        filter: {
          type: "object",
          description:
            "filter shape = startDate (ISO) + endDate (ISO) + provider (空可) + model (空可) + limit (number) + preset (string|null) + sortBy? + sortOrder?",
          required: ["startDate", "endDate", "provider", "model", "limit", "preset"],
          properties: {
            startDate: { type: "string", description: "ISO timestamp (= 範囲開始)" },
            endDate: { type: "string", description: "ISO timestamp (= 範囲終了)" },
            provider: {
              type: "string",
              description: "プロバイダー (= 'openai' / 'anthropic' / 'gemini' / 'mistral')、 空 = 全 provider",
            },
            model: {
              type: "string",
              description: "モデル名、 空 = 全 model",
            },
            limit: {
              type: "integer",
              description: "返却件数 cap",
              minimum: 1,
            },
            preset: {
              type: ["string", "null"],
              description: "preset 識別子 (= dashboard 既定 filter、 null 可)",
            },
            sortBy: { type: "string", description: "ソート対象 column" },
            sortOrder: {
              type: "string",
              description: "ソート方向 ('asc' / 'desc')",
              enum: ["asc", "desc"],
            },
          },
        },
      },
    },
  },
  {
    name: "delete_saved_view",
    description:
      "指定 id の saved view を 削除 (= DELETE /v1/saved-views/:id)。 自 account 限定。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: {
          type: "string",
          description: "削除対象の saved view id (= UUID)",
          minLength: 1,
          maxLength: 64,
        },
      },
    },
  },
  {
    name: "export_calls",
    description:
      "calls の large batch export (= POST /v1/query/export)。 query_calls より 高 limit (= plan 別 max records: Free 1000 / Pro 50000)、 全 plan で利用可。 " +
      "filter 軸 = startTime / endTime / provider / model + limit。 AI agent が 「先月分の全 GPT-4 呼び出しを取り出して傾向分析して」 を 1 call で完結できる。 " +
      "結果 format は query_calls と 同 JSON (= そのまま CSV / 統計処理に流し込める)。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        startTime: {
          type: "string",
          description: "範囲 開始 ISO timestamp (= UTC、 省略 = 全期間)",
        },
        endTime: {
          type: "string",
          description: "範囲 終了 ISO timestamp (= UTC、 省略 = 現在)",
        },
        provider: {
          type: "string",
          description: "プロバイダー filter (= openai / anthropic / gemini / mistral)",
        },
        model: {
          type: "string",
          description: "model 名 filter (= 部分一致なし、 完全一致。 例: 'gpt-4o-mini')",
        },
        limit: {
          type: "integer",
          description:
            "返却件数 cap。 plan 別 max 内なら そのまま、 超過は plan max に clamp",
          minimum: 1,
        },
      },
    },
  },
  {
    name: "bulk_delete_calls",
    description:
      "指定 call id 一覧 (= max 100) を 自 account 限定で 一括削除する (= POST /v1/calls/bulk-delete)。 " +
      "開発中の テストで 蓄積した 不要な call の cleanup に使える。 " +
      "dryRun=true で 削除前に matched 件数を 事前確認可能。 削除は 1 SQL atomic、 audit log に bulk_deleted event を 記録。 " +
      "FK 制約上 関連 traces / annotations / scores は ON DELETE 経由で 連鎖削除される。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["callIds"],
      properties: {
        callIds: {
          type: "array",
          description: "削除対象の call id 配列 (1-100 件、 各 1-128 文字)",
          items: { type: "string", minLength: 1, maxLength: 128 },
          minItems: 1,
          maxItems: 100,
        },
        dryRun: {
          type: "boolean",
          description: "true で 削除せず matched 件数のみ 返却 (= 確認 UX)",
          default: false,
        },
        approvalId: {
          type: "string",
          description:
            "request_approval で 承認された approval id (= apr_ + 32 hex、 action は 'bulk_delete_calls' で作成)。 server-side 検証 + 実削除時に atomic 消費 (= 1 approval = 1 実行)。 dryRun は検証のみ",
          pattern: "^apr_[a-f0-9]{32}$",
        },
      },
    },
  },
  {
    name: "compare_eval_runs",
    description:
      "2 つの eval run (baseline / candidate) を 比較して per-criterion mean score delta + failed count delta + verdict を 返す (= GET /v1/eval-runs/compare)。 " +
      "AI agent は 「baseline と 比べて candidate は どう 変わったか」 を 1 call で 把握でき、 prompt 改善の 効果測定や regression 検出に使える。 " +
      "verdict = improved / regressed / mixed / unchanged。 failed count は score <= 2 を 「failed」 で 算出。 同 account 限定。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["baselineRunId", "candidateRunId"],
      properties: {
        baselineRunId: {
          type: "integer",
          description: "比較元 run の id (= list_eval_runs.runs[].id)",
          minimum: 1,
        },
        candidateRunId: {
          type: "integer",
          description: "比較先 run の id (= 同上)、 baseline と 異なる必要あり",
          minimum: 1,
        },
      },
    },
  },
  {
    name: "run_eval",
    description:
      "新規 eval run を 即時実行する (= POST /v1/eval-runs)。 直近 N 件の calls × 既定 5 criteria (+ 自作 custom criteria max 8) で gpt-4o-mini に採点させる。 " +
      "Pro+ 限定 (= Free は 403)、 OPENAI_API_KEY 未 provision 環境では backend で 500。 " +
      "前提: 採点は平文保管 (content-storage opt-in) が ON の call のみが対象。 opt-in OFF (= 既定) だと候補が 0 件になり、 " +
      "summary.scoredCount=0 + reason='no_plaintext_calls' を返す (= 故障ではなく gating)。 " +
      "cost: 1 run あたり 約 $0.01 (= 20 calls × 5 criteria = 100 LLM call)、 月 30 run なら $0.30 程度。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: {
          type: "string",
          description: "run の自由命名 (1-100 文字、 例: 'weekly-prod-eval-2026-06-02')",
          minLength: 1,
          maxLength: 100,
        },
        recentCount: {
          type: "integer",
          description: "対象 call 件数 (1-20、 デフォルト 10)。 直近 N 件を judge に渡す。",
          minimum: 1,
          maximum: 20,
          default: 10,
        },
        label: {
          type: "string",
          description: "label filter (= tags 内文字列の部分一致)。 省略 = 全 call。",
          pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$",
        },
        promptRegistryId: {
          type: "integer",
          description: "対象 prompt registry の id (= list_prompts.prompts[].id)。 省略 = ad-hoc run。",
          minimum: 1,
        },
        idempotencyKey: {
          type: "string",
          description: "retry dedup 用の opaque key (= UUID 推奨、 64 char cap)。 同 key で 60 分以内に再 POST すると 既存 run を そのまま返す。",
          minLength: 1,
          maxLength: 64,
        },
      },
    },
  },
  {
    name: "list_eval_datasets",
    description:
      "自 account の golden dataset 一覧 (= GET /v1/eval-datasets)。 各 dataset は name / 説明 / item 件数 / frozen 状態を持つ。 golden dataset = 期待出力つきの固定テストセットで、 run_eval_dataset で対象モデルに通して回帰 A/B を測る母集団。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "get_eval_dataset",
    description:
      "指定 dataset の detail + items 全件を取得 (= GET /v1/eval-datasets/:id)。 datasetId は list_eval_datasets.datasets[].id。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["datasetId"],
      properties: {
        datasetId: {
          type: "integer",
          description: "対象 dataset の id (= list_eval_datasets.datasets[].id)",
          minimum: 1,
        },
      },
    },
  },
  {
    name: "create_eval_dataset",
    description:
      "golden dataset を新規作成 (= POST /v1/eval-datasets、 Pro+ 限定)。 items に期待出力つきテストケースを最大 20 件渡せる。 dataset は account あたり最大 50 件。 frozen=true で母集団を凍結 (= 以後 item 改変・解凍不可、 回帰判定の比較可能性を固定)。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: {
          type: "string",
          description: "dataset 名 (1-100 文字、 account 内で一意)",
          minLength: 1,
          maxLength: 100,
        },
        description: {
          type: "string",
          description: "任意の説明 (<= 500 文字)",
          maxLength: 500,
        },
        items: {
          type: "array",
          description: "テストケース (最大 20 件)。 各 inputText を対象モデルに入力し、 expectedOutput を judge の [REFERENCE ANSWER] として採点に使う。",
          maxItems: 20,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["inputText"],
            properties: {
              inputText: {
                type: "string",
                description: "モデルへの入力 (1-4000 文字)",
                minLength: 1,
                maxLength: 4000,
              },
              expectedOutput: {
                type: "string",
                description: "期待する出力 (任意、 <= 4000 文字)。 judge に参照解として渡す。",
                maxLength: 4000,
              },
            },
          },
        },
        frozen: {
          type: "boolean",
          description: "true = 母集団凍結 (= 以後 item 改変・解凍不可)。 省略 = false。",
        },
      },
    },
  },
  {
    name: "run_eval_dataset",
    description:
      "golden dataset を対象モデルで実行して回帰判定する (= POST /v1/eval-datasets/:id/run、 Pro+ 限定)。 各 item の inputText を targetModel に通し、 出力を既定 criteria + expectedOutput で gpt-4o-mini に採点させて eval_scores に記録する。 結果は compare_eval_runs で run 間比較できる。 実行記録は本番 cost/分析/アラート集計からは除外される。 cost: item 数 × criteria 数の LLM call。 OPENAI_API_KEY 未 provision 環境では 503。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["datasetId", "targetModel"],
      properties: {
        datasetId: {
          type: "integer",
          description: "実行する dataset の id (= list_eval_datasets.datasets[].id)",
          minimum: 1,
        },
        targetModel: {
          type: "string",
          description: "回帰を測りたい対象モデル (= 価格表に載っている OpenAI モデルのみ、 例 'gpt-4o-mini')。 未知モデルは 400。",
          minLength: 1,
          maxLength: 128,
        },
        judgeModel: {
          type: "string",
          description: "採点モデル (省略 = gpt-4o-mini)。 価格表に載っている OpenAI モデルのみ。",
          maxLength: 128,
        },
        idempotencyKey: {
          type: "string",
          description: "retry dedup 用の opaque key (= UUID 推奨、 200 char cap)。 同 key の再 POST は既存 run を返す (= 二重課金防止)。",
          minLength: 1,
          maxLength: 200,
        },
      },
    },
  },
  {
    name: "delete_eval_dataset",
    description:
      "golden dataset を削除 (= DELETE /v1/eval-datasets/:id、 Pro+ 限定)。 items は連鎖削除される。 過去の eval run / score は残る。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["datasetId"],
      properties: {
        datasetId: {
          type: "integer",
          description: "削除する dataset の id",
          minimum: 1,
        },
      },
    },
  },
];

/**
 * The core profile: 11 tools narrowed to the essentials of day-to-day
 * operation. Exposing all 87 tools pressures the agent client's context and
 * makes tool selection error-prone, so the ARGOSVIX_MCP_PROFILE=core env var
 * switches to a minimal set. The default is full (backward compatible =
 * behavior unchanged). Selection criteria: reading records (query / aggregate
 * / cost / latency) + health check + anomaly detection + basic alert
 * operations + production prompt resolution.
 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "aggregate_calls",
  "create_alert",
  "detect_anomaly",
  "get_account_health",
  "get_cost_summary",
  "get_deployed_prompt",
  "get_percentiles",
  "list_alerts",
  "query_calls",
  "silence_alert",
  "unsilence_alert",
]);

export type ToolProfile = "core" | "full";

/** Interprets ARGOSVIX_MCP_PROFILE. Unknown values fall back to full with a single warning. */
export function resolveToolProfile(raw: string | undefined): ToolProfile {
  if (raw === undefined || raw === "" || raw === "full") return "full";
  if (raw === "core") return "core";
  // eslint-disable-next-line no-console
  console.error(
    `[argosvix-mcp] unknown ARGOSVIX_MCP_PROFILE "${raw}" — falling back to "full" (valid: core | full)`,
  );
  return "full";
}

export function toolsForProfile(profile: ToolProfile): Tool[] {
  return profile === "core" ? tools.filter((t) => CORE_TOOL_NAMES.has(t.name)) : tools;
}

export interface DispatchInput {
  name: string;
  args: Record<string, unknown>;
  apiKey: string;
  apiBase: string;
}

export async function dispatchTool(input: DispatchInput): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { name, args, apiKey, apiBase } = input;
  try {
    const allowed = TOOL_ARG_ALLOWLIST[name];
    if (!allowed) {
      return errorResponse(`unknown tool: ${name}`);
    }
    // Drop keys outside the allowlist (even if the LLM passes args outside
    // the schema, they never reach the URL — structural defense against
    // injecting account_id etc.).
    const safeArgs: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in args) safeArgs[key] = args[key];
    }
    switch (name) {
      case "query_calls": {
        // The backend `/v1/query/calls` is POST-only and takes ISO startTime/
        // endTime in the body. An earlier implementation hit it with GET +
        // query string, and the real backend returned 405 (affecting external
        // users on 0.2.0-alpha.1 / 0.3.0-alpha.1). rangePreset is translated
        // into an ISO range and put in the body.
        const body: Record<string, unknown> = {};
        const range = presetToTimeRange(safeArgs["rangePreset"]);
        body["startTime"] = range.startTime;
        body["endTime"] = range.endTime;
        if (typeof safeArgs["provider"] === "string") {
          body["provider"] = safeArgs["provider"];
        }
        if (typeof safeArgs["model"] === "string") {
          body["model"] = safeArgs["model"];
        }
        if (typeof safeArgs["limit"] === "number") {
          body["limit"] = safeArgs["limit"];
        }
        // Outlier drill-down: latency range (ms). Validation is shared with
        // the backend (non-negative finite numbers, min <= max; violations
        // return the backend's 400 message as-is).
        if (typeof safeArgs["latencyMin"] === "number") {
          body["latencyMin"] = safeArgs["latencyMin"];
        }
        if (typeof safeArgs["latencyMax"] === "number") {
          body["latencyMax"] = safeArgs["latencyMax"];
        }
        // Keyset pagination cursor (opens the same backend cursor that the
        // /calls "load more" uses to agents as well). One-sided cursors,
        // malformed values, or combining with anything other than descending
        // timestamp order get a 400 message from the backend.
        if (typeof safeArgs["beforeTimestamp"] === "string") {
          body["beforeTimestamp"] = safeArgs["beforeTimestamp"];
        }
        if (typeof safeArgs["beforeId"] === "string") {
          body["beforeId"] = safeArgs["beforeId"];
        }
        // Tag filter exposure (the backend /v1/query/calls already supported
        // the tagKey + tagValue pair, but the MCP side had not wired the
        // schema / allowlist and silently dropped them). Validation is shared
        // with the backend (TAG_KEY_PATTERN + 256-char cap; one-sided or
        // malformed values return the backend's 400 message as-is).
        if (typeof safeArgs["tagKey"] === "string") {
          body["tagKey"] = safeArgs["tagKey"];
        }
        if (typeof safeArgs["tagValue"] === "string") {
          body["tagValue"] = safeArgs["tagValue"];
        }
        return await callApi(apiBase, "/v1/query/calls", {}, apiKey, {
          method: "POST",
          jsonBody: body,
        });
      }
      case "get_cost_summary": {
        // Same as query_calls (POST + ISO range body). The backend groupBy
        // accepts only "provider" | "model" | "day" | "tag", so the MCP
        // schema's "none" is normalized to the backend default "provider"
        // (LLM backward compatibility; if the intent was an overall sum, the
        // per-provider breakdown provides the same overall total in
        // response.total). Values outside the schema (backend-internal enums
        // like "day", or typos) are not silently coerced to provider — they
        // are rejected early via errorResponse (never hiding an LLM input
        // typo).
        const body: Record<string, unknown> = { metric: "cost" };
        const range = presetToTimeRange(safeArgs["rangePreset"]);
        body["startTime"] = range.startTime;
        body["endTime"] = range.endTime;
        const rawGroupBy = safeArgs["groupBy"];
        let normalizedGroupBy: "provider" | "model";
        if (rawGroupBy === "model") {
          normalizedGroupBy = "model";
        } else if (
          rawGroupBy === "provider" ||
          rawGroupBy === "none" ||
          rawGroupBy === undefined
        ) {
          normalizedGroupBy = "provider";
        } else {
          return errorResponse(
            `invalid groupBy (expected: none | provider | model, got: ${String(rawGroupBy)})`,
          );
        }
        body["groupBy"] = normalizedGroupBy;
        return await callApi(apiBase, "/v1/query/aggregate", {}, apiKey, {
          method: "POST",
          jsonBody: body,
        });
      }
      case "list_alerts":
        return await callApi(apiBase, "/v1/alerts", safeArgs, apiKey);
      case "list_proposals":
        return await callApi(apiBase, "/v1/proposals", safeArgs, apiKey);
      case "get_proposal_thread": {
        const pid = validateProposalId(safeArgs["proposalId"]);
        if (!pid) return errorResponse("proposalId required (pattern: prp_<32 hex>)");
        return await callApi(
          apiBase,
          `/v1/proposals/${encodeURIComponent(pid)}/messages`,
          {},
          apiKey,
        );
      }
      case "reply_proposal": {
        const pid = validateProposalId(safeArgs["proposalId"]);
        if (!pid) return errorResponse("proposalId required (pattern: prp_<32 hex>)");
        const body = safeArgs["body"];
        if (typeof body !== "string" || !body.trim()) {
          return errorResponse("body required");
        }
        return await callApi(
          apiBase,
          `/v1/proposals/${encodeURIComponent(pid)}/messages`,
          {},
          apiKey,
          { method: "POST", jsonBody: { body } },
        );
      }
      case "silence_alert": {
        const alertId = validateAlertId(safeArgs["alertId"]);
        if (!alertId) {
          return errorResponse("alertId required (pattern: [A-Za-z0-9-]{1,64})");
        }
        const body: Record<string, unknown> = {};
        if (typeof safeArgs["until"] === "string") body["until"] = safeArgs["until"];
        return await callApi(
          apiBase,
          `/v1/alerts/${encodeURIComponent(alertId)}/silence`,
          {},
          apiKey,
          { method: "POST", jsonBody: body },
        );
      }
      case "unsilence_alert": {
        const alertId = validateAlertId(safeArgs["alertId"]);
        if (!alertId) {
          return errorResponse("alertId required (pattern: [A-Za-z0-9-]{1,64})");
        }
        return await callApi(
          apiBase,
          `/v1/alerts/${encodeURIComponent(alertId)}/silence`,
          {},
          apiKey,
          { method: "DELETE" },
        );
      }
      case "create_alert": {
        // safeArgs is already allowlisted (account_id etc. cannot slip in).
        // Value validity (alertType enum / threshold ranges / channelKinds vs
        // channelTargets consistency / plan limits) gets its final verdict
        // from the backend's validateCreate + plan gate, returning 4xx on
        // failure (double defense).
        // Some MCP clients do not auto-apply JSON Schema `default`s, so calls
        // omitting windowMinutes / sleepMinutes / enabled used to reach the
        // backend as undefined and turn into 400s. The dispatch side applies
        // the defaults explicitly.
        const body: Record<string, unknown> = { ...safeArgs };
        if (body["windowMinutes"] === undefined) body["windowMinutes"] = 60;
        if (body["sleepMinutes"] === undefined) body["sleepMinutes"] = 60;
        if (body["enabled"] === undefined) body["enabled"] = true;
        return await callApi(apiBase, "/v1/alerts", {}, apiKey, {
          method: "POST",
          jsonBody: body,
        });
      }
      case "update_alert": {
        // Partial update of an existing alert via PATCH /v1/alerts/:id.
        // alertId is substituted into the path just before the request; the
        // body is the remaining allowlisted fields (name /
        // thresholdValue / windowMinutes / filterProvider / filterModel /
        // channelKinds / channelTargets / sleepMinutes / enabled / conditions).
        // alertType is not in the schema at all (immutable). The backend's
        // validateUpdate provides the final validation as double defense.
        const alertId = validateAlertId(safeArgs["alertId"]);
        if (!alertId) {
          return errorResponse("alertId required (pattern: [A-Za-z0-9-]{1,64})");
        }
        const { alertId: _ignore, ...body } = safeArgs;
        return await callApi(
          apiBase,
          `/v1/alerts/${encodeURIComponent(alertId)}`,
          {},
          apiKey,
          { method: "PATCH", jsonBody: body },
        );
      }
      case "delete_alert": {
        // DELETE /v1/alerts/:id. Related alert_events are CASCADE-deleted on
        // the backend. No body; only alertId is substituted into the path
        // just before the request.
        const alertId = validateAlertId(safeArgs["alertId"]);
        if (!alertId) {
          return errorResponse("alertId required (pattern: [A-Za-z0-9-]{1,64})");
        }
        return await callApi(
          apiBase,
          `/v1/alerts/${encodeURIComponent(alertId)}`,
          {},
          apiKey,
          { method: "DELETE" },
        );
      }
      case "get_alert": {
        const alertId = validateAlertId(safeArgs["alertId"]);
        if (!alertId) {
          return errorResponse("alertId required (pattern: [A-Za-z0-9-]{1,64})");
        }
        return await callApi(
          apiBase,
          `/v1/alerts/${encodeURIComponent(alertId)}`,
          {},
          apiKey,
        );
      }
      case "list_alert_events": {
        // limit / alertId / cursor go to /v1/alerts/events as query params.
        // alertId is re-validated on the backend with [A-Za-z0-9_-]+, but the
        // schema pattern already rejects it up front. The contract that both
        // cursors must be supplied together is enforced by the backend with a
        // 400 (same pattern as query_calls).
        const beforeTs = safeArgs["beforeTriggeredAt"];
        if (beforeTs !== undefined && (typeof beforeTs !== "string" || Number.isNaN(Date.parse(beforeTs)))) {
          return errorResponse("beforeTriggeredAt must be ISO-8601 string");
        }
        return await callApi(apiBase, "/v1/alerts/events", safeArgs, apiKey);
      }
      case "acknowledge_alert": {
        // Ack an individual event. eventId is substituted into the path just
        // before the request (POST /v1/alerts/events/:eventId/acknowledge).
        // The body's source cannot be overridden by the LLM — the MCP server
        // forces it to "mcp" (uniquely identifying the origin in the audit
        // trail, structurally defending the path where an attacker spoofs the
        // source to forge dashboard logs).
        const eventId = validateEventId(safeArgs["eventId"]);
        if (!eventId) {
          return errorResponse(
            "eventId required (pattern: [A-Za-z0-9_-]{1,64})",
          );
        }
        return await callApi(
          apiBase,
          `/v1/alerts/events/${encodeURIComponent(eventId)}/acknowledge`,
          {},
          apiKey,
          { method: "POST", jsonBody: { source: "mcp" } },
        );
      }
      case "list_annotations_for_call": {
        const callId = validateCallId(safeArgs["callId"]);
        if (!callId) {
          return errorResponse("callId required (pattern: [A-Za-z0-9_-]{1,128})");
        }
        return await callApi(
          apiBase,
          "/v1/annotations",
          { callId },
          apiKey,
        );
      }
      case "list_annotations_by_label": {
        const label = validateAnnotationLabel(safeArgs["label"]);
        if (!label) {
          return errorResponse("label required (pattern: [A-Za-z0-9_-]{1,64})");
        }
        const query: Record<string, unknown> = { label };
        if (typeof safeArgs["limit"] === "number") query["limit"] = safeArgs["limit"];
        return await callApi(apiBase, "/v1/annotations", query, apiKey);
      }
      case "get_annotation": {
        const annotationId = validateAnnotationId(safeArgs["annotationId"]);
        if (!annotationId) {
          return errorResponse("annotationId required (positive integer up to 10 digits)");
        }
        return await callApi(
          apiBase,
          `/v1/annotations/${encodeURIComponent(annotationId)}`,
          {},
          apiKey,
        );
      }
      case "create_annotation": {
        // POST /v1/annotations. callId is required in the body; the backend
        // validates that at least one of annotationText / label / qualityScore
        // is present (an "empty annotation" gets a 400). safeArgs is already
        // allowlisted.
        const callId = validateCallId(safeArgs["callId"]);
        if (!callId) {
          return errorResponse("callId required (pattern: [A-Za-z0-9_-]{1,128})");
        }
        return await callApi(apiBase, "/v1/annotations", {}, apiKey, {
          method: "POST",
          jsonBody: safeArgs,
        });
      }
      case "update_annotation": {
        // PATCH /v1/annotations/:id with allowlisted body. annotationId is
        // substituted into the path just before the request; the body is the
        // remaining 3 fields (annotationText / label / qualityScore). callId
        // is immutable (absent from the schema as double defense).
        const annotationId = validateAnnotationId(safeArgs["annotationId"]);
        if (!annotationId) {
          return errorResponse("annotationId required (positive integer up to 10 digits)");
        }
        const { annotationId: _ignore, ...body } = safeArgs;
        return await callApi(
          apiBase,
          `/v1/annotations/${encodeURIComponent(annotationId)}`,
          {},
          apiKey,
          { method: "PATCH", jsonBody: body },
        );
      }
      case "delete_annotation": {
        // DELETE /v1/annotations/:id. No body.
        const annotationId = validateAnnotationId(safeArgs["annotationId"]);
        if (!annotationId) {
          return errorResponse("annotationId required (positive integer up to 10 digits)");
        }
        return await callApi(
          apiBase,
          `/v1/annotations/${encodeURIComponent(annotationId)}`,
          {},
          apiKey,
          { method: "DELETE" },
        );
      }
      case "list_eval_criteria": {
        return await callApi(apiBase, "/v1/eval-criteria", {}, apiKey);
      }
      case "get_eval_criterion": {
        const criterionId = validateAnnotationId(safeArgs["criterionId"]);
        if (!criterionId) {
          return errorResponse("criterionId required (positive integer up to 10 digits)");
        }
        return await callApi(
          apiBase,
          `/v1/eval-criteria/${encodeURIComponent(criterionId)}`,
          {},
          apiKey,
        );
      }
      case "create_eval_criterion": {
        if (
          typeof safeArgs["name"] !== "string" ||
          typeof safeArgs["rubric"] !== "string" ||
          typeof safeArgs["scaleMin"] !== "number" ||
          typeof safeArgs["scaleMax"] !== "number"
        ) {
          return errorResponse("name + rubric + scaleMin + scaleMax required");
        }
        return await callApi(apiBase, "/v1/eval-criteria", {}, apiKey, {
          method: "POST",
          jsonBody: safeArgs,
        });
      }
      case "update_eval_criterion": {
        const criterionId = validateAnnotationId(safeArgs["criterionId"]);
        if (!criterionId) {
          return errorResponse("criterionId required (positive integer up to 10 digits)");
        }
        if (
          typeof safeArgs["name"] !== "string" ||
          typeof safeArgs["rubric"] !== "string" ||
          typeof safeArgs["scaleMin"] !== "number" ||
          typeof safeArgs["scaleMax"] !== "number"
        ) {
          return errorResponse("name + rubric + scaleMin + scaleMax required");
        }
        const { criterionId: _ignore, ...body } = safeArgs;
        return await callApi(
          apiBase,
          `/v1/eval-criteria/${encodeURIComponent(criterionId)}`,
          {},
          apiKey,
          {
            method: "PATCH",
            jsonBody: body,
          },
        );
      }
      case "delete_eval_criterion": {
        const criterionId = validateAnnotationId(safeArgs["criterionId"]);
        if (!criterionId) {
          return errorResponse("criterionId required (positive integer up to 10 digits)");
        }
        return await callApi(
          apiBase,
          `/v1/eval-criteria/${encodeURIComponent(criterionId)}`,
          {},
          apiKey,
          { method: "DELETE" },
        );
      }
      case "list_webhooks": {
        return await callApi(apiBase, "/v1/webhooks", {}, apiKey);
      }
      case "create_webhook": {
        if (typeof safeArgs["url"] !== "string") {
          return errorResponse("url required (string)");
        }
        return await callApi(apiBase, "/v1/webhooks", {}, apiKey, {
          method: "POST",
          jsonBody: safeArgs,
        });
      }
      case "update_webhook": {
        const webhookId = validateWebhookId(safeArgs["webhookId"]);
        if (!webhookId) {
          return errorResponse("webhookId required (= owh_ + 24 hex)");
        }
        const { webhookId: _drop, ...body } = safeArgs;
        return await callApi(
          apiBase,
          `/v1/webhooks/${encodeURIComponent(webhookId)}`,
          {},
          apiKey,
          { method: "PATCH", jsonBody: body },
        );
      }
      case "delete_webhook": {
        const webhookId = validateWebhookId(safeArgs["webhookId"]);
        if (!webhookId) {
          return errorResponse("webhookId required (= owh_ + 24 hex)");
        }
        return await callApi(
          apiBase,
          `/v1/webhooks/${encodeURIComponent(webhookId)}`,
          {},
          apiKey,
          { method: "DELETE" },
        );
      }
      case "list_eval_datasets": {
        return await callApi(apiBase, "/v1/eval-datasets", {}, apiKey);
      }
      case "get_eval_dataset": {
        const datasetId = validateAnnotationId(safeArgs["datasetId"]);
        if (!datasetId) {
          return errorResponse("datasetId required (positive integer up to 10 digits)");
        }
        return await callApi(
          apiBase,
          `/v1/eval-datasets/${encodeURIComponent(datasetId)}`,
          {},
          apiKey,
        );
      }
      case "create_eval_dataset": {
        if (typeof safeArgs["name"] !== "string") {
          return errorResponse("name required (string)");
        }
        return await callApi(apiBase, "/v1/eval-datasets", {}, apiKey, {
          method: "POST",
          jsonBody: safeArgs,
        });
      }
      case "run_eval_dataset": {
        const datasetId = validateAnnotationId(safeArgs["datasetId"]);
        if (!datasetId) {
          return errorResponse("datasetId required (positive integer up to 10 digits)");
        }
        if (typeof safeArgs["targetModel"] !== "string") {
          return errorResponse("targetModel required (string)");
        }
        const { datasetId: _omitDsId, ...body } = safeArgs;
        return await callApi(
          apiBase,
          `/v1/eval-datasets/${encodeURIComponent(datasetId)}/run`,
          {},
          apiKey,
          { method: "POST", jsonBody: body },
        );
      }
      case "delete_eval_dataset": {
        const datasetId = validateAnnotationId(safeArgs["datasetId"]);
        if (!datasetId) {
          return errorResponse("datasetId required (positive integer up to 10 digits)");
        }
        return await callApi(
          apiBase,
          `/v1/eval-datasets/${encodeURIComponent(datasetId)}`,
          {},
          apiKey,
          { method: "DELETE" },
        );
      }
      case "test_webhook": {
        if (typeof safeArgs["url"] !== "string") {
          return errorResponse("url required (https://...)");
        }
        return await callApi(apiBase, "/v1/alerts/test-webhook", {}, apiKey, {
          method: "POST",
          jsonBody: safeArgs,
        });
      }
      case "get_llm_budget": {
        return await callApi(
          apiBase,
          "/v1/account/llm-feature-budget",
          {},
          apiKey,
        );
      }
      case "raise_llm_budget": {
        if (typeof safeArgs["budgetUsd"] !== "number") {
          return errorResponse("budgetUsd required (number, 5-500)");
        }
        return await callApi(
          apiBase,
          "/v1/account/llm-feature-budget",
          {},
          apiKey,
          {
            method: "PATCH",
            jsonBody: safeArgs,
          },
        );
      }
      case "get_budget_gate": {
        return await callApi(apiBase, "/v1/gate/budget", {}, apiKey);
      }
      case "create_budget_gate": {
        if (typeof safeArgs["monthlyLimitUsd"] !== "number") {
          return errorResponse("monthlyLimitUsd required (number, 0.01-1000000)");
        }
        // Build the fields explicitly instead of passing safeArgs wholesale
        // (prevents unintended fields from passing through when the allowlist
        // is extended in the future).
        const body: Record<string, unknown> = {
          monthlyLimitUsd: safeArgs["monthlyLimitUsd"],
        };
        if (typeof safeArgs["enforceMode"] === "string") {
          body["enforceMode"] = safeArgs["enforceMode"];
        }
        if (typeof safeArgs["enabled"] === "boolean") {
          body["enabled"] = safeArgs["enabled"];
        }
        // Per-project gate. Sent only when specified (ownership verification
        // happens on the backend).
        if (typeof safeArgs["projectId"] === "string") {
          body["projectId"] = safeArgs["projectId"];
        }
        // Per-tag gate. The backend (parseGateBody) enforces both-or-neither
        // for tagKey/tagValue and mutual exclusion with projectId. Here they
        // are passed through only when specified.
        if (typeof safeArgs["tagKey"] === "string") {
          body["tagKey"] = safeArgs["tagKey"];
        }
        if (typeof safeArgs["tagValue"] === "string") {
          body["tagValue"] = safeArgs["tagValue"];
        }
        return await callApi(apiBase, "/v1/gate/budget", {}, apiKey, {
          method: "POST",
          jsonBody: body,
        });
      }
      case "update_budget_gate": {
        const gateId = validateBudgetGateId(safeArgs["gateId"]);
        if (!gateId) {
          return errorResponse("gateId required (pattern: bg_[a-f0-9]{32})");
        }
        const body: Record<string, unknown> = {};
        if (typeof safeArgs["monthlyLimitUsd"] === "number") {
          body["monthlyLimitUsd"] = safeArgs["monthlyLimitUsd"];
        }
        if (typeof safeArgs["enforceMode"] === "string") {
          body["enforceMode"] = safeArgs["enforceMode"];
        }
        if (typeof safeArgs["enabled"] === "boolean") {
          body["enabled"] = safeArgs["enabled"];
        }
        if (Object.keys(body).length === 0) {
          return errorResponse(
            "at least one of monthlyLimitUsd / enforceMode / enabled is required",
          );
        }
        return await callApi(
          apiBase,
          `/v1/gate/budget/${encodeURIComponent(gateId)}`,
          {},
          apiKey,
          { method: "PATCH", jsonBody: body },
        );
      }
      case "delete_budget_gate": {
        const gateId = validateBudgetGateId(safeArgs["gateId"]);
        if (!gateId) {
          return errorResponse("gateId required (pattern: bg_[a-f0-9]{32})");
        }
        return await callApi(
          apiBase,
          `/v1/gate/budget/${encodeURIComponent(gateId)}`,
          {},
          apiKey,
          { method: "DELETE" },
        );
      }
      case "request_approval": {
        if (typeof safeArgs["action"] !== "string" || typeof safeArgs["summary"] !== "string") {
          return errorResponse("action and summary are required (strings)");
        }
        const body: Record<string, unknown> = {
          action: safeArgs["action"],
          summary: safeArgs["summary"],
        };
        if ("metadata" in safeArgs) {
          if (
            typeof safeArgs["metadata"] !== "object" ||
            safeArgs["metadata"] === null ||
            Array.isArray(safeArgs["metadata"])
          ) {
            return errorResponse("metadata must be a JSON object");
          }
          body["metadata"] = safeArgs["metadata"];
        }
        if ("timeoutSeconds" in safeArgs) {
          if (typeof safeArgs["timeoutSeconds"] !== "number") {
            return errorResponse("timeoutSeconds must be an integer (60-86400)");
          }
          body["timeoutSeconds"] = safeArgs["timeoutSeconds"];
        }
        return await callApi(apiBase, "/v1/gate/approvals", {}, apiKey, {
          method: "POST",
          jsonBody: body,
        });
      }
      case "get_approval": {
        const approvalId = validateApprovalId(safeArgs["approvalId"]);
        if (!approvalId) {
          return errorResponse("approvalId required (pattern: apr_[a-f0-9]{32})");
        }
        return await callApi(
          apiBase,
          `/v1/gate/approvals/${encodeURIComponent(approvalId)}`,
          {},
          apiKey,
        );
      }
      case "list_approvals": {
        const q: Record<string, unknown> = {};
        if (typeof safeArgs["status"] === "string") q["status"] = safeArgs["status"];
        return await callApi(apiBase, "/v1/gate/approvals", q, apiKey);
      }
      case "get_policy_gate": {
        return await callApi(apiBase, "/v1/gate/policy", {}, apiKey);
      }
      case "create_policy_gate": {
        const body: Record<string, unknown> = {};
        // Type mismatches are rejected immediately, not silently dropped
        // (prevents a partial update where the agent falsely believes the
        // setting was applied).
        if ("modelAllowlist" in safeArgs) {
          if (!Array.isArray(safeArgs["modelAllowlist"])) {
            return errorResponse("modelAllowlist must be an array of model names");
          }
          body["modelAllowlist"] = safeArgs["modelAllowlist"];
        }
        for (const key of ["blockPii", "blockSecrets", "enabled"]) {
          if (key in safeArgs) {
            if (typeof safeArgs[key] !== "boolean") {
              return errorResponse(`${key} must be a boolean`);
            }
            body[key] = safeArgs[key];
          }
        }
        if ("enforceMode" in safeArgs) {
          if (typeof safeArgs["enforceMode"] !== "string") {
            return errorResponse("enforceMode must be 'fail_open' or 'fail_closed'");
          }
          body["enforceMode"] = safeArgs["enforceMode"];
        }
        if (
          body["modelAllowlist"] === undefined &&
          body["blockPii"] !== true &&
          body["blockSecrets"] !== true
        ) {
          return errorResponse(
            "at least one rule is required (modelAllowlist / blockPii / blockSecrets)",
          );
        }
        return await callApi(apiBase, "/v1/gate/policy", {}, apiKey, {
          method: "POST",
          jsonBody: body,
        });
      }
      case "update_policy_gate": {
        const policyId = validatePolicyGateId(safeArgs["policyId"]);
        if (!policyId) {
          return errorResponse("policyId required (pattern: pg_[a-f0-9]{32})");
        }
        const body: Record<string, unknown> = {};
        if ("modelAllowlist" in safeArgs) {
          const v = safeArgs["modelAllowlist"];
          if (v !== null && !Array.isArray(v)) {
            return errorResponse(
              "modelAllowlist must be an array of model names, or null to remove the restriction",
            );
          }
          body["modelAllowlist"] = v;
        }
        for (const key of ["blockPii", "blockSecrets", "enabled"]) {
          if (key in safeArgs) {
            if (typeof safeArgs[key] !== "boolean") {
              return errorResponse(`${key} must be a boolean`);
            }
            body[key] = safeArgs[key];
          }
        }
        if ("enforceMode" in safeArgs) {
          if (typeof safeArgs["enforceMode"] !== "string") {
            return errorResponse("enforceMode must be 'fail_open' or 'fail_closed'");
          }
          body["enforceMode"] = safeArgs["enforceMode"];
        }
        if (Object.keys(body).length === 0) {
          return errorResponse(
            "at least one of modelAllowlist / blockPii / blockSecrets / enforceMode / enabled is required",
          );
        }
        return await callApi(
          apiBase,
          `/v1/gate/policy/${encodeURIComponent(policyId)}`,
          {},
          apiKey,
          { method: "PATCH", jsonBody: body },
        );
      }
      case "delete_policy_gate": {
        const policyId = validatePolicyGateId(safeArgs["policyId"]);
        if (!policyId) {
          return errorResponse("policyId required (pattern: pg_[a-f0-9]{32})");
        }
        return await callApi(
          apiBase,
          `/v1/gate/policy/${encodeURIComponent(policyId)}`,
          {},
          apiKey,
          { method: "DELETE" },
        );
      }
      case "list_prompts": {
        const q: Record<string, unknown> = {};
        if (typeof safeArgs["label"] === "string") q["label"] = safeArgs["label"];
        if (typeof safeArgs["name"] === "string") q["name"] = safeArgs["name"];
        if (typeof safeArgs["limit"] === "number") q["limit"] = safeArgs["limit"];
        return await callApi(apiBase, "/v1/prompts", q, apiKey);
      }
      case "get_prompt": {
        const promptId = validateAnnotationId(safeArgs["promptId"]);
        if (!promptId) {
          return errorResponse("promptId required (positive integer up to 10 digits)");
        }
        return await callApi(
          apiBase,
          `/v1/prompts/${encodeURIComponent(promptId)}`,
          {},
          apiKey,
        );
      }
      case "create_prompt": {
        if (typeof safeArgs["name"] !== "string" || typeof safeArgs["version"] !== "string" || typeof safeArgs["template"] !== "string") {
          return errorResponse("name + version + template required");
        }
        return await callApi(apiBase, "/v1/prompts", {}, apiKey, {
          method: "POST",
          jsonBody: safeArgs,
        });
      }
      case "update_prompt": {
        const promptId = validateAnnotationId(safeArgs["promptId"]);
        if (!promptId) {
          return errorResponse("promptId required (positive integer up to 10 digits)");
        }
        const { promptId: _ignore, ...body } = safeArgs;
        return await callApi(
          apiBase,
          `/v1/prompts/${encodeURIComponent(promptId)}`,
          {},
          apiKey,
          {
            method: "PATCH",
            jsonBody: body,
          },
        );
      }
      case "rename_prompt": {
        const promptId = validateAnnotationId(safeArgs["promptId"]);
        if (!promptId) {
          return errorResponse("promptId required (positive integer up to 10 digits)");
        }
        if (typeof safeArgs["name"] !== "string" || typeof safeArgs["version"] !== "string") {
          return errorResponse("name + version required");
        }
        return await callApi(
          apiBase,
          `/v1/prompts/${encodeURIComponent(promptId)}/rename`,
          {},
          apiKey,
          {
            method: "POST",
            jsonBody: { name: safeArgs["name"], version: safeArgs["version"] },
          },
        );
      }
      case "delete_prompt": {
        const promptId = validateAnnotationId(safeArgs["promptId"]);
        if (!promptId) {
          return errorResponse("promptId required (positive integer up to 10 digits)");
        }
        return await callApi(
          apiBase,
          `/v1/prompts/${encodeURIComponent(promptId)}`,
          {},
          apiKey,
          { method: "DELETE" },
        );
      }
      case "deploy_prompt": {
        const promptId = validateAnnotationId(safeArgs["promptId"]);
        if (!promptId) {
          return errorResponse("promptId required (positive integer up to 10 digits)");
        }
        if (typeof safeArgs["label"] !== "string") {
          return errorResponse("label required (string)");
        }
        return await callApi(
          apiBase,
          `/v1/prompts/${encodeURIComponent(promptId)}/deploy`,
          {},
          apiKey,
          { method: "POST", jsonBody: { label: safeArgs["label"] } },
        );
      }
      case "rollback_prompt": {
        if (typeof safeArgs["name"] !== "string" || typeof safeArgs["label"] !== "string") {
          return errorResponse("name + label required");
        }
        return await callApi(apiBase, "/v1/prompts/deployments/rollback", {}, apiKey, {
          method: "POST",
          jsonBody: { name: safeArgs["name"], label: safeArgs["label"] },
        });
      }
      case "get_deployed_prompt": {
        if (typeof safeArgs["name"] !== "string" || typeof safeArgs["label"] !== "string") {
          return errorResponse("name + label required");
        }
        return await callApi(
          apiBase,
          "/v1/prompts/resolve",
          { name: safeArgs["name"], label: safeArgs["label"] },
          apiKey,
        );
      }
      case "list_prompt_deployments": {
        const q: Record<string, unknown> = {};
        if (typeof safeArgs["name"] === "string") q["name"] = safeArgs["name"];
        if (typeof safeArgs["label"] === "string") q["label"] = safeArgs["label"];
        return await callApi(apiBase, "/v1/prompts/deployments", q, apiKey);
      }
      case "list_safety_assessments": {
        const q: Record<string, unknown> = {};
        if (typeof safeArgs["callId"] === "string") {
          const callId = validateCallId(safeArgs["callId"]);
          if (!callId) return errorResponse("callId shape invalid");
          q["call_id"] = callId;
        }
        if (typeof safeArgs["limit"] === "number") q["limit"] = safeArgs["limit"];
        return await callApi(apiBase, "/v1/safety-assessments", q, apiKey);
      }
      case "get_safety_assessment": {
        const assessmentId = validateAnnotationId(safeArgs["assessmentId"]);
        if (!assessmentId) {
          return errorResponse("assessmentId required (positive integer up to 10 digits)");
        }
        return await callApi(
          apiBase,
          `/v1/safety-assessments/${encodeURIComponent(assessmentId)}`,
          {},
          apiKey,
        );
      }
      case "list_eval_runs": {
        const q: Record<string, unknown> = {};
        if (typeof safeArgs["limit"] === "number") q["limit"] = safeArgs["limit"];
        return await callApi(apiBase, "/v1/eval-runs", q, apiKey);
      }
      case "get_eval_run": {
        const runId = validateAnnotationId(safeArgs["runId"]);
        if (!runId) {
          return errorResponse("runId required (positive integer up to 10 digits)");
        }
        return await callApi(
          apiBase,
          `/v1/eval-runs/${encodeURIComponent(runId)}`,
          {},
          apiKey,
        );
      }
      case "get_percentiles": {
        const body: Record<string, unknown> = {};
        if (typeof safeArgs["startTime"] === "string") body["startTime"] = safeArgs["startTime"];
        if (typeof safeArgs["endTime"] === "string") body["endTime"] = safeArgs["endTime"];
        if (typeof safeArgs["provider"] === "string") body["provider"] = safeArgs["provider"];
        if (typeof safeArgs["model"] === "string") body["model"] = safeArgs["model"];
        if (typeof safeArgs["metric"] === "string") body["metric"] = safeArgs["metric"];
        if (typeof safeArgs["groupBy"] === "string") body["groupBy"] = safeArgs["groupBy"];
        return await callApi(apiBase, "/v1/query/percentiles", {}, apiKey, {
          method: "POST",
          jsonBody: body,
        });
      }
      case "list_projects": {
        return await callApi(apiBase, "/v1/projects", {}, apiKey);
      }
      case "list_members": {
        // Never pass the backend's full shape (internal IDs and admin fields
        // like userId / accountId / invitedBy / suspendedAt / removedAt /
        // updatedAt) through to MCP. As the description states, narrow to the
        // minimal projection of email / role / status / join date (the
        // dashboard team UI uses the full shape, so the backend response
        // itself is unchanged).
        const res = await callApi(apiBase, "/v1/memberships", {}, apiKey);
        if (res.isError) return res;
        try {
          const parsed = JSON.parse(res.content[0]?.text ?? "{}") as {
            members?: Array<Record<string, unknown>>;
          };
          const members = (parsed.members ?? []).map((m) => ({
            email: typeof m["email"] === "string" ? m["email"] : null,
            role: m["role"] ?? null,
            status: m["status"] ?? null,
            joinedAt: m["acceptedAt"] ?? m["createdAt"] ?? null,
          }));
          return {
            content: [{ type: "text", text: JSON.stringify({ members }) }],
          };
        } catch {
          return errorResponse("unexpected memberships response shape");
        }
      }
      case "create_project": {
        const name = safeArgs["name"];
        const slug = safeArgs["slug"];
        if (typeof name !== "string" || name.length === 0 || name.length > 64) {
          return errorResponse("name required (1-64 chars)");
        }
        if (typeof slug !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(slug)) {
          return errorResponse("slug required (lowercase alphanumeric + hyphens, max 32 chars, starts with letter)");
        }
        return await callApi(apiBase, "/v1/projects", {}, apiKey, {
          method: "POST",
          jsonBody: { name, slug },
        });
      }
      case "rename_project": {
        const projectId = safeArgs["projectId"];
        if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 64) {
          return errorResponse("projectId required (1-64 chars)");
        }
        const body: Record<string, unknown> = {};
        if (typeof safeArgs["name"] === "string") body["name"] = safeArgs["name"];
        if (typeof safeArgs["slug"] === "string") {
          if (!/^[a-z][a-z0-9-]{0,31}$/.test(safeArgs["slug"])) {
            return errorResponse("slug must match /^[a-z][a-z0-9-]{0,31}$/");
          }
          body["slug"] = safeArgs["slug"];
        }
        if (Object.keys(body).length === 0) {
          return errorResponse("at least one of name / slug required");
        }
        return await callApi(
          apiBase,
          `/v1/projects/${encodeURIComponent(projectId)}`,
          {},
          apiKey,
          { method: "PATCH", jsonBody: body },
        );
      }
      case "delete_project": {
        const projectId = safeArgs["projectId"];
        if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 64) {
          return errorResponse("projectId required (1-64 chars)");
        }
        return await callApi(
          apiBase,
          `/v1/projects/${encodeURIComponent(projectId)}`,
          {},
          apiKey,
          { method: "DELETE" },
        );
      }
      case "classify_calls_batch": {
        const max = safeArgs["maxRecords"];
        const body: Record<string, unknown> = {};
        if (max !== undefined) {
          // Number.isInteger rejects values like 1.9 — same contract as the
          // backend. The implicit Math.floor rounding was removed.
          if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > 100) {
            return errorResponse("maxRecords must be integer 1-100");
          }
          body["maxRecords"] = max;
        }
        return await callApi(
          apiBase,
          "/v1/safety-assessments/scan-batch",
          {},
          apiKey,
          { method: "POST", jsonBody: body },
        );
      }
      case "propose_eval_criteria": {
        // Generates eval criterion candidates via LLM judge. useCaseHint is
        // required; sampleCallIds + maxCriteria are optional. The backend
        // handles plan + budget + decrypt + the LLM call; MCP does only
        // client-side validation + forwarding. Hallucination impact is
        // structurally limited (it only "proposes").
        const useCaseHintRaw = safeArgs["useCaseHint"];
        if (typeof useCaseHintRaw !== "string" || useCaseHintRaw.length < 1 || useCaseHintRaw.length > 500) {
          return errorResponse("useCaseHint required (string 1-500 chars)");
        }
        const body: Record<string, unknown> = { useCaseHint: useCaseHintRaw };
        const sampleRaw = safeArgs["sampleCallIds"];
        if (sampleRaw !== undefined) {
          if (!Array.isArray(sampleRaw)) {
            return errorResponse("sampleCallIds must be an array");
          }
          if (sampleRaw.length > 5) {
            return errorResponse("sampleCallIds max 5 entries");
          }
          const sampleCallIds: string[] = [];
          for (const raw of sampleRaw) {
            if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw)) {
              return errorResponse("sampleCallIds entries must match [A-Za-z0-9_-]{1,128}");
            }
            sampleCallIds.push(raw);
          }
          if (sampleCallIds.length > 0) body["sampleCallIds"] = sampleCallIds;
        }
        const maxCriteriaRaw = safeArgs["maxCriteria"];
        if (maxCriteriaRaw !== undefined) {
          if (
            typeof maxCriteriaRaw !== "number" ||
            !Number.isInteger(maxCriteriaRaw) ||
            maxCriteriaRaw < 1 ||
            maxCriteriaRaw > 10
          ) {
            return errorResponse("maxCriteria must be integer 1-10");
          }
          body["maxCriteria"] = maxCriteriaRaw;
        }
        return await callApi(
          apiBase,
          "/v1/eval-criteria/propose",
          {},
          apiKey,
          { method: "POST", jsonBody: body },
        );
      }
      // Autonomous AI ops tools (purge_expired_plaintext + retry_failed_webhook).
      // Shared behavior of both tools:
      //   - two paths, dryRun=true / false (preview before mutation)
      //   - the backend handles audit emission + UPDATE ordering
      //   - operator-scoped for now (no approval-gating UI yet)
      case "purge_expired_plaintext": {
        const olderThanDaysRaw = safeArgs["olderThanDays"];
        const body: Record<string, unknown> = {};
        if (olderThanDaysRaw !== undefined) {
          if (
            typeof olderThanDaysRaw !== "number" ||
            !Number.isInteger(olderThanDaysRaw) ||
            olderThanDaysRaw < 1 ||
            olderThanDaysRaw > 365
          ) {
            return errorResponse("olderThanDays must be integer 1-365");
          }
          body["olderThanDays"] = olderThanDaysRaw;
        }
        const dryRunRaw = safeArgs["dryRun"];
        if (dryRunRaw !== undefined && typeof dryRunRaw !== "boolean") {
          return errorResponse("dryRun must be boolean");
        }
        body["dryRun"] = dryRunRaw === true;
        const approvalIdRaw = safeArgs["approvalId"];
        if (approvalIdRaw !== undefined) {
          if (
            typeof approvalIdRaw !== "string" ||
            !/^apr_[a-f0-9]{32}$/.test(approvalIdRaw)
          ) {
            return errorResponse("approvalId must be an approval ID (apr_ + 32 hex chars)");
          }
          body["approvalId"] = approvalIdRaw;
        }
        return await callApi(
          apiBase,
          "/v1/tier2/plaintext/purge-expired",
          {},
          apiKey,
          { method: "POST", jsonBody: body },
        );
      }
      case "retry_failed_webhook": {
        const body: Record<string, unknown> = {};
        const eventIdsRaw = safeArgs["eventIds"];
        if (eventIdsRaw !== undefined) {
          if (!Array.isArray(eventIdsRaw)) {
            return errorResponse("eventIds must be an array");
          }
          if (eventIdsRaw.length > 100) {
            return errorResponse("eventIds max 100 per request");
          }
          const eventIds: string[] = [];
          for (const raw of eventIdsRaw) {
            if (typeof raw !== "string" || raw.length === 0 || raw.length > 256) {
              return errorResponse("eventIds entries must be non-empty strings <= 256 chars");
            }
            eventIds.push(raw);
          }
          if (eventIds.length > 0) body["eventIds"] = eventIds;
        }
        const fromTs = safeArgs["fromTimestamp"];
        if (fromTs !== undefined) {
          if (typeof fromTs !== "string" || Number.isNaN(Date.parse(fromTs))) {
            return errorResponse("fromTimestamp must be ISO-8601 string");
          }
          body["fromTimestamp"] = fromTs;
        }
        const toTs = safeArgs["toTimestamp"];
        if (toTs !== undefined) {
          if (typeof toTs !== "string" || Number.isNaN(Date.parse(toTs))) {
            return errorResponse("toTimestamp must be ISO-8601 string");
          }
          body["toTimestamp"] = toTs;
        }
        const maxRetriesRaw = safeArgs["maxRetries"];
        if (maxRetriesRaw !== undefined) {
          if (
            typeof maxRetriesRaw !== "number" ||
            !Number.isInteger(maxRetriesRaw) ||
            maxRetriesRaw < 1 ||
            maxRetriesRaw > 100
          ) {
            return errorResponse("maxRetries must be integer 1-100");
          }
          body["maxRetries"] = maxRetriesRaw;
        }
        const dryRunRaw = safeArgs["dryRun"];
        if (dryRunRaw !== undefined && typeof dryRunRaw !== "boolean") {
          return errorResponse("dryRun must be boolean");
        }
        body["dryRun"] = dryRunRaw === true;
        const approvalIdRaw = safeArgs["approvalId"];
        if (approvalIdRaw !== undefined) {
          if (
            typeof approvalIdRaw !== "string" ||
            !/^apr_[a-f0-9]{32}$/.test(approvalIdRaw)
          ) {
            return errorResponse("approvalId must be an approval ID (apr_ + 32 hex chars)");
          }
          body["approvalId"] = approvalIdRaw;
        }
        return await callApi(
          apiBase,
          "/v1/tier2/webhook-events/retry",
          {},
          apiKey,
          { method: "POST", jsonBody: body },
        );
      }
      case "auto_silence_noisy_alert": {
        const body: Record<string, unknown> = {};
        const alertIdRaw = safeArgs["alertId"];
        if (alertIdRaw !== undefined) {
          if (typeof alertIdRaw !== "string" || alertIdRaw.length === 0 || alertIdRaw.length > 64) {
            return errorResponse("alertId must be non-empty string <= 64 chars");
          }
          body["alertId"] = alertIdRaw;
        }
        const thresholdRaw = safeArgs["byVolumeThreshold"];
        if (thresholdRaw !== undefined) {
          if (
            typeof thresholdRaw !== "number" ||
            !Number.isInteger(thresholdRaw) ||
            thresholdRaw < 1 ||
            thresholdRaw > 1000
          ) {
            return errorResponse("byVolumeThreshold must be integer 1-1000");
          }
          body["byVolumeThreshold"] = thresholdRaw;
        }
        if (body["alertId"] === undefined && body["byVolumeThreshold"] === undefined) {
          return errorResponse("specify alertId or byVolumeThreshold");
        }
        if (body["alertId"] !== undefined && body["byVolumeThreshold"] !== undefined) {
          return errorResponse("alertId and byVolumeThreshold are mutually exclusive");
        }
        const durationRaw = safeArgs["silenceDurationMinutes"];
        if (durationRaw !== undefined) {
          if (
            typeof durationRaw !== "number" ||
            !Number.isInteger(durationRaw) ||
            durationRaw < 5 ||
            durationRaw > 1440
          ) {
            return errorResponse("silenceDurationMinutes must be integer 5-1440");
          }
          body["silenceDurationMinutes"] = durationRaw;
        }
        const reasonRaw = safeArgs["reason"];
        if (reasonRaw !== undefined) {
          if (typeof reasonRaw !== "string" || reasonRaw.length > 200) {
            return errorResponse("reason must be string <= 200 chars");
          }
          body["reason"] = reasonRaw;
        }
        const dryRunRaw = safeArgs["dryRun"];
        if (dryRunRaw !== undefined && typeof dryRunRaw !== "boolean") {
          return errorResponse("dryRun must be boolean");
        }
        body["dryRun"] = dryRunRaw === true;
        const approvalIdRaw = safeArgs["approvalId"];
        if (approvalIdRaw !== undefined) {
          if (
            typeof approvalIdRaw !== "string" ||
            !/^apr_[a-f0-9]{32}$/.test(approvalIdRaw)
          ) {
            return errorResponse("approvalId must be an approval ID (apr_ + 32 hex chars)");
          }
          body["approvalId"] = approvalIdRaw;
        }
        return await callApi(
          apiBase,
          "/v1/tier2/alerts/auto-silence",
          {},
          apiKey,
          { method: "POST", jsonBody: body },
        );
      }
      // extend_customer_trial + apply_promo_code_to_customer: operator-scoped
      // Stripe API mutations. dryRun is required; the backend handles the
      // Stripe Idempotency-Key.
      case "extend_customer_trial": {
        const targetAccountIdRaw = safeArgs["targetAccountId"];
        if (
          typeof targetAccountIdRaw !== "string" ||
          targetAccountIdRaw.length === 0 ||
          targetAccountIdRaw.length > 64
        ) {
          return errorResponse("targetAccountId must be non-empty string <= 64 chars");
        }
        const extendDaysRaw = safeArgs["extendDays"];
        if (
          typeof extendDaysRaw !== "number" ||
          !Number.isInteger(extendDaysRaw) ||
          extendDaysRaw < 1 ||
          extendDaysRaw > 30
        ) {
          return errorResponse("extendDays must be integer 1-30");
        }
        const reasonRaw = safeArgs["reason"];
        if (
          typeof reasonRaw !== "string" ||
          reasonRaw.length === 0 ||
          reasonRaw.length > 200
        ) {
          return errorResponse("reason must be non-empty string <= 200 chars");
        }
        // dryRun must be explicit at the MCP layer too.
        const dryRunRaw = safeArgs["dryRun"];
        if (typeof dryRunRaw !== "boolean") {
          return errorResponse("dryRun must be an explicit boolean");
        }
        const body: Record<string, unknown> = {
          targetAccountId: targetAccountIdRaw,
          extendDays: extendDaysRaw,
          reason: reasonRaw,
          dryRun: dryRunRaw,
        };
        // With dryRun=false, idempotencyKey is required.
        if (dryRunRaw === false) {
          const ikRaw = safeArgs["idempotencyKey"];
          if (
            typeof ikRaw !== "string" ||
            ikRaw.length < 16 ||
            ikRaw.length > 128 ||
            !/^[A-Za-z0-9_-]+$/.test(ikRaw)
          ) {
            return errorResponse(
              "idempotencyKey required for dryRun=false (16-128 alphanumeric + '_-' chars)",
            );
          }
          body["idempotencyKey"] = ikRaw;
        }
        const approvalIdRaw = safeArgs["approvalId"];
        if (approvalIdRaw !== undefined) {
          if (
            typeof approvalIdRaw !== "string" ||
            !/^apr_[a-f0-9]{32}$/.test(approvalIdRaw)
          ) {
            return errorResponse("approvalId must be an approval ID (apr_ + 32 hex chars)");
          }
          body["approvalId"] = approvalIdRaw;
        }
        return await callApi(
          apiBase,
          "/v1/tier2/trial/extend",
          {},
          apiKey,
          { method: "POST", jsonBody: body },
        );
      }
      case "apply_promo_code_to_customer": {
        const targetAccountIdRaw = safeArgs["targetAccountId"];
        if (
          typeof targetAccountIdRaw !== "string" ||
          targetAccountIdRaw.length === 0 ||
          targetAccountIdRaw.length > 64
        ) {
          return errorResponse("targetAccountId must be non-empty string <= 64 chars");
        }
        const promoCodeRaw = safeArgs["promoCode"];
        if (
          typeof promoCodeRaw !== "string" ||
          promoCodeRaw.length === 0 ||
          promoCodeRaw.length > 64 ||
          !/^[A-Za-z0-9_-]+$/.test(promoCodeRaw)
        ) {
          return errorResponse(
            "promoCode must be non-empty alphanumeric (+ '_-') string <= 64 chars",
          );
        }
        const reasonRaw = safeArgs["reason"];
        if (
          typeof reasonRaw !== "string" ||
          reasonRaw.length === 0 ||
          reasonRaw.length > 200
        ) {
          return errorResponse("reason must be non-empty string <= 200 chars");
        }
        const dryRunRaw = safeArgs["dryRun"];
        if (typeof dryRunRaw !== "boolean") {
          return errorResponse("dryRun must be an explicit boolean");
        }
        const body: Record<string, unknown> = {
          targetAccountId: targetAccountIdRaw,
          promoCode: promoCodeRaw,
          reason: reasonRaw,
          dryRun: dryRunRaw,
        };
        if (dryRunRaw === false) {
          const ikRaw = safeArgs["idempotencyKey"];
          if (
            typeof ikRaw !== "string" ||
            ikRaw.length < 16 ||
            ikRaw.length > 128 ||
            !/^[A-Za-z0-9_-]+$/.test(ikRaw)
          ) {
            return errorResponse(
              "idempotencyKey required for dryRun=false (16-128 alphanumeric + '_-' chars)",
            );
          }
          body["idempotencyKey"] = ikRaw;
        }
        const approvalIdRaw = safeArgs["approvalId"];
        if (approvalIdRaw !== undefined) {
          if (
            typeof approvalIdRaw !== "string" ||
            !/^apr_[a-f0-9]{32}$/.test(approvalIdRaw)
          ) {
            return errorResponse("approvalId must be an approval ID (apr_ + 32 hex chars)");
          }
          body["approvalId"] = approvalIdRaw;
        }
        return await callApi(
          apiBase,
          "/v1/tier2/promo/apply",
          {},
          apiKey,
          { method: "POST", jsonBody: body },
        );
      }
      case "detect_anomaly": {
        // Anomaly detection on 4 dimensions by comparing the current window
        // against a baseline window (the immediately preceding period of the
        // same length). A pure MCP-side aggregator; zero backend changes.
        // Threshold sensitivity: 1.5x (sensitive) / 2x (normal) / 3x
        // (conservative). Insufficient baseline data yields anomalies: [] +
        // a warning.
        const winRaw = typeof safeArgs["window"] === "string" ? safeArgs["window"] : "24h";
        const window =
          winRaw === "1h" || winRaw === "24h" || winRaw === "7d" ? winRaw : "24h";
        const thresholdRaw =
          typeof safeArgs["threshold"] === "string" ? safeArgs["threshold"] : "normal";
        const threshold =
          thresholdRaw === "sensitive" ||
          thresholdRaw === "normal" ||
          thresholdRaw === "conservative"
            ? thresholdRaw
            : "normal";
        const multiplier =
          threshold === "sensitive" ? 1.5 : threshold === "conservative" ? 3 : 2;
        const windowMs =
          window === "1h"
            ? 60 * 60 * 1000
            : window === "24h"
              ? 24 * 60 * 60 * 1000
              : 7 * 24 * 60 * 60 * 1000;
        const now = Date.now();
        const currentEnd = new Date(now).toISOString();
        const currentStart = new Date(now - windowMs).toISOString();
        const baselineEnd = currentStart;
        const baselineStart = new Date(now - 2 * windowMs).toISOString();
        const fetchWindow = async (startTime: string, endTime: string) => {
          const [costRes, errorRes, countRes, percentileRes] = await Promise.allSettled([
            callApi(apiBase, "/v1/query/aggregate", {}, apiKey, {
              method: "POST",
              jsonBody: { startTime, endTime, groupBy: "provider", metric: "cost" },
            }),
            callApi(apiBase, "/v1/query/aggregate", {}, apiKey, {
              method: "POST",
              jsonBody: { startTime, endTime, groupBy: "provider", metric: "error_rate" },
            }),
            callApi(apiBase, "/v1/query/aggregate", {}, apiKey, {
              method: "POST",
              jsonBody: { startTime, endTime, groupBy: "provider", metric: "count" },
            }),
            callApi(apiBase, "/v1/query/percentiles", {}, apiKey, {
              method: "POST",
              jsonBody: { startTime, endTime, metric: "latency" },
            }),
          ]);
          const extractJson = (
            r: PromiseSettledResult<{
              content: Array<{ type: "text"; text: string }>;
              isError?: boolean;
            }>,
          ): unknown | null => {
            if (r.status !== "fulfilled" || r.value.isError) return null;
            try {
              return JSON.parse(r.value.content[0]?.text ?? "");
            } catch {
              return null;
            }
          };
          const cost = extractJson(costRes) as {
            total?: { value?: number; count?: number };
          } | null;
          const errors = extractJson(errorRes) as {
            total?: { value?: number; count?: number };
          } | null;
          const counts = extractJson(countRes) as {
            total?: { value?: number; count?: number };
          } | null;
          const percentiles = extractJson(percentileRes) as {
            p95?: number | null;
            total?: number;
          } | null;
          const failures: string[] = [];
          if (cost === null) failures.push("cost");
          if (errors === null) failures.push("errorRate");
          if (counts === null) failures.push("calls");
          if (percentiles === null) failures.push("percentiles");
          return {
            window: {
              costUsd: cost?.total?.value ?? 0,
              errorRate: errors?.total?.value ?? null,
              calls: counts?.total?.value ?? 0,
              p95Latency: percentiles?.p95 ?? null,
              records: percentiles?.total ?? counts?.total?.count ?? 0,
            },
            failures,
          };
        };
        const [currentResult, baselineResult] = await Promise.all([
          fetchWindow(currentStart, currentEnd),
          fetchWindow(baselineStart, baselineEnd),
        ]);
        const current = currentResult.window;
        const baseline = baselineResult.window;
        // propose_alert_rules / detect_anomaly also report partialFailures
        // (same format as get_account_health). Returning which dimensions'
        // endpoints failed, for transparency, lets an AI agent distinguish
        // "low traffic" from "endpoint failure".
        const partialFailures = [
          ...currentResult.failures.map((f) => `current:${f}`),
          ...baselineResult.failures.map((f) => `baseline:${f}`),
        ];
        if (baseline.records < 10) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  window,
                  threshold,
                  current,
                  baseline,
                  anomalies: [],
                  warning: `baseline window に records ${baseline.records} 件 (< 10 件)、 anomaly 検出 統計強度 不足`,
                  partialFailures: partialFailures.length > 0 ? partialFailures : undefined,
                }),
              },
            ],
          };
        }
        const anomalies: Array<{
          axis: string;
          severity: "minor" | "major" | "critical";
          current: number | null;
          baseline: number | null;
          ratio: number;
          narrative: string;
        }> = [];
        const severityFromRatio = (
          ratio: number,
        ): "minor" | "major" | "critical" => {
          if (ratio >= multiplier * 2) return "critical";
          if (ratio >= multiplier * 1.3) return "major";
          return "minor";
        };
        // 1. cost spike (= current cost > baseline cost × multiplier)
        if (baseline.costUsd > 0 && current.costUsd > baseline.costUsd * multiplier) {
          const ratio = current.costUsd / baseline.costUsd;
          anomalies.push({
            axis: "cost",
            severity: severityFromRatio(ratio),
            current: Math.round(current.costUsd * 100) / 100,
            baseline: Math.round(baseline.costUsd * 100) / 100,
            ratio: Math.round(ratio * 100) / 100,
            narrative: `cost が baseline の ${ratio.toFixed(1)}× ($${current.costUsd.toFixed(2)} vs $${baseline.costUsd.toFixed(2)})。 threshold=${threshold} (= ${multiplier}×) を 超過。`,
          });
        }
        // 2. latency p95 spike
        if (
          baseline.p95Latency !== null &&
          baseline.p95Latency > 0 &&
          current.p95Latency !== null &&
          current.p95Latency > baseline.p95Latency * multiplier
        ) {
          const ratio = current.p95Latency / baseline.p95Latency;
          anomalies.push({
            axis: "latency",
            severity: severityFromRatio(ratio),
            current: Math.round(current.p95Latency),
            baseline: Math.round(baseline.p95Latency),
            ratio: Math.round(ratio * 100) / 100,
            narrative: `p95 latency が baseline の ${ratio.toFixed(1)}× (${Math.round(current.p95Latency)} ms vs ${Math.round(baseline.p95Latency)} ms)。 LLM provider 側の劣化 / 自社 prompt 改変 / network などが原因候補。`,
          });
        }
        // 3. error_rate spike (= current > max(baseline × multiplier, +5pp))
        // Note: the backend aggregate_calls error_rate metric is returned as
        // a percent (0-100) (query.ts valueExpr "(...) * 100"). All units
        // here are percent, and the narrative displays percent too. +5pp is
        // added as 5.0 (5 percentage points).
        if (
          baseline.errorRate !== null &&
          current.errorRate !== null &&
          current.errorRate > Math.max(baseline.errorRate * multiplier, baseline.errorRate + 5)
        ) {
          const ratio = baseline.errorRate > 0 ? current.errorRate / baseline.errorRate : 999;
          anomalies.push({
            axis: "error_rate",
            severity: severityFromRatio(ratio === 999 ? multiplier * 2 : ratio),
            current: Math.round(current.errorRate * 100) / 100,
            baseline: Math.round(baseline.errorRate * 100) / 100,
            ratio: ratio === 999 ? 999 : Math.round(ratio * 100) / 100,
            narrative: `error rate が ${current.errorRate.toFixed(2)}% (baseline ${baseline.errorRate.toFixed(2)}%)。 ratio ${ratio === 999 ? "∞" : ratio.toFixed(1)}× で threshold=${threshold} 超過。`,
          });
        }
        // 4. call volume spike or drop (= current calls > baseline × multiplier OR < baseline / multiplier)
        if (baseline.calls > 0) {
          const ratio = current.calls / baseline.calls;
          // Strict `>` comparison, same as the cost / latency / error_rate
          // dimensions (e.g. with multiplier=2, exactly 2.0x is not an
          // anomaly; 2.01x is). The old `>= multiplier` made the boundary
          // semantics inconsistent across the tool's dimensions.
          if (ratio > multiplier) {
            anomalies.push({
              axis: "call_volume",
              severity: severityFromRatio(ratio),
              current: current.calls,
              baseline: baseline.calls,
              ratio: Math.round(ratio * 100) / 100,
              narrative: `call volume が baseline の ${ratio.toFixed(1)}× (${current.calls} vs ${baseline.calls})。 traffic spike / retry storm / new user onboarding などが原因候補。`,
            });
          } else if (ratio > 0 && 1 / ratio > multiplier) {
            const dropRatio = 1 / ratio;
            anomalies.push({
              axis: "call_volume",
              severity: severityFromRatio(dropRatio),
              current: current.calls,
              baseline: baseline.calls,
              ratio: Math.round(ratio * 100) / 100,
              narrative: `call volume が baseline の 1/${dropRatio.toFixed(1)} に 急減 (${current.calls} vs ${baseline.calls})。 SDK 側の outage / user drop-off / 自社 feature flag などが原因候補。`,
            });
          }
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                window,
                threshold,
                multiplier,
                current,
                baseline,
                anomalies,
                partialFailures: partialFailures.length > 0 ? partialFailures : undefined,
              }),
            },
          ],
        };
      }
      case "propose_alert_rules": {
        // Baseline statistics + recommended alert rule proposals. Proposal
        // only; applying is a separate step (create_alert). Types that would
        // duplicate an existing alert go into the skipped array with a reason
        // (duplicate defense).
        const lookbackRaw = safeArgs["lookbackDays"];
        const lookbackDays =
          typeof lookbackRaw === "number" &&
          Number.isFinite(lookbackRaw) &&
          lookbackRaw >= 7 &&
          lookbackRaw <= 30
            ? Math.floor(lookbackRaw)
            : 14;
        const now = Date.now();
        const windowMs = lookbackDays * 24 * 60 * 60 * 1000;
        const startTime = new Date(now - windowMs).toISOString();
        const endTime = new Date(now).toISOString();
        const dailyCostBody = {
          startTime,
          endTime,
          groupBy: "day",
          metric: "cost",
        };
        const errorRateBody = {
          startTime,
          endTime,
          groupBy: "provider",
          metric: "error_rate",
        };
        const dailyCountBody = {
          startTime,
          endTime,
          groupBy: "day",
          metric: "count",
        };
        const percentileBody = { startTime, endTime, metric: "latency" };
        const [dailyCostRes, errorRateRes, dailyCountRes, percentileRes, alertsRes] =
          await Promise.allSettled([
            callApi(apiBase, "/v1/query/aggregate", {}, apiKey, {
              method: "POST",
              jsonBody: dailyCostBody,
            }),
            callApi(apiBase, "/v1/query/aggregate", {}, apiKey, {
              method: "POST",
              jsonBody: errorRateBody,
            }),
            callApi(apiBase, "/v1/query/aggregate", {}, apiKey, {
              method: "POST",
              jsonBody: dailyCountBody,
            }),
            callApi(apiBase, "/v1/query/percentiles", {}, apiKey, {
              method: "POST",
              jsonBody: percentileBody,
            }),
            callApi(apiBase, "/v1/alerts", {}, apiKey),
          ]);
        const extractJson = (
          r: PromiseSettledResult<{
            content: Array<{ type: "text"; text: string }>;
            isError?: boolean;
          }>,
        ): unknown | null => {
          if (r.status !== "fulfilled" || r.value.isError) return null;
          const txt = r.value.content[0]?.text ?? "";
          try {
            return JSON.parse(txt);
          } catch {
            return null;
          }
        };
        const dailyCost = extractJson(dailyCostRes) as {
          groups?: Array<{ key: string; value: number; count: number }>;
          total?: { value?: number; count?: number };
        } | null;
        const errorRate = extractJson(errorRateRes) as {
          total?: { value?: number; count?: number };
        } | null;
        const dailyCount = extractJson(dailyCountRes) as {
          groups?: Array<{ key: string; value: number; count: number }>;
          total?: { value?: number; count?: number };
        } | null;
        const percentiles = extractJson(percentileRes) as {
          p50?: number | null;
          p95?: number | null;
          p99?: number | null;
          total?: number;
        } | null;
        const alerts = extractJson(alertsRes) as {
          alerts?: Array<{ alertType?: string; name?: string }>;
        } | null;
        // propose_alert_rules also reports partialFailures (same format as
        // get_account_health). Returning which dimensions' endpoints failed,
        // for transparency, lets an AI agent distinguish "the baseline
        // statistics are accurate" from "baseline=0 caused by an endpoint
        // failure".
        const partialFailures: string[] = [];
        if (dailyCost === null) partialFailures.push("dailyCost");
        if (errorRate === null) partialFailures.push("errorRate");
        if (dailyCount === null) partialFailures.push("dailyCount");
        if (percentiles === null) partialFailures.push("percentiles");
        if (alerts === null) partialFailures.push("existingAlerts");

        const dailyCostValues = (dailyCost?.groups ?? [])
          .map((g) => Number(g.value))
          .filter((v) => Number.isFinite(v));
        const meanDailyCost =
          dailyCostValues.length > 0
            ? dailyCostValues.reduce((a, b) => a + b, 0) / dailyCostValues.length
            : 0;
        const maxDailyCost =
          dailyCostValues.length > 0 ? Math.max(...dailyCostValues) : 0;
        const dailyCountValues = (dailyCount?.groups ?? [])
          .map((g) => Number(g.value))
          .filter((v) => Number.isFinite(v));
        const meanDailyCalls =
          dailyCountValues.length > 0
            ? dailyCountValues.reduce((a, b) => a + b, 0) / dailyCountValues.length
            : 0;
        const p95Latency = percentiles?.p95 ?? null;
        const totalCalls = dailyCount?.total?.value ?? 0;
        const observedErrorRate =
          errorRate?.total?.value !== undefined && errorRate.total.value !== null
            ? Number(errorRate.total.value)
            : null;

        const existingTypes = new Set<string>(
          (alerts?.alerts ?? [])
            .map((a) => a.alertType)
            .filter((t): t is string => typeof t === "string"),
        );

        const proposals: Array<{
          name: string;
          alertType: string;
          thresholdValue: number;
          windowMinutes: number;
          reasoning: string;
        }> = [];
        const skipped: Array<{ alertType: string; reason: string }> = [];

        // 1. cost_threshold: triggers at 2x the lookback average (detects an
        //    abnormal single day of spend). Proposed under the type name
        //    consistent with the create_alert enum (cost_threshold), with a
        //    1-day window (windowMinutes 1440).
        if (existingTypes.has("cost_threshold")) {
          skipped.push({
            alertType: "cost_threshold",
            reason: "既に同 type の alert が 設定済",
          });
        } else if (meanDailyCost <= 0) {
          skipped.push({
            alertType: "cost_threshold",
            reason: `lookback ${lookbackDays} 日の cost data が 不足 (mean=${meanDailyCost})`,
          });
        } else {
          const threshold = Math.round(meanDailyCost * 2 * 100) / 100;
          proposals.push({
            name: `Daily cost > ${threshold} USD (baseline 2×)`,
            alertType: "cost_threshold",
            thresholdValue: threshold,
            windowMinutes: 1440,
            reasoning: `過去 ${lookbackDays} 日の 平均 daily cost = $${meanDailyCost.toFixed(2)} / 観測 max = $${maxDailyCost.toFixed(2)}。 baseline 2× を 異常閾値 として 提案。`,
          });
        }

        // 2. latency_degradation: triggers at 1.5x the historical p95.
        //    Proposed under the type name consistent with the create_alert
        //    enum (latency_degradation).
        if (existingTypes.has("latency_degradation")) {
          skipped.push({
            alertType: "latency_degradation",
            reason: "既に同 type の alert が 設定済",
          });
        } else if (p95Latency === null || p95Latency <= 0) {
          skipped.push({
            alertType: "latency_degradation",
            reason: "lookback 期間に p95 latency data が 不足",
          });
        } else {
          const threshold = Math.round(p95Latency * 1.5);
          proposals.push({
            name: `p95 latency > ${threshold} ms (baseline 1.5×)`,
            alertType: "latency_degradation",
            thresholdValue: threshold,
            windowMinutes: 60,
            reasoning: `過去 ${lookbackDays} 日の p95 latency = ${Math.round(p95Latency)} ms。 baseline 1.5× を 劣化閾値 として 提案。`,
          });
        }

        // 3. error_rate: triggers at 3x the observed error_rate, or at least 5%.
        if (existingTypes.has("error_rate")) {
          skipped.push({
            alertType: "error_rate",
            reason: "既に同 type の alert が 設定済",
          });
        } else if (totalCalls < 100) {
          skipped.push({
            alertType: "error_rate",
            reason: `lookback の total calls = ${totalCalls} で 統計的に baseline 不確定 (要 100+ calls)`,
          });
        } else {
          // Note: the backend expresses error_rate as a percent (0-100).
          // observedErrorRate comes from aggregate_calls, so it is a percent
          // too. The threshold is also proposed in percent, and the
          // create_alert backend expects percent as well (consistent with
          // the "error_rate is %" note in the schema).
          const baseRate = observedErrorRate ?? 0;
          const threshold = Math.max(5, Math.round(baseRate * 3 * 10) / 10);
          proposals.push({
            name: `Error rate > ${threshold.toFixed(1)}% (baseline 3× or 5% min)`,
            alertType: "error_rate",
            thresholdValue: threshold,
            windowMinutes: 60,
            reasoning: `過去 ${lookbackDays} 日の error rate = ${baseRate.toFixed(2)}%。 baseline 3× と 最低 5% の 大きい方 (= ${threshold.toFixed(1)}%) を 異常閾値 として 提案。`,
          });
        }

        // 4. anomaly_cost: statistical anomaly detection (forecast-model
        //    baseline; at most one proposal per type).
        if (existingTypes.has("anomaly_cost")) {
          skipped.push({
            alertType: "anomaly_cost",
            reason: "既に同 type の alert が 設定済",
          });
        } else if (meanDailyCalls < 50) {
          skipped.push({
            alertType: "anomaly_cost",
            reason: `1 日平均 calls = ${Math.round(meanDailyCalls)} で anomaly 検知の 統計強度 不足 (要 50+ daily calls)`,
          });
        } else {
          proposals.push({
            name: `Cost anomaly (statistical z-score > 3σ)`,
            alertType: "anomaly_cost",
            thresholdValue: 3,
            windowMinutes: 60,
            reasoning: `過去 ${lookbackDays} 日で 1 日平均 ${Math.round(meanDailyCalls)} calls 観測、 anomaly forecast モデルが 有効。 z-score 3σ 超を 異常 として 提案。`,
          });
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                lookbackDays,
                baseline: {
                  meanDailyCost: Math.round(meanDailyCost * 100) / 100,
                  maxDailyCost: Math.round(maxDailyCost * 100) / 100,
                  p95Latency: p95Latency !== null ? Math.round(p95Latency) : null,
                  errorRate: observedErrorRate,
                  dailyCalls: Math.round(meanDailyCalls),
                  totalCalls,
                },
                proposals,
                skipped,
                partialFailures: partialFailures.length > 0 ? partialFailures : undefined,
              }),
            },
          ],
        };
      }
      case "get_account_health": {
        // Health summary of the account's LLM infra. Fetches 4 existing
        // endpoints in parallel and compresses them into one narrative.
        // Individual failures are reported as partial (designed so one
        // dimension timing out never blocks the summary).
        const winRaw = typeof safeArgs["window"] === "string" ? safeArgs["window"] : "24h";
        const window =
          winRaw === "1h" || winRaw === "24h" || winRaw === "7d" ? winRaw : "24h";
        const now = Date.now();
        const windowMs =
          window === "1h"
            ? 60 * 60 * 1000
            : window === "24h"
              ? 24 * 60 * 60 * 1000
              : 7 * 24 * 60 * 60 * 1000;
        const startTime = new Date(now - windowMs).toISOString();
        const endTime = new Date(now).toISOString();
        const aggregateBody = { startTime, endTime, groupBy: "provider", metric: "count" };
        const errorBody = { startTime, endTime, groupBy: "provider", metric: "error_rate" };
        const costBody = { startTime, endTime, groupBy: "provider", metric: "cost" };
        const percentileBody = { startTime, endTime, metric: "latency" };
        const [
          countsRes,
          errorRes,
          costRes,
          percentilesRes,
          budgetRes,
          auditRes,
        ] = await Promise.allSettled([
          callApi(apiBase, "/v1/query/aggregate", {}, apiKey, {
            method: "POST",
            jsonBody: aggregateBody,
          }),
          callApi(apiBase, "/v1/query/aggregate", {}, apiKey, {
            method: "POST",
            jsonBody: errorBody,
          }),
          callApi(apiBase, "/v1/query/aggregate", {}, apiKey, {
            method: "POST",
            jsonBody: costBody,
          }),
          callApi(apiBase, "/v1/query/percentiles", {}, apiKey, {
            method: "POST",
            jsonBody: percentileBody,
          }),
          callApi(apiBase, "/v1/account/llm-feature-budget", {}, apiKey),
          callApi(apiBase, "/v1/audit-log", { limit: 10 }, apiKey),
        ]);
        const extractJson = (
          r: PromiseSettledResult<{
            content: Array<{ type: "text"; text: string }>;
            isError?: boolean;
          }>,
        ): unknown | null => {
          if (r.status !== "fulfilled" || r.value.isError) return null;
          const txt = r.value.content[0]?.text ?? "";
          try {
            return JSON.parse(txt);
          } catch {
            return null;
          }
        };
        const counts = extractJson(countsRes) as
          | { total?: { value?: number; count?: number } }
          | null;
        const errors = extractJson(errorRes) as
          | { total?: { value?: number; count?: number } }
          | null;
        const cost = extractJson(costRes) as
          | { total?: { value?: number; count?: number } }
          | null;
        const percentiles = extractJson(percentilesRes) as
          | { p50?: number | null; p95?: number | null; p99?: number | null; total?: number }
          | null;
        // The actual response of backend GET /v1/account/llm-feature-budget is
        // { budgetUsd, spentUsd, remainingUsd, periodStart, ... }
        // (llmFeatureBudgetHandler.ts readBudget). The old parse read
        // { monthlyLimitUsd, usedUsd }, which do not exist, so the budget
        // warnings (90%/70%) could never fire.
        const budget = extractJson(budgetRes) as
          | { budgetUsd?: number; spentUsd?: number; remainingUsd?: number }
          | null;
        const audit = extractJson(auditRes) as
          | { events?: unknown[] }
          | null;
        const totalCalls = counts?.total?.value ?? 0;
        const errorRate =
          errors?.total?.value !== undefined && errors.total.value !== null
            ? errors.total.value
            : null;
        const costUsd = cost?.total?.value ?? 0;
        const p50 = percentiles?.p50 ?? null;
        const p95 = percentiles?.p95 ?? null;
        const p99 = percentiles?.p99 ?? null;
        const budgetUsed = budget?.spentUsd ?? null;
        const budgetLimit = budget?.budgetUsd ?? null;
        const budgetPercent =
          budgetUsed !== null && budgetLimit !== null && budgetLimit > 0
            ? Math.round((budgetUsed / budgetLimit) * 1000) / 10
            : null;
        const recentEvents = Array.isArray(audit?.events) ? audit.events.length : 0;
        // Note: the backend aggregate_calls error_rate metric is returned as a
        // percent (0-100) (query.ts valueExpr "(...) * 100"), not a fraction
        // (0-1). The thresholds are in percent too: critical = 10% / warn = 3%.
        let summary: "ok" | "warn" | "critical" = "ok";
        if (
          (errorRate !== null && errorRate >= 10) ||
          (budgetPercent !== null && budgetPercent >= 90) ||
          (p95 !== null && p95 >= 10000)
        ) {
          summary = "critical";
        } else if (
          (errorRate !== null && errorRate >= 3) ||
          (budgetPercent !== null && budgetPercent >= 70) ||
          (p95 !== null && p95 >= 3000)
        ) {
          summary = "warn";
        }
        const partialFailures: string[] = [];
        if (countsRes.status !== "fulfilled" || countsRes.value.isError)
          partialFailures.push("counts");
        if (errorRes.status !== "fulfilled" || errorRes.value.isError)
          partialFailures.push("errorRate");
        if (costRes.status !== "fulfilled" || costRes.value.isError)
          partialFailures.push("cost");
        if (percentilesRes.status !== "fulfilled" || percentilesRes.value.isError)
          partialFailures.push("percentiles");
        if (budgetRes.status !== "fulfilled" || budgetRes.value.isError)
          partialFailures.push("budget");
        if (auditRes.status !== "fulfilled" || auditRes.value.isError)
          partialFailures.push("auditLog");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                window,
                totals: { calls: totalCalls, costUsd, errorRate },
                latency: { p50, p95, p99 },
                budget: { used: budgetUsed, limit: budgetLimit, percentUsed: budgetPercent },
                recentEvents,
                summary,
                partialFailures: partialFailures.length > 0 ? partialFailures : undefined,
              }),
            },
          ],
        };
      }
      case "aggregate_calls": {
        const body: Record<string, unknown> = {};
        if (typeof safeArgs["startTime"] === "string") body["startTime"] = safeArgs["startTime"];
        if (typeof safeArgs["endTime"] === "string") body["endTime"] = safeArgs["endTime"];
        if (typeof safeArgs["groupBy"] === "string") body["groupBy"] = safeArgs["groupBy"];
        if (typeof safeArgs["metric"] === "string") body["metric"] = safeArgs["metric"];
        if (typeof safeArgs["provider"] === "string") body["provider"] = safeArgs["provider"];
        if (typeof safeArgs["tagKey"] === "string") body["tagKey"] = safeArgs["tagKey"];
        return await callApi(apiBase, "/v1/query/aggregate", {}, apiKey, {
          method: "POST",
          jsonBody: body,
        });
      }
      case "list_audit_log": {
        const q: Record<string, unknown> = {};
        if (typeof safeArgs["limit"] === "number") q["limit"] = safeArgs["limit"];
        if (typeof safeArgs["eventType"] === "string") q["eventType"] = safeArgs["eventType"];
        if (typeof safeArgs["targetKind"] === "string") q["targetKind"] = safeArgs["targetKind"];
        if (typeof safeArgs["actorUserId"] === "string") q["actorUserId"] = safeArgs["actorUserId"];
        if (typeof safeArgs["from"] === "string") q["from"] = safeArgs["from"];
        if (typeof safeArgs["to"] === "string") q["to"] = safeArgs["to"];
        if (typeof safeArgs["cursor"] === "string") q["cursor"] = safeArgs["cursor"];
        return await callApi(apiBase, "/v1/audit-log", q, apiKey);
      }
      case "list_saved_views": {
        return await callApi(apiBase, "/v1/saved-views", {}, apiKey);
      }
      case "create_saved_view": {
        const name = safeArgs["name"];
        const filter = safeArgs["filter"];
        if (typeof name !== "string" || name.length === 0 || name.length > 80) {
          return errorResponse("name required (1-80 chars)");
        }
        if (!filter || typeof filter !== "object") {
          return errorResponse("filter required (object)");
        }
        return await callApi(apiBase, "/v1/saved-views", {}, apiKey, {
          method: "POST",
          jsonBody: { name, filter },
        });
      }
      case "delete_saved_view": {
        const id = safeArgs["id"];
        if (typeof id !== "string" || id.length === 0 || id.length > 64) {
          return errorResponse("id required (1-64 chars)");
        }
        return await callApi(
          apiBase,
          `/v1/saved-views/${encodeURIComponent(id)}`,
          {},
          apiKey,
          { method: "DELETE" },
        );
      }
      case "export_calls": {
        const body: Record<string, unknown> = {};
        if (typeof safeArgs["startTime"] === "string") body["startTime"] = safeArgs["startTime"];
        if (typeof safeArgs["endTime"] === "string") body["endTime"] = safeArgs["endTime"];
        if (typeof safeArgs["provider"] === "string") body["provider"] = safeArgs["provider"];
        if (typeof safeArgs["model"] === "string") body["model"] = safeArgs["model"];
        if (typeof safeArgs["limit"] === "number") body["limit"] = safeArgs["limit"];
        return await callApi(apiBase, "/v1/query/export", {}, apiKey, {
          method: "POST",
          jsonBody: body,
        });
      }
      case "bulk_delete_calls": {
        const ids = safeArgs["callIds"];
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) {
          return errorResponse(
            "callIds required (non-empty string array, max 100)",
          );
        }
        const strIds: string[] = [];
        for (const id of ids) {
          if (typeof id !== "string" || id.length === 0 || id.length > 128) {
            return errorResponse(
              "each callId must be non-empty string up to 128 chars",
            );
          }
          strIds.push(id);
        }
        const body: Record<string, unknown> = { callIds: strIds };
        if (safeArgs["dryRun"] === true) body["dryRun"] = true;
        const approvalIdRaw = safeArgs["approvalId"];
        if (approvalIdRaw !== undefined) {
          if (
            typeof approvalIdRaw !== "string" ||
            !/^apr_[a-f0-9]{32}$/.test(approvalIdRaw)
          ) {
            return errorResponse("approvalId must be an approval ID (apr_ + 32 hex chars)");
          }
          body["approvalId"] = approvalIdRaw;
        }
        return await callApi(apiBase, "/v1/calls/bulk-delete", {}, apiKey, {
          method: "POST",
          jsonBody: body,
        });
      }
      case "compare_eval_runs": {
        const baselineId = validateAnnotationId(safeArgs["baselineRunId"]);
        const candidateId = validateAnnotationId(safeArgs["candidateRunId"]);
        if (!baselineId || !candidateId) {
          return errorResponse(
            "baselineRunId + candidateRunId required (positive integers up to 10 digits)",
          );
        }
        if (baselineId === candidateId) {
          return errorResponse("baselineRunId and candidateRunId must differ");
        }
        return await callApi(
          apiBase,
          "/v1/eval-runs/compare",
          { baseline: baselineId, candidate: candidateId },
          apiKey,
        );
      }
      case "run_eval": {
        const body: Record<string, unknown> = {};
        if (typeof safeArgs["name"] === "string") body["name"] = safeArgs["name"];
        if (typeof safeArgs["recentCount"] === "number") body["recentCount"] = safeArgs["recentCount"];
        if (typeof safeArgs["label"] === "string") body["label"] = safeArgs["label"];
        if (typeof safeArgs["promptRegistryId"] === "number") body["promptRegistryId"] = safeArgs["promptRegistryId"];
        if (typeof safeArgs["idempotencyKey"] === "string") body["idempotencyKey"] = safeArgs["idempotencyKey"];
        return await callApi(apiBase, "/v1/eval-runs", {}, apiKey, {
          method: "POST",
          jsonBody: body,
        });
      }
      default:
        return errorResponse(`unknown tool: ${name}`);
    }
  } catch (err) {
    return errorResponse(`tool dispatch error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function callApi(
  base: string,
  path: string,
  args: Record<string, unknown>,
  apiKey: string,
  opts?: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    jsonBody?: Record<string, unknown>;
  },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const url = new URL(path, base);
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }

  const method = opts?.method ?? "GET";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "User-Agent": `argosvix-mcp-server/${MCP_VERSION}`,
  };
  const init: RequestInit = {
    method,
    headers,
    redirect: "error",
  };
  if (opts?.jsonBody !== undefined && method !== "GET") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.jsonBody);
  }

  const res = await fetch(url.toString(), init);

  if (!res.ok) {
    // Never expose the backend error body's raw text to the LLM. Details
    // (body / requestId) go to the stderr log; the client gets only status +
    // path (structural defense against leaking internal implementation / PII
    // / internal identifiers).
    // The raw body is logged only when explicitly opted in via
    // ARGOSVIX_MCP_DEBUG=1 (the default leaves no backend-originated
    // sensitive data in production log aggregators; operators enable it via
    // the env var when needed).
    // The 3 fields the backend returns — `error` / `reason` / `actionable` —
    // are user-facing by design (no PII; remediation guidance). The full raw
    // body remains closed off; only these 3 fields are selectively extracted
    // and surfaced to the MCP user.
    const rawBody = await res.text().catch(() => "");
    const requestId = res.headers.get("x-request-id") ?? undefined;
    // eslint-disable-next-line no-console
    console.error(
      `[argosvix-mcp/tools] ${path} -> ${res.status}` +
        (requestId ? ` requestId=${requestId}` : "") +
        (isDebugEnabled() && rawBody ? ` body=${rawBody.slice(0, 300)}` : ""),
    );
    // Selective surface: JSON-parse and extract only the user-facing fields.
    let userNarrative = "";
    if (rawBody) {
      try {
        const parsed = JSON.parse(rawBody) as Record<string, unknown>;
        const errMsg = typeof parsed["error"] === "string" ? parsed["error"] : null;
        const reason = typeof parsed["reason"] === "string" ? parsed["reason"] : null;
        const actionable =
          typeof parsed["actionable"] === "string" ? parsed["actionable"] : null;
        const parts: string[] = [];
        if (errMsg) parts.push(errMsg);
        if (reason) parts.push(`reason=${reason}`);
        if (actionable) parts.push(actionable);
        if (parts.length > 0) {
          userNarrative = ` — ${parts.join(" / ")}`;
        }
      } catch {
        // On JSON parse failure, never surface the raw text (preserves the
        // security posture above).
      }
    }
    return errorResponse(
      `Argosvix API ${path} failed with status ${res.status}` +
        (requestId ? ` (requestId=${requestId})` : "") +
        userNarrative,
    );
  }

  // Handle 204 No Content safely too (e.g. the silence DELETE).
  if (res.status === 204) {
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true, status: 204 }, null, 2) }],
    };
  }
  const json = await res.json();
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(json, null, 2),
      },
    ],
  };
}

/** alertId is validated with the backend regex ([A-Za-z0-9-]{1,64}); path injection defense. */
function validateAlertId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^[A-Za-z0-9-]{1,64}$/.test(value)) return null;
  return value;
}

function validateProposalId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^prp_[a-f0-9]{32}$/.test(value)) return null;
  return value;
}

/**
 * Budget gate id = `bg_` + 32 UUID hex chars, from the backend's
 * budgetGateHandler. The format is pinned as path injection defense.
 */
function validateBudgetGateId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^bg_[a-f0-9]{32}$/.test(value)) return null;
  return value;
}

/** Approval id = `apr_` + 32 UUID hex chars, from the backend's approvalsHandler. */
function validateApprovalId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^apr_[a-f0-9]{32}$/.test(value)) return null;
  return value;
}

/** Policy gate id = `pg_` + 32 UUID hex chars, from the backend's policyGateHandler. */
function validatePolicyGateId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^pg_[a-f0-9]{32}$/.test(value)) return null;
  return value;
}

/**
 * eventId is validated with the backend regex ([A-Za-z0-9_-]{1,64},
 * alert_events.id); path injection defense. Unlike alertId it also accepts _
 * (underscore), supporting both the dashed UUID v4 format and the legacy cuid
 * format.
 */
function validateEventId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) return null;
  return value;
}

/**
 * callId (LLM call id) is validated with the backend regex
 * ([A-Za-z0-9_-]{1,128}); path injection defense. Same shape as
 * query_calls.records[].id.
 */
function validateCallId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) return null;
  return value;
}

/**
 * annotationId is an AUTOINCREMENT integer (1-10 digits). Re-validated with a
 * digits-only regex for path substitution just before the request (structural
 * defense even when the LLM passes a float / string).
 */
function validateAnnotationId(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value < 1e10) {
    return String(value);
  }
  if (typeof value === "string" && /^[1-9]\d{0,9}$/.test(value)) {
    return value;
  }
  return null;
}

/** Outbound webhook id = "owh_" + 24 hex chars (matches the backend's extractId). For path substitution just before the request. */
function validateWebhookId(value: unknown): string | null {
  if (typeof value === "string" && /^owh_[a-f0-9]{24}$/.test(value)) {
    return value;
  }
  return null;
}

/**
 * Annotation labels are validated with the backend regex
 * ([A-Za-z0-9_-]{1,64}); for query-param substitution just before the
 * request. Gates the label arg of list_annotations_by_label.
 */
function validateAnnotationLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) return null;
  return value;
}

/**
 * Converts rangePreset into ISO 8601 startTime/endTime. The backend's
 * `/v1/query/*` requires startTime + endTime in the POST body, so the
 * LLM-friendly presets ("24h" / "7d" / "30d" / "90d") are resolved to
 * wall-clock values here. Missing / invalid values default to "24h".
 */
function presetToTimeRange(value: unknown): {
  startTime: string;
  endTime: string;
} {
  const preset = typeof value === "string" ? value : "24h";
  const HOURS_BY_PRESET: Record<string, number> = {
    "24h": 24,
    "7d": 24 * 7,
    "30d": 24 * 30,
    "90d": 24 * 90,
  };
  const hours = HOURS_BY_PRESET[preset] ?? 24;
  const now = Date.now();
  return {
    startTime: new Date(now - hours * 3600 * 1000).toISOString(),
    endTime: new Date(now).toISOString(),
  };
}

function errorResponse(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
