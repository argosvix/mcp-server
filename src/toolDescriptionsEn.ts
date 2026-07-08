/**
 * MCP tool / resource / prompt 説明の英語オーバーレイ (= 2026-07-03)。
 *
 * 正本は tools.ts / resources.ts / prompts.ts の日本語 description。本ファイルは
 * ツール名 → 英訳 のマップだけを持ち、 tools/list 等の応答時に lang=en なら
 * deep copy へ適用する (= 元オブジェクトは汚さない)。
 *
 * 言語解決 = 環境変数 ARGOSVIX_MCP_LANG ("ja" | "en")。未設定・不明値は en
 * (= 国際標準に合わせる。 日本語で使う場合のみ ja を明示)。
 *
 * inputs の key は inputSchema の properties への dot 区切り path。
 * 配列は items を透過的に降りる (= 例 "items.inputText" は
 * properties.items.items.properties.inputText を指す)。
 * drift 防御 = toolDescriptionsEn.test.ts が「実スキーマの description 持ち
 * フィールド全部 ⇔ オーバーレイの inputs キー全部」の集合一致を assert する。
 */

import type {
  Prompt,
  Resource,
  ResourceTemplate,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

export type McpLang = "ja" | "en";

/** ARGOSVIX_MCP_LANG の解釈。 ja のみ ja、 それ以外 (未設定含む) は en。 */
export function resolveMcpLang(raw: string | undefined): McpLang {
  if (raw === "ja") return "ja";
  if (raw !== undefined && raw !== "" && raw !== "en") {
    // eslint-disable-next-line no-console
    console.error(
      `[argosvix-mcp] unknown ARGOSVIX_MCP_LANG "${raw}" — falling back to "en" (valid: ja | en)`,
    );
  }
  return "en";
}

export interface ToolOverlayEn {
  description: string;
  /** inputSchema の description 持ちフィールドの英訳 (= dot path → 英文)。 */
  inputs?: Record<string, string>;
}

export const TOOL_DESCRIPTIONS_EN: Record<string, ToolOverlayEn> = {
  query_calls: {
    description:
      "Retrieve recent LLM call records captured by Argosvix. " +
      "Filterable by provider / model / time range / tag. Defaults to the last 24 hours, 100 records.",
    inputs: {
      limit: "Number of records to return (1-500, default 100)",
      provider: "Provider to filter by (openai / anthropic / gemini / mistral). Omit for all providers",
      model: "Model name to filter by (substring match). Omit for all models",
      rangePreset: "Time range preset. Default 24h",
      latencyMin: "Lower bound on response latency (ms, >= 0). For outlier drill-down (e.g. \"only calls over 2 seconds\")",
      latencyMax: "Upper bound on response latency (ms, >= 0). Combine with latencyMin for a range",
      beforeTimestamp:
        "Keyset pagination cursor (timestamp of the last row on the previous page, ISO-8601). Must be used together with beforeId. Descending timestamp order only",
      beforeId: "Keyset pagination cursor (id of the last row on the previous page). Must be used together with beforeTimestamp",
    },
  },
  get_cost_summary: {
    description:
      "Return cost / call count / token aggregates per time range, with a per-provider breakdown. " +
      "When groupBy=\"none\" is specified, a per-provider breakdown is still returned for backend compatibility " +
      "(check the response.total field for the overall sum).",
    inputs: {
      rangePreset: "Aggregation range. Default 7d",
      groupBy: "Aggregation axis (overall sum / per provider / per model). Default provider",
    },
  },
  list_alerts: {
    description:
      "Return the list of configured alerts plus trigger history within the last 24 hours.",
    inputs: {
      includeTriggered: "true = include trigger history (triggered_at within the last 24h)",
    },
  },
  list_proposals: {
    description:
      "Return the unresolved improvement proposals found by the Argosvix guardian (quality drift / reliability anomalies / cost switching / safety / silencing noisy alerts). Approving, dismissing, and executing happen in the dashboard inbox (agents can only read and converse).",
  },
  get_proposal_thread: {
    description:
      "Return the thread for a proposal (the questions asked so far and the AI's replies). Get proposalId from list_proposals.",
    inputs: {
      proposalId: "Target proposal ID (from list_proposals, starts with prp_)",
    },
  },
  reply_proposal: {
    description:
      "Post a question about a proposal and get the AI's reply (same as the inbox conversation). Explanation only — nothing is executed. Get proposalId from list_proposals.",
    inputs: {
      proposalId: "Target proposal ID (from list_proposals)",
      body: "Question about the proposal (e.g. why did it degrade? should we fix it?)",
    },
  },
  silence_alert: {
    description:
      "Temporarily mute an alert (stops notification delivery). Defaults to 24 hours; pass an ISO-8601 timestamp as until for a custom expiry. Pass the alertId obtained from list_alerts.",
    inputs: {
      alertId: "Target alert ID (from list_alerts)",
      until: "Unmute time in ISO-8601 (e.g. 2026-06-01T00:00:00Z). Omit for 24 hours from now",
    },
  },
  unsilence_alert: {
    description: "Unmute a currently silenced alert.",
    inputs: {
      alertId: "Target alert ID",
    },
  },
  create_alert: {
    description:
      "Create a new alert rule. Watches for cost / error rate / latency / anomaly threshold breaches and " +
      "notifies the specified channels. Example: \"notify me by email when daily cost exceeds $10\". " +
      "channelKinds is an array of channel kinds to enable; channelTargets is an object keyed by those kinds holding the destinations " +
      "(e.g. channelKinds:[\"email\"], channelTargets:{\"email\":\"dev@example.com\"}). Every kind listed in channelKinds must have a destination in channelTargets. " +
      "anomaly_* types interpret thresholdValue as a standard-deviation multiplier (0.5-10, e.g. 3 = 3 sigma). " +
      "The Free plan allows the email channel only and up to 3 alerts (the backend returns 403 beyond that).",
    inputs: {
      name: "Display name of the alert (1-100 chars, no line breaks)",
      alertType:
        "Metric to watch. cost_threshold = one-shot cost threshold (USD) / monthly_budget = monthly budget (USD) / " +
        "error_rate = error rate (%) / latency_degradation = latency degradation (ms) / " +
        "anomaly_cost / anomaly_latency / anomaly_error_rate = anomaly detection (windowMinutes is fixed at 60) / " +
        "eval_score = quality SLO (evalCriterionId required; fires when the mean score in the recent window drops below thresholdValue) / " +
        "guardian_findings = external notification of findings (notifies new inbox findings; thresholdValue / windowMinutes are unused — pass 0 and 60)",
      thresholdValue:
        "Threshold (>= 0). USD for cost types, % for error_rate, ms for latency_degradation. " +
        "For anomaly types, a standard-deviation multiplier (e.g. 3 = 3 sigma)",
      windowMinutes: "Aggregation window (minutes, 5-43200). Default 60. Ignored for anomaly types (fixed at 60).",
      filterProvider: "Restrict to this provider only (openai / anthropic / gemini / mistral). Omit for all providers",
      filterModel: "Restrict to this model name only (substring match). Omit for all models",
      channelKinds:
        "Array of notification channel kinds to enable (each kind needs a destination under the same key in channelTargets). " +
        "The Free plan can use email only.",
      channelTargets:
        "Object keyed by channel kind with the destination as the value (must include a destination for every kind listed in channelKinds). " +
        "Example: {\"email\": \"dev@example.com\"}. email takes an email address; " +
        "slack/discord/teams/webhook take the service's webhook URL.",
      "channelTargets.email": "Notification email address",
      "channelTargets.slack": "Slack Incoming Webhook URL (https://hooks.slack.com/services/...)",
      "channelTargets.webhook": "Generic webhook URL (https)",
      "channelTargets.discord": "Discord webhook URL (https://discord.com/api/webhooks/...)",
      "channelTargets.teams": "Microsoft Teams Incoming Webhook URL",
      sleepMinutes:
        "Suppression window for repeated notifications (minutes, 5-10080). After firing once, no re-notification during this window. Default 60.",
      enabled: "Whether to enable immediately after creation. Default true.",
      evalCriterionId:
        "Required when alertType=eval_score. The id of the eval criterion to watch (list_eval_criteria.criteria[].id). Fires when the mean score in the recent window drops below thresholdValue.",
      conditions:
        "v1.5 multi-condition alert (composite conditions). When specified, single-metric evaluation via alertType + thresholdValue + " +
        "windowMinutes is ignored and the conditions JSON switches to AND/OR aggregation. " +
        "Example: {\"operator\":\"AND\",\"conditions\":[{\"metric\":\"cost_threshold\",\"threshold\":100,\"windowMinutes\":60,\"comparator\":\">\"},{\"metric\":\"error_rate\",\"threshold\":0.05,\"windowMinutes\":60,\"comparator\":\">\"}]}." +
        " The backend validates the shape via parseConditionsJson (operator AND/OR, 1-8 conditions, each requiring metric/threshold/windowMinutes/comparator). Omit (null) to stay on the single-metric path.",
      "conditions.operator":
        "Aggregation operator for the composite condition. AND = triggers when all sub-conditions pass; OR = triggers when at least one passes.",
      "conditions.conditions": "1-8 sub-conditions. More than 8 is rejected by the backend with 400.",
      "conditions.conditions.metric":
        "Target metric (same enum values as alertType: cost_threshold / error_rate / latency_p95 etc.)",
      "conditions.conditions.threshold":
        "Threshold (unit depends on the metric: USD for cost, % for error_rate, ms for latency).",
      "conditions.conditions.windowMinutes": "Aggregation window (minutes, 5-43200). Independent per sub-condition.",
      "conditions.conditions.comparator": "Comparison operator against the threshold.",
    },
  },
  update_alert: {
    description:
      "Update an existing alert's settings (PATCH /v1/alerts/:id). alertType (the watched metric type) is immutable — " +
      "to change it, create a new alert and then delete the old one (completing the alert lifecycle). " +
      "Threshold / evaluation window / notification channels / name / enabled flag / composite conditions can be partially updated (all fields optional). " +
      "Example phrasing: \"lower the monthly budget alert threshold from $100 to $50\" / \"add Slack as a notification channel\".",
    inputs: {
      alertId: "Target alert ID (from list_alerts)",
      name: "Display name of the alert (1-100 chars, no line breaks). Omit to keep the current value",
      thresholdValue: "Threshold (>= 0). Omit to keep the current value",
      windowMinutes: "Aggregation window (minutes, 5-43200). Omit to keep the current value",
      filterProvider: "Target provider. Omit to keep the current value; pass an explicit null to reset to all providers",
      filterModel: "Target model (substring match). Omit to keep the current value; pass an explicit null to reset to all models",
      channelKinds: "Notification channel kinds to enable. Omit to keep the current value. Updating together with channelTargets is recommended",
      channelTargets: "Destination object for every kind listed in channelKinds. Omit to keep the current value",
      "channelTargets.email": "Notification email address",
      "channelTargets.slack": "Slack Incoming Webhook URL",
      "channelTargets.webhook": "Generic webhook URL (https)",
      "channelTargets.discord": "Discord webhook URL",
      "channelTargets.teams": "Microsoft Teams Incoming Webhook URL",
      sleepMinutes: "Suppression window for repeated notifications (minutes, 5-10080). Omit to keep the current value",
      enabled: "Alert enabled flag. false pauses evaluation (unlike silence, re-enabling requires another PATCH)",
      conditions:
        "Update of the v1.5 multi-condition alert. When specified, the single-metric path is ignored in favor of " +
        "AND/OR aggregation. Can overwrite either an existing single-metric or multi-condition alert.",
    },
  },
  delete_alert: {
    description:
      "Delete an alert (DELETE /v1/alerts/:id). Related alert_events are CASCADE-deleted too. " +
      "To guard against accidental deletion, checking the details with get_alert first is recommended. " +
      "If you only want to pause an alert, prefer silence_alert (mute) or update_alert with " +
      "enabled=false instead of delete (both are recoverable).",
    inputs: {
      alertId: "Target alert ID (from list_alerts)",
    },
  },
  get_alert: {
    description:
      "Return the detailed configuration of an alert and its recent trigger history. Pass the alertId obtained from list_alerts. " +
      "Use it to check the threshold / notification channels / silence state / when it fired.",
    inputs: {
      alertId: "Target alert ID (from list_alerts)",
    },
  },
  list_alert_events: {
    description:
      "Return alert trigger events, newest first. Account-wide (recent firings of all alerts) by " +
      "default; pass alertId to narrow to one alert. Use for questions like \"which alerts fired recently and how often?\" " +
      "or \"when did the cost alert go off?\". Each event's id can be passed directly to the acknowledge_alert " +
      "tool. acknowledgedAt / acknowledgedBy are null if not yet acknowledged. " +
      "Each event includes a snapshot of thresholdValue / windowMinutes / alertType at firing time " +
      "(so the firing-time conditions survive later rule edits). For the next page, pass the last event's " +
      "triggeredAt + id as beforeTriggeredAt + beforeId (keyset cursor).",
    inputs: {
      limit: "Number of events to return (1-100, default 20)",
      alertId: "ID to narrow to a specific alert. Omit for all alerts' trigger history",
      beforeTriggeredAt: "Pagination cursor (triggeredAt of the last event on the previous page). Must be passed together with beforeId",
      beforeId: "Pagination cursor (id of the last event on the previous page). Must be passed together with beforeTriggeredAt",
    },
  },
  acknowledge_alert: {
    description:
      "Mark an individual alert firing (event) as handled / acknowledged. Unlike silence_alert (which temporarily " +
      "mutes the whole alert rule), ack is a per-event receipt — future firings of the same rule are still " +
      "delivered as usual. Pass the id obtained from list_alert_events as eventId. Re-acking an already acknowledged event " +
      "does not overwrite the existing ack info (the first acknowledgedAt / acknowledgedBy) and " +
      "returns 200 (idempotent; distinguishable via the alreadyAcknowledged flag).",
    inputs: {
      eventId: "Event id to acknowledge (list_alert_events.events[].id)",
    },
  },
  list_annotations_for_call: {
    description:
      "Return the annotations attached to an LLM call (records[].id from query_calls). " +
      "An annotation is a user-authored evaluation (rating / comment / label); each annotation includes " +
      "annotationText / label / qualityScore / createdAt / updatedAt. " +
      "Use to check whether a call has human review attached or what past reviews said. " +
      "Independent of the Pro+ plaintext feature (annotations work without plaintext storage enabled).",
    inputs: {
      callId: "Target call id (query_calls.records[].id)",
    },
  },
  list_annotations_by_label: {
    description:
      "Return annotations carrying the given label, newest first (account-wide, up to 100). " +
      "Use for things like collecting calls rated \"good\" or listing human reviews labeled \"bug\". " +
      "Labels are ASCII letters / digits / underscore / hyphen only ([a-zA-Z0-9_-], up to 64 chars).",
    inputs: {
      label: "Target label (exact match with the label set at annotation creation)",
      limit: "Number of annotations to return (1-100, default 20)",
    },
  },
  get_annotation: {
    description:
      "Fetch one annotation by id (obtained from list_annotations_*). " +
      "Includes annotationText / label / qualityScore / callId / createdAt / updatedAt / createdByUserId. " +
      "Ids belonging to other accounts return 404 (structural defense).",
    inputs: {
      annotationId: "Target annotation id (AUTOINCREMENT integer)",
    },
  },
  create_annotation: {
    description:
      "Create a new annotation (human review / labeling) for an LLM call. " +
      "Specify at least one of annotationText / label / qualityScore (an \"empty annotation\" gets 400 from the backend). " +
      "Example phrasing: \"Claude, label this call 'badly-summarized' with quality 2\", or " +
      "bulk-apply positive / negative labels for an eval loop. " +
      "Combined with the eval baseline runner (run_eval), annotations can calibrate eval criteria as ground truth.",
    inputs: {
      callId: "Target call id (query_calls.records[].id)",
      annotationText: "Free-form comment (0-2000 chars). Length is validated by the backend",
      label: "Label (0-50 chars, alphanumerics plus _ - only). Usable as a dashboard filter",
      qualityScore: "Quality score (integer 1-5). Omit for NULL",
    },
  },
  update_annotation: {
    description:
      "Partially update an annotation's annotationText / label / qualityScore (PATCH /v1/annotations/:id). " +
      "callId is immutable. For fixing a label or re-scoring quality from 4 to 5, etc. " +
      "Pass annotations[].id obtained from list_annotations_for_call as annotationId.",
    inputs: {
      annotationId: "Target annotation id (AUTOINCREMENT integer)",
      annotationText: "New comment (0-2000 chars). Omit to keep the current value",
      label: "New label (0-50 chars, alphanumerics plus _ - only). Omit to keep the current value",
      qualityScore: "New quality score (1-5). Omit to keep the current value",
    },
  },
  delete_annotation: {
    description:
      "Delete an annotation (DELETE /v1/annotations/:id). No other rows depend on it, so there is no CASCADE impact. " +
      "To guard against accidental deletion, checking the details with get_annotation first is recommended.",
    inputs: {
      annotationId: "Target annotation id (AUTOINCREMENT integer)",
    },
  },
  list_eval_criteria: {
    description:
      "Return the list of LLM-as-judge evaluation criteria. Includes the 5 global defaults " +
      "(helpfulness / accuracy / relevance / safety / conciseness) plus the custom criteria created in your " +
      "account. Each criterion has id / name / rubric (the instruction text for the judge) / scaleMin / scaleMax. " +
      "Use before running an eval to see which axes are available. The Free plan can read all criteria " +
      "(creating custom ones is Pro+ only, but existing rows stay visible after downgrade).",
  },
  get_eval_criterion: {
    description:
      "Fetch one criterion's detail (name / rubric / scaleMin / scaleMax / createdAt) by id. " +
      "The id comes from list_eval_criteria.criteria[].id. Both global defaults (accountId NULL) and " +
      "your account's custom criteria are accepted; other accounts' customs return 404 (structural defense).",
    inputs: {
      criterionId: "Target criterion id (AUTOINCREMENT integer)",
    },
  },
  create_eval_criterion: {
    description:
      "Create one custom eval criterion in your account (Pro+ only). " +
      "name + rubric + scaleMin + scaleMax are required. Same name already existing in the account = 409. " +
      "A name matching a global default is structurally allowed (UNIQUE (account_id, name) separates it from account_id IS NULL). " +
      "type defaults to 'llm_judge' (judge LLM scoring). Specifying a deterministic evaluator type (exact_match / contains / regex / json_schema / json_path) " +
      "scores without calling an LLM — free and instant (pass -> scaleMax / fail -> scaleMin). Deterministic types require config. " +
      "The path an AI agent takes when it decides \"add this criterion\" during dogfood evals.",
    inputs: {
      name: "Criterion name (1-50 chars, starts with an alphanumeric, [A-Za-z0-9 _\\-.] only). E.g. 'helpfulness' / 'concise'",
      rubric:
        "Scoring rubric text (10-2000 chars; the narrative the judge LLM bases scores on. Required as a human-readable explanation even for deterministic evaluators)",
      scaleMin: "Score lower bound (1-100, must be less than scaleMax)",
      scaleMax: "Score upper bound (1-100, must be greater than scaleMin)",
      type:
        "Evaluator type (default 'llm_judge'). Deterministic evaluators score without an LLM call — free and instant: " +
        "'exact_match' / 'contains' / 'regex' / 'json_schema' / 'json_path'",
      config:
        "Type-specific settings (not needed for llm_judge). exact_match: {expectedOutput}, " +
        "contains: {substring, caseSensitive?}, regex: {pattern, flags?}, " +
        "json_schema: {schema}, json_path: {path, expectedValue?}. " +
        "Categorical scoring also requires config.categories (2-10 entries, worst to best).",
      scoreType:
        "Scoring type (default numeric). boolean = pass/fail; categorical requires config.categories (llm_judge only)",
      scope:
        "Evaluation scope (default call). call = per call; trajectory = scores multiple calls + steps in the same trace as one trajectory (llm_judge only)",
    },
  },
  update_eval_criterion: {
    description:
      "Update a custom criterion in your account with a full replace (Pro+ only, PATCH /v1/eval-criteria/:id). " +
      "name + rubric + scaleMin + scaleMax are required (not a partial update — all fields are overwritten). " +
      "type / config are also fully replaced (omitting them reverts to 'llm_judge' / no config). Deterministic types require config. " +
      "Global defaults (account_id IS NULL) are structurally out of scope (404); other accounts' customs are 404 too. " +
      "Name collision within the account = 409.",
    inputs: {
      criterionId: "Target criterion id (list_eval_criteria.criteria[].id)",
      name: "New name (1-50 chars, starts with an alphanumeric, [A-Za-z0-9 _\\-.] only)",
      rubric: "New rubric (10-2000 chars)",
      scaleMin: "New scaleMin (1-100, less than scaleMax)",
      scaleMax: "New scaleMax (1-100, greater than scaleMin)",
      type:
        "Evaluator type (defaults to 'llm_judge' when omitted). Deterministic: 'exact_match' / 'contains' / 'regex' / 'json_schema' / 'json_path'",
      config:
        "Type-specific settings (not needed for llm_judge). exact_match: {expectedOutput}, " +
        "contains: {substring, caseSensitive?}, regex: {pattern, flags?}, " +
        "json_schema: {schema}, json_path: {path, expectedValue?}. " +
        "Categorical scoring also requires config.categories (2-10 entries, worst to best).",
      scoreType:
        "Scoring type (default numeric). boolean = pass/fail; categorical requires config.categories (llm_judge only)",
      scope: "Evaluation scope (default call). call = per call; trajectory = per trajectory (llm_judge only)",
    },
  },
  get_llm_budget: {
    description:
      "Get the current monthly LLM feature budget (the LLM cost cap covering the 3 axes: safety classifier + secondary PII audit + eval baseline runner). " +
      "Response = { budgetUsd, spentUsd, remainingUsd, periodStart, defaultBudgetUsd, minBudgetUsd, maxBudgetUsd }. " +
      "Readable on Free and Pro+ alike; used when an AI agent decides \"have we hit 80% of budget?\" / \"should we raise it?\". " +
      "Default $5/month; auto-resets at month boundaries (per YYYY-MM).",
  },
  raise_llm_budget: {
    description:
      "Raise or lower the monthly LLM feature budget (Pro+ only). " +
      "Range $5 - $500 (hard cap against runaway spend), in $0.01 increments. Existing spend carries over; auto-resets at month boundaries. " +
      "Example phrasing: \"we hit 80% of the budget — raise it to $30 just for this month\" / \"we overspent — lower next month to $10\". " +
      "A new value below current spend is accepted (remaining simply becomes 0; counting restarts from 0 next month).",
    inputs: {
      budgetUsd: "New monthly budget in USD (5-500, $0.01 increments). E.g. 30 / 50.5 / 100",
    },
  },
  get_budget_gate: {
    description:
      "Get the runtime budget gate settings (runtime control plane Phase 1) plus this month's LLM spend. " +
      "Response = { gates: [{ id, projectId, monthlyLimitUsd, enforceMode, enabled, ... }], spentUsdThisMonth, monthStart, ttlSeconds }. monthStart is the UTC month start. " +
      "The same source the SDK's budgetGate opt-in evaluates before execution. Distinct from get_llm_budget (which caps Argosvix's internal AI feature costs) — this one is a monthly cap on your own LLM spend. " +
      "Example phrasing: \"how much budget gate headroom is left this month?\" / \"is the gate set to fail_open?\"",
  },
  create_budget_gate: {
    description:
      "Create a runtime budget gate (Pro+ only). Sets a monthly LLM spend limit (USD) for the account; the SDK (budgetGate opt-in) blocks over-limit calls before execution. " +
      "Enforcement is optimistic (spend is cached for 60 seconds and in-flight calls pass, so the limit is a guideline that can be exceeded, not a strict hard cap). " +
      "enforceMode = fail_open (default; calls pass when the backend is unreachable) / fail_closed (calls are blocked when unreachable; a cold start where the SDK has never fetched the config additionally requires the SDK-side failClosed opt-in). " +
      "Omitting projectId = an account-wide gate (only one; 409 if one exists). Specifying projectId = a gate for that project only (ANDed with the account gate — the strictest limit wins; one per project). " +
      "Specifying tagKey + tagValue = a gate for calls carrying that tag (e.g. tagKey=service / tagValue=checkout caps the monthly spend of service=checkout. ANDed with the account gate; one per (tagKey,tagValue)). tagKey/tagValue must be specified together and are mutually exclusive with projectId. " +
      "Example phrasing: \"create a budget gate at $50/month\" / \"cap project X at $10/month\" / \"cap the service=checkout tag at $20/month\"",
    inputs: {
      monthlyLimitUsd: "Monthly limit in USD (0.01 - 1000000, $0.01 increments). E.g. 50 / 100.5",
      enforceMode: "Behavior when the backend is unreachable (default fail_open)",
      enabled: "Whether the gate is enabled (default true)",
      projectId: "proj_-style project ID (omit for an account-wide gate). The project must belong to your account and not be archived",
      tagKey: "Tag key for a per-tag gate (e.g. service). Must be specified together with tagValue; mutually exclusive with projectId. 1-128 chars",
      tagValue: "Tag value for a per-tag gate (e.g. checkout). Must be specified together with tagKey. 1-128 chars",
    },
  },
  update_budget_gate: {
    description:
      "Update a runtime budget gate (Pro+ only). Partially updates any of monthlyLimitUsd / enforceMode / enabled. " +
      "Example phrasing: \"raise the limit to $100\" / \"disable the gate temporarily\" / \"switch to fail_closed\"",
    inputs: {
      gateId: "Target gate id (from get_budget_gate, starts with bg_)",
      monthlyLimitUsd: "New monthly limit in USD (0.01 - 1000000, $0.01 increments)",
      enforceMode: "Behavior when the backend is unreachable",
      enabled: "Whether the gate is enabled",
    },
  },
  delete_budget_gate: {
    description:
      "Delete a runtime budget gate (Pro+ only). After deletion the SDK's pre-execution enforcement is disabled. To pause temporarily, prefer update_budget_gate with enabled: false.",
    inputs: {
      gateId: "Target gate id (from get_budget_gate, starts with bg_)",
    },
  },
  request_approval: {
    description:
      "Create an approval request in the human approval gate (runtime control plane Phase 3; Pro+ only). Call it before dangerous operations (deletion / money transfer / account closure etc.); the account owner gets an email notification and a human approves or denies via the dashboard or the email link. " +
      "Important: no MCP tool exists to approve or deny (an AI agent cannot self-approve its own request). Poll the result with get_approval. " +
      "Expiry after timeoutSeconds (default 3600) counts as denied. " +
      "Server-side consumption: passing approvalId to a dangerous mutation tool (bulk_delete_calls / purge_expired_plaintext / retry_failed_webhook / auto_silence_noisy_alert / extend_customer_trial / apply_promo_code_to_customer) makes the backend verify action match + approved + within expiry + unconsumed, and consume it on execution (1 approval = 1 execution). In that case create the request with an action exactly matching the target tool name. " +
      "Example phrasing: \"deleting user usr_123 is a dangerous operation — get human approval first\"",
    inputs: {
      action: "Operation identifier (1-128 chars; alphanumerics, ._:-, and spaces). E.g. delete_user",
      summary: "One-line human-readable description (1-500 chars; appears verbatim in the approval email)",
      metadata: "Supplementary JSON object (up to 4KB, optional)",
      timeoutSeconds: "Approval deadline in seconds (60-86400, default 3600)",
    },
  },
  get_approval: {
    description:
      "Get the current state of an approval request. status = pending / approved / denied / expired. Do not perform the target operation unless the status is approved (default-deny). Dangerous mutation tools also support server-side consumption via their approvalId param (see the request_approval description).",
    inputs: {
      approvalId: "The id returned by request_approval (starts with apr_)",
    },
  },
  list_approvals: {
    description:
      "List approval requests (latest 50). status filter = pending (default) / approved / denied / expired / all.",
    inputs: {
      status: "Status filter (default pending)",
    },
  },
  get_policy_gate: {
    description:
      "Get the runtime policy gate settings (runtime control plane Phase 2). " +
      "Response = { policy: { id, modelAllowlist, blockPii, blockSecrets, enforceMode, enabled, ... } | null }. " +
      "The config the SDK's policyGate opt-in evaluates locally before each LLM call (exact-match model allowlist + blocking on PII / secret detection). " +
      "Example phrasing: \"what model restrictions are active right now?\" / \"is PII blocking enabled?\"",
  },
  create_policy_gate: {
    description:
      "Create a runtime policy gate (Pro+ only). Configures an account-wide model allowlist / PII block / secret block; the SDK (policyGate opt-in) blocks violating calls before execution. " +
      "At least one rule (modelAllowlist / blockPii / blockSecrets) is required. One per account (409 if one exists). A redact mode is not supported (block only). " +
      "Example phrasing: \"only allow gpt-5.5 and claude-fable-5\" / \"block calls containing PII\"",
    inputs: {
      modelAllowlist: "Array of allowed model names (1-100 entries, exact match). Omit = no model restriction",
      blockPii:
        "Block on PII detection. Coverage = email / card numbers (Luhn-verified) / delimited phone numbers / delimited national ID numbers / IPv4 / IPv6 (full and common compressed forms). Undelimited digit runs for phone / national ID numbers are excluded to avoid false blocking",
      blockSecrets: "Block on detection of API-key / private-key-like tokens",
      enforceMode: "Behavior when the backend is unreachable (default fail_open)",
      enabled: "Whether the gate is enabled (default true)",
    },
  },
  update_policy_gate: {
    description:
      "Update a runtime policy gate (Pro+ only). Partially updates modelAllowlist (null clears the restriction) / blockPii / blockSecrets / enforceMode / enabled. " +
      "Example phrasing: \"add gpt-4o-mini to the allowlist\" / \"enable secret blocking\"",
    inputs: {
      policyId: "Target policy id (from get_policy_gate, starts with pg_)",
      modelAllowlist: "New allowlist (null clears the model restriction)",
    },
  },
  delete_policy_gate: {
    description:
      "Delete a runtime policy gate (Pro+ only). To pause temporarily, prefer update_policy_gate with enabled: false.",
    inputs: {
      policyId: "Target policy id (from get_policy_gate, starts with pg_)",
    },
  },
  test_webhook: {
    description:
      "Send one fabricated alert to the given URL as a test delivery (Pro+ only). " +
      "Main use: checking that a webhook URL is reachable before registering it. " +
      "SSRF defense requires https and rejects private / loopback / cloud-metadata IPs. " +
      "When secret is provided, an HMAC-SHA256 signature (X-Argosvix-Signature) is attached. " +
      "Rate limit = 5/min per account (60s sliding window; may be exceeded across worker instances). " +
      "response.delivered = whether the receiver returned 2xx within 5s; false means an invalid URL / timeout / 5xx / network error.",
    inputs: {
      url: "Destination webhook URL (https, SSRF-guarded, 1-500 chars)",
      secret: "Secret for the HMAC-SHA256 signature (optional, 1-256 chars; verify X-Argosvix-Signature on the receiver side)",
      alertName: "Name for the fabricated alert (optional, 1-64 chars, [A-Za-z0-9 _\\-.] only). Defaults to 'argosvix test alert'",
    },
  },
  delete_eval_criterion: {
    description:
      "Delete a custom criterion in your account (Pro+ only, DELETE /v1/eval-criteria/:id, 204). " +
      "Global defaults (account_id IS NULL) are structurally out of scope = 404; other accounts are 404 too. " +
      "WARNING: all past eval_run score rows for this criterion (eval_scores) are physically deleted at the same time via ON DELETE CASCADE — " +
      "historical comparisons and score trend analysis become permanently impossible. " +
      "This is not a tool for an AI agent to call casually while tidying up criteria; only proceed when the user has explicitly confirmed the past run scores are not needed. " +
      "If you only want to rename, using update_eval_criterion (full replace) with name + rubric + scaleMin + scaleMax preserves the history.",
    inputs: {
      criterionId: "Target criterion id (list_eval_criteria.criteria[].id)",
    },
  },
  list_webhooks: {
    description:
      "List the registered outbound event webhooks (GET /v1/webhooks). Each webhook includes " +
      "id / url / hasSecret / enabled / eventTypes / lastStatus / consecutiveFailures etc. " +
      "(the secret itself is never returned). This is the subscription surface that notifies external endpoints of " +
      "account events (approval requests, proposal execution / reversal) via signed POSTs. Readable on Free.",
  },
  create_webhook: {
    description:
      "Register one outbound event webhook (Pro+ only, POST /v1/webhooks). " +
      "url (HTTPS required; SSRF defense rejects private/loopback) + optional secret (HMAC-SHA256 signing key) + " +
      "eventTypes (array of event kinds to subscribe to; omitted / empty = subscribe to everything). Up to 10 per account. " +
      "Delivery payload = { event, eventId, occurredAt, accountId, data }; with a secret set, an X-Argosvix-Signature header is attached.",
    inputs: {
      url: "Destination URL (HTTPS required; private/loopback hosts are rejected)",
      secret: "Optional. HMAC-SHA256 signing key (when set, X-Argosvix-Signature is attached)",
      eventTypes:
        "Array of event kinds to subscribe to (omitted / empty array = all events). Available: approval.requested / proposal.executed / proposal.reversed",
      description: "Display memo (optional, up to 200 chars)",
      enabled: "Enabled flag (default true)",
    },
  },
  update_webhook: {
    description:
      "Partially update an outbound event webhook (Pro+ only, PATCH /v1/webhooks/:id). " +
      "Only the specified fields change (url / secret / eventTypes / description / enabled). " +
      "Sending secret as null removes the signature; re-enabling with enabled=true also resets the consecutive-failure counter. " +
      "Other accounts' webhooks return 404. webhookId is the id from list_webhooks.",
    inputs: {
      webhookId: "Target webhook id (owh_...)",
      url: "New URL (HTTPS required)",
      secret: "New secret (empty / null removes it)",
      eventTypes: "Array of subscribed event kinds (empty = all)",
      description: "Display memo",
      enabled: "Enabled flag",
    },
  },
  delete_webhook: {
    description:
      "Delete an outbound event webhook (Pro+ only, DELETE /v1/webhooks/:id). " +
      "Other accounts' webhooks return 404. webhookId is the id from list_webhooks.",
    inputs: {
      webhookId: "Target webhook id (owh_...)",
    },
  },
  list_prompts: {
    description:
      "List the prompt templates the user has registered. " +
      "Each prompt includes id / name / version / template / variables / labels / description / createdAt. " +
      "Filter by a label such as \"production\" (?label=xxx), or fetch all versions of one name " +
      "(?name=xxx). Up to 200 entries; sort = name ASC + created_at DESC. The main path for an AI agent to " +
      "read and use prompts the user registered in the dashboard.",
    inputs: {
      label: "Label filter (e.g. 'production' / 'staging' / 'experiment'). Exact match.",
      name: "Name filter (fetches all versions of that name). Exact match.",
      limit: "Number of prompts to return (1-200, default 200)",
    },
  },
  get_prompt: {
    description:
      "Fetch one prompt's detail by id. Use prompts[].id from list_prompts as-is. " +
      "Includes template + variables + labels + description; scoped to your account (structurally enforced by a backend WHERE clause — other accounts' ids return 404). " +
      "Same endpoint as the argosvix://prompts/{id} resource template.",
    inputs: {
      promptId: "Target prompt id (AUTOINCREMENT integer)",
    },
  },
  create_prompt: {
    description:
      "Register one new prompt template (Pro+ only). name + version + template are required; " +
      "variables / labels / description are optional. An existing (name, version) pair returns 409 (UNIQUE constraint). " +
      "Used when an AI agent auto-registers templates for dogfood evals / experiments.",
    inputs: {
      name: "Prompt name (series identifier, [A-Za-z0-9][A-Za-z0-9_-]{0,63}). E.g. 'customer_support'",
      version: "Version identifier ([A-Za-z0-9][A-Za-z0-9._-]{0,63}). E.g. 'v1' / '1.0.2' / '2026-06-03'",
      template: "Prompt body (non-empty, up to 50000 chars). {{var}} placeholders are filled from variables.",
      variables: "Default values for {{var}} placeholders in the template (plain object, 4096 bytes max after JSON serialization). Optional.",
      labels: "Array of labels (up to 8, each [A-Za-z0-9][A-Za-z0-9_-]{0,31}). E.g. ['production', 'staging'].",
      description: "Description (up to 500 chars). Optional.",
    },
  },
  update_prompt: {
    description:
      "Partially update an existing prompt's template / variables / labels / description (Pro+ only, PATCH /v1/prompts/:id). " +
      "name + version are immutable (change them via rename_prompt). promptId is required; only the fields you pass are updated. " +
      "Used by AI agents for label moves (promoting 'staging' to 'production') and small patch edits.",
    inputs: {
      promptId: "Target prompt id (list_prompts.prompts[].id)",
      template: "New template body (non-empty, up to 50000 chars).",
      variables: "New variables (plain object; null clears them all).",
      labels: "New labels (full replacement, up to 8, each [A-Za-z0-9][A-Za-z0-9_-]{0,31}).",
      description:
        "New description (1-500 chars). To explicitly clear the existing description, PATCH other fields without this one (an empty string '' is rejected by the schema — prevents an LLM hallucination from wiping the existing description).",
    },
  },
  rename_prompt: {
    description:
      "Change an existing prompt's name + version (Pro+ only, POST /v1/prompts/:id/rename). " +
      "Main use is typo fixes ('customer_supprt' to 'customer_support'). Collision with an existing (name, version) in the account = 409. " +
      "Since update_prompt never changes name/version by contract, rename is a separate tool for semantic separation.",
    inputs: {
      promptId: "Target prompt id (list_prompts.prompts[].id)",
      name: "New name ([A-Za-z0-9][A-Za-z0-9_-]{0,63})",
      version: "New version ([A-Za-z0-9][A-Za-z0-9._-]{0,63})",
    },
  },
  delete_prompt: {
    description:
      "Delete an existing prompt (Pro+ only, DELETE /v1/prompts/:id, 204 No Content). " +
      "Scoped to your account (other accounts' ids return 404). WARNING: physical delete with no restore; " +
      "past eval_runs' prompt_registry_id is SET NULL, losing the trace of which prompt template each run used (history comparisons can no longer be linked). " +
      "Even when sunsetting an old version in a rotation, while past run traces remain it is safer to do a logical sunset via update_prompt with labels such as 'sunset'.",
    inputs: {
      promptId: "Target prompt id (list_prompts.prompts[].id)",
    },
  },
  deploy_prompt: {
    description:
      "Deploy a specific prompt version to a label (an environment such as production / staging) " +
      "(Pro+ only, POST /v1/prompts/:id/deploy). If a deployment already exists, the prior version is kept as previous and " +
      "rollback_prompt can revert in one step. Re-deploying the same version does not create a previous entry. " +
      "Labels are per prompt name (each name has its own production version).",
    inputs: {
      promptId: "Id of the version to deploy (list_prompts.prompts[].id)",
      label: "Environment label (alphanumerics plus _ -, 1-32 chars. E.g. 'production' / 'staging')",
    },
  },
  rollback_prompt: {
    description:
      "Revert the prompt deployed to a label to the previous version (Pro+ only, POST /v1/prompts/deployments/rollback). " +
      "409 when there is no previous version (first deployment only), and 409 when the previous version has already been deleted. " +
      "After reverting, another rollback toggles back (current / previous swap).",
    inputs: {
      name: "Target prompt name",
      label: "Environment label",
    },
  },
  get_deployed_prompt: {
    description:
      "Resolve and return the prompt version currently deployed to the given environment (name + label) " +
      "(GET /v1/prompts/resolve, available on Free). The main runtime path for an agent to fetch the \"production prompt\". " +
      "Returns that version's template / variables / labels / version. 404 when nothing is deployed.",
    inputs: {
      name: "Prompt name",
      label: "Environment label",
    },
  },
  list_prompt_deployments: {
    description:
      "List the current deployment states (GET /v1/prompts/deployments, available on Free). " +
      "Each row = { promptName, label, currentVersion, canRollback, deployedAt }. " +
      "Narrow by name / label (omit both for everything).",
    inputs: {
      name: "Narrow by prompt name (optional)",
      label: "Narrow by label (optional)",
    },
  },
  list_safety_assessments: {
    description:
      "List the assessments written by the safety classifier (OpenAI Moderation). " +
      "source includes 'cron' (periodic batch) / 'mcp' (classify_calls_batch on-demand) / 'human_override' / 'api' / 'auto'. " +
      "With callId = all classifier assessments for that call; without callId = account-wide, flagged first then most recent. " +
      "In environments without OPENAI_API_KEY provisioned the cron does not run and this returns an empty array (classify_calls_batch also returns 503). " +
      "Precondition: safety classification is disabled by default (founder-scoped / off-by-default); no assessments are generated until it is enabled. " +
      "An empty array means \"not enabled / nothing flagged\", not a failure. " +
      "AI agents use this to review recently flagged calls or to check policy-violation candidates for a specific call.",
    inputs: {
      callId: "Target call id (llm_calls.id, [A-Za-z0-9_-]{1,128}). Omit for the whole account.",
      limit: "Number of results (1-200, default 50)",
    },
  },
  get_safety_assessment: {
    description:
      "Fetch one assessment's detail by id. Use assessments[].id from list_safety_assessments as-is. " +
      "Includes labels (array of flagged categories) + score (max category score 0-1) + reasoning + classifier_id + source. " +
      "Same endpoint as the argosvix://safety-assessments/{id} resource template.",
    inputs: {
      assessmentId: "Target assessment id (AUTOINCREMENT integer)",
    },
  },
  list_eval_runs: {
    description:
      "List the eval baseline runner's run history. Scoped to your account, most recent first. " +
      "Includes summary.scoredCount / failedCount / meanScoreByCriterion, so an AI agent can grasp recent eval result summaries and per-criterion score trends in one call. " +
      "Free users can read past runs too.",
    inputs: {
      limit: "Number of results (1-50, default 20)",
    },
  },
  get_eval_run: {
    description:
      "Fetch one eval run's detail plus the list of per-(criterion x call) scores. Use runs[].id from list_eval_runs as-is. " +
      "The scores array includes score (an integer within the criterion's scale) + reasoning (the judge's rationale). " +
      "Same endpoint as the argosvix://eval-runs/{id} resource template.",
    inputs: {
      runId: "Target eval run id (AUTOINCREMENT integer)",
    },
  },
  get_percentiles: {
    description:
      "Get percentile metrics over calls (POST /v1/query/percentiles). metric = 'latency' (ms) or 'cost' (USD); either a single value for the whole range, or a time series with groupBy='day'/'hour'/'minute'. " +
      "Example phrasing: \"daily p95 latency trend for last week\". Computed with the nearest-rank method via window functions (D1 SQLite has no percentile_cont).",
    inputs: {
      startTime: "Range start ISO timestamp (UTC; omit = all time)",
      endTime: "Range end ISO timestamp",
      provider: "Provider filter",
      model: "Model filter",
      metric: "Metric kind, default = 'latency'",
      groupBy:
        "Time-series bucketing (omit = one value for the whole range, 'day' = daily, 'hour' = hourly, 'minute' = per minute)",
    },
  },
  list_projects: {
    description:
      "List your account's active projects (GET /v1/projects, archived excluded). " +
      "Supports per-environment observation such as dev / staging / prod. Pro allows 5 projects / Team unlimited; Free has the default project only.",
  },
  list_members: {
    description:
      "List a Team account's members (GET /v1/memberships, removed members excluded). " +
      "Read-only tool returning each member's email / role (admin/member/viewer) / status / joined-at. " +
      "Invitations, role changes, and removals are privilege operations and intentionally not exposed over MCP (use the dashboard, or a future approval-gate flow).",
  },
  create_project: {
    description:
      "Create a new project (POST /v1/projects). name = display name; slug = a short URL-safe identifier (/^[a-z][a-z0-9-]{0,31}$/). " +
      "Pro caps at 5 projects, Team unlimited, Free cannot create (403). As a mutation, session-authenticated requests enforce Origin/Referer (dashboard-driven).",
    inputs: {
      name: "Project display name (1-64 chars)",
      slug: "Short URL-safe identifier (/^[a-z][a-z0-9-]{0,31}$/, up to 32 chars, starts with a lowercase letter, hyphens allowed)",
    },
  },
  rename_project: {
    description:
      "Update an existing project's name / slug (PATCH /v1/projects/:id). Specify either or both. slug keeps the URL-safe constraint (/^[a-z][a-z0-9-]{0,31}$/). Renaming the default project is allowed.",
    inputs: {
      projectId: "Target project id (the UUID obtained from list_projects)",
      name: "New display name (unchanged when omitted)",
      slug: "New slug (unchanged when omitted, /^[a-z][a-z0-9-]{0,31}$/)",
    },
  },
  delete_project: {
    description:
      "Soft-delete a project (DELETE /v1/projects/:id; sets archived_at for a logical delete). The default project cannot be deleted (400, keeping accounts.default_project_id referentially consistent). " +
      "After archiving, calls / alerts remain as-is (past observations are kept); route new records to another project.",
    inputs: {
      projectId: "Id of the project to delete (via list_projects)",
    },
  },
  classify_calls_batch: {
    description:
      "Batch safety-classify unclassified calls on demand (via OpenAI Moderation, POST /v1/safety-assessments/scan-batch). Complements the cron (every 15 min, 50 records) with a \"right now\" path — an AI agent can finish \"classify all of last week's calls\" in one prompt. " +
      "Pro+ only (Free relies on the cron); the backend enforces the plan gate and budget gate. maxRecords (1-100, default 50); returns { scanned, assessed, flagged, failures, skipped }. Recorded with source='mcp' (distinguished from cron entries, so the dashboard can visualize on-demand classification). " +
      "Audit: emits a safety.scan_batch_run event to the audit log.",
    inputs: {
      maxRecords:
        "Max records scanned per request (1-100, default 50). Capped considering OpenAI's 1000 RPM limit and the 10s CPU/IO limit per worker request",
    },
  },
  propose_eval_criteria: {
    description:
      "Have an LLM judge (gpt-4o-mini) propose eval criterion candidates from a one-line useCaseHint (e.g. \"customer support bot\") and optional sampleCallIds (representative calls from your account, up to 5) (POST /v1/eval-criteria/propose). An AI agent can finish \"propose criteria to measure our prompt quality\" in one prompt. " +
      "Pro+ only (the backend enforces the plan gate + budget gate); nothing is INSERTed (propose only — adoption is a separate step via create_eval_criterion, structurally limiting LLM-hallucination impact). Decrypt failures for sampleCallIds are reported in partialFailures (the LLM call still runs without samples). " +
      "Privacy note for prompt samples: with sampleCallIds, the backend decrypts those calls' prompt/response and sends excerpts (1500 chars each) to OpenAI gpt-4o-mini. This re-sends data your SDK originally sent to OpenAI/Anthropic, so no new vendor is added, but be aware it may reach an OpenAI model different from your own LLM calls. If that is a concern, run with useCaseHint only. " +
      "Results are advisory: the returned criteria are LLM proposals and may include semantically weak rubrics (overuse of \"helpful\", duplicates) even when structurally valid. User review before adoption is recommended; do not feed them blindly into create_eval_criterion. " +
      "Returns { criteria: [{ name (snake_case 32 chars), rubric (1-200), scaleMin (=1), scaleMax (5 or 10), reasoning (1-200) }], partialFailures: string[], budgetSpentUsd, proposedRawCount (raw count returned by the LLM), droppedCount (entries removed by the validator) }. Audit: emits an eval.propose_criteria event to the audit log.",
    inputs: {
      useCaseHint:
        "1-2 line description of the intended use case (e.g. \"customer support bot for e-commerce returns + refunds\"; 1-500 chars, required)",
      sampleCallIds:
        "Array of call_ids from your account passed as context (optional, up to 5, [A-Za-z0-9_-]{1,128}). Grounds the LLM's proposals in your own data",
      maxCriteria: "Max number of criteria to return (1-10, default 5)",
    },
  },
  purge_expired_plaintext: {
    description:
      "Bulk-purge your account's plaintext records older than olderThanDays (POST /v1/tier2/plaintext/purge-expired). Consistent with the Terms of Service v2.1 \"retainable up to 90 days\" (automatic retention); an AI agent can finish \"auto-purge plaintext older than 30 days\" in one prompt. " +
      "dryRun=true (the safe default to reach for) returns the count plus 5 sample call_ids; dryRun=false performs the actual UPDATE. Emit-then-UPDATE ordering plus a deterministic idempotencyId (sha1(endpoint+accountId+olderThanDays+cutoff_date)) gives webhook-retry-equivalent semantics. Pro+ plan only (Free gets 403). An actual purge (dryRun=false) requires approvalId — obtain human approval via request_approval (action: 'purge_expired_plaintext') first, because NULLing plaintext is irreversible. Only your own account is purged. " +
      "Returns (dryRun=true) { dryRun: true, targetCount, cutoffTimestamp, olderThanDays, sampleTargetCallIds }; (dryRun=false) { dryRun: false, purgedCount, cutoffTimestamp, olderThanDays, purgedAt }. Audit: emits tier2.purge_expired_plaintext.",
    inputs: {
      olderThanDays: "Age threshold in days for purging (1-365, default 30; consistent with the Terms of Service v2.1)",
      dryRun: "true = preview only (zero mutation); false = actual UPDATE. Default false (MCP discipline recommends passing dryRun explicitly)",
      approvalId:
        "Approval id granted via request_approval (apr_ + 32 hex; create with action 'purge_expired_plaintext'). When passed, the server verifies approved + within expiry + action match + unconsumed, and atomically consumes it on the actual purge (1 approval = 1 execution). dryRun only verifies without consuming",
    },
  },
  retry_failed_webhook: {
    description:
      "Mark failed Stripe webhook events (the billing_dead_letter table) for reprocessing in the audit log (POST /v1/tier2/webhook-events/retry). Finishes \"retry all the Stripe webhooks that failed transiently last week\" in one prompt. " +
      "Select targets by eventIds (specific events, up to 100) or fromTimestamp/toTimestamp (range, 7-day cap). dryRun=true previews the list; dryRun=false records a 'marked_for_manual_redispatch' entry per event in the audit log (the founder performs the actual retry via wrangler / the Stripe dashboard; fully automatic re-dispatch is a later phase). " +
      "Emits use a deterministic idempotencyId (sha1(endpoint+accountId+eventId)); duplicate runs with the same args are silently skipped. Founder-operations only (an internal billing-webhook recovery tool; general accounts get 403). billing_dead_letter is an internal cross-account table and actual re-dispatch stays manual, so there is no plan to open this up. " +
      "Returns (dryRun=true) { dryRun: true, targetCount, events: [{eventId, eventType, reason, receivedAt}] }; (dryRun=false) { dryRun: false, targetCount, succeeded: string[], failed: [{eventId, reason}], skipped: string[], narrative, retriedAt }. Audit: emits tier2.retry_failed_webhook per event.",
    inputs: {
      eventIds: "Array of Stripe event ids to retry (evt_xxx format, up to 100). Can be combined with fromTimestamp",
      fromTimestamp: "Range start (ISO-8601; more than 7 days ago is rejected with 400)",
      toTimestamp: "Range end (ISO-8601, optional)",
      maxRetries: "Per-request cap (1-100, default 10)",
      dryRun: "true = preview only; false = actually emit the markers. Default false",
      approvalId:
        "Approval id granted via request_approval (apr_ + 32 hex; create with action 'retry_failed_webhook'). Server-side verification + atomic consumption on actual execution (1 approval = 1 execution). dryRun only verifies",
    },
  },
  auto_silence_noisy_alert: {
    description:
      "Bulk-silence noisy alerts that fired repeatedly in the past hour (POST /v1/tier2/alerts/auto-silence). Finishes \"this alert fired 50 times in the past hour — silence it for an hour\" in one prompt. " +
      "Specify exactly one of alertId (silence a single alert) or byVolumeThreshold (all alerts with N+ firings in the past hour). silenceDurationMinutes is 5-1440 (5 minutes to 24 hours), default 60. An optional reason can be attached. " +
      "dryRun=true previews the targets with fireCount; dryRun=false UPDATEs alerts.silenced_until and emits an audit event per alert (tier2.auto_silence_noisy_alert). Because this is a reversible mutation (the existing unsilence_alert can undo it) with strict per-account scoping (other accounts' alerts are unaffected), there is no founder gate — paid Pro+ users can call it directly. " +
      "Returns (dryRun=true) { dryRun: true, targetCount, silenceUntil, silenceDurationMinutes, lookbackStart, targets: [{alertId, name, fireCount}] }; (dryRun=false) { dryRun: false, targetCount, silenceUntil, silenceDurationMinutes, succeeded: string[], failed: [{alertId, reason}], skipped: string[], reason }. idempotencyId = sha1(endpoint+accountId+alertId+silenceUntil truncated to the minute), coalescing duplicate runs within the same minute.",
    inputs: {
      alertId: "Alert id for single-alert silencing (alrt_xxx format). Cannot be combined with byVolumeThreshold",
      byVolumeThreshold: "Batch-silence all alerts with N+ firings in the past hour. Cannot be combined with alertId",
      silenceDurationMinutes: "Silence duration (minutes, 5-1440 = 5 minutes to 24 hours), default 60",
      reason: "Silence reason (recorded in the audit log, 200 chars max)",
      dryRun: "true = preview only (zero mutation); false = actual silence. Default false",
      approvalId:
        "Approval id granted via request_approval (apr_ + 32 hex; create with action 'auto_silence_noisy_alert'). Server-side verification + atomic consumption on the actual silence (1 approval = 1 execution). dryRun only verifies",
    },
  },
  extend_customer_trial: {
    description:
      "Extend your account's Stripe subscription trial by 1-30 days (POST /v1/tier2/trial/extend). Founder-operations only (an internal support tool; general accounts get 403). Trial extension directly affects revenue, so there is no plan to open it up. Cumulative cap of 60 days (aggregated from the last 30 days of audit logs); 409 unless status='trialing'. " +
      "dryRun must be passed explicitly (guards against accidental mutation via an implicit false); when dryRun=false, idempotencyKey is also required (16-128 alphanumeric plus '_-'). Re-calling with the same key returns the cached result via the tier2_idempotency table (structurally preventing retry double-extends). " +
      "dryRun=true previews previousTrialEnd / newTrialEnd / the cumulative total only (no Stripe call); dryRun=false performs the actual Stripe mutation plus the accounts_subscription sync update.",
    inputs: {
      targetAccountId: "Target account id (your own account only for now; specifying another user gets 403)",
      extendDays: "Days to extend (1-30, cumulative cap 60 days)",
      reason: "Reason for the extension (recorded in the audit log; required, 200 chars max)",
      dryRun: "Must be passed explicitly. true = preview only; false = actual trial extension + Stripe mutation",
      idempotencyKey: "Required when dryRun=false. 16-128 chars alphanumeric plus '_-'; re-calls with the same key return the cached result",
      approvalId:
        "Approval id granted via request_approval (apr_ + 32 hex; create with action 'extend_customer_trial'). Server-side verification + atomic consumption on a fresh execution (1 approval = 1 execution chain; retries with the same idempotencyKey do not re-consume). dryRun only verifies",
    },
  },
  apply_promo_code_to_customer: {
    description:
      "Apply a user-facing promotion code already registered in Stripe (e.g. 'LAUNCH50') to your account's Stripe subscription (POST /v1/tier2/promo/apply). Founder-operations only (an internal support tool; general accounts get 403). It will not be opened up without terms covering economically impactful operations (timing undecided). 409 if an active discount already exists (structural defense against stacking), and 409 when the status is canceled / incomplete_expired. " +
      "Redemption is delegated to Stripe via promotion_code (applying coupons directly is forbidden as a constraint bypass); dryRun must be passed explicitly, and idempotencyKey is required when dryRun=false. Re-calls with the same key return the cached result via the tier2_idempotency table, structurally serializing concurrent applies. " +
      "dryRun=true previews resolution + the active-discount check + the estimated discount only (no Stripe mutation); dryRun=false applies the promotion code.",
    inputs: {
      targetAccountId: "Target account id (your own account only for now; specifying another user gets 403)",
      promoCode: "Promotion code already registered in Stripe (e.g. 'LAUNCH50'; alphanumerics plus '_-', 64 chars max)",
      reason: "Reason for applying it (recorded in the audit log; required, 200 chars max)",
      dryRun: "Must be passed explicitly. true = preview only; false = actual promotion-code application + Stripe mutation",
      idempotencyKey: "Required when dryRun=false. 16-128 chars alphanumeric plus '_-'; re-calls with the same key return the cached result",
      approvalId:
        "Approval id granted via request_approval (apr_ + 32 hex; create with action 'apply_promo_code_to_customer'). Server-side verification + atomic consumption on a fresh execution (1 approval = 1 execution chain; retries with the same idempotencyKey do not re-consume). dryRun only verifies",
    },
  },
  detect_anomaly: {
    description:
      "Compare the current window against a baseline window (the immediately preceding window of the same length) and detect anomalies across 4 axes: cost / latency / error_rate / call_volume — lets an AI grasp \"is anything off?\" in one prompt. " +
      "Sensitivity is tunable via threshold: sensitive (1.5x) / normal (2x, default) / conservative (3x). 0-4 detections, each with a narrative. " +
      "Returns { window, threshold, current: {...}, baseline: {...}, anomalies: [{ axis, severity: 'minor'|'major'|'critical', current, baseline, ratio, narrative }] }. errorRate is evaluated and displayed as a percent (0-100), matching the backend aggregate unit. Insufficient baseline data (fewer than 10 records in the period) yields anomalies: [] plus a warning message.",
    inputs: {
      window: "Observation window ('1h' / '24h' / '7d', default '24h')",
      threshold: "Sensitivity ('sensitive' 1.5x / 'normal' 2x / 'conservative' 3x, default 'normal')",
    },
  },
  propose_alert_rules: {
    description:
      "Analyze the call patterns over the past lookbackDays (7-30, default 14) and propose recommended alert rules for cost / latency / error_rate / anomaly as JSON. " +
      "Applying them is a separate step via create_alert after customer confirmation (propose only — zero side effects). Only rules that do not overlap existing alerts are proposed (existing types are fetched via list_alerts). " +
      "Returns { lookbackDays, baseline: {meanDailyCost (USD), p95Latency (ms), errorRate (percent 0-100), dailyCalls, totalCalls}, proposals: [{ name, alertType, thresholdValue, windowMinutes, reasoning }], skipped: [{ alertType, reason }] }. The thresholdValue of an error_rate proposal is also a percent (consistent with backend create_alert). What big-vendor dashboards show in UI, done MCP-first in one prompt.",
    inputs: {
      lookbackDays: "Lookback days for computing the baseline (7-30, default 14)",
    },
  },
  get_account_health: {
    description:
      "Get a health summary of your LLM infrastructure in one call. Fetches 4 existing endpoints in parallel (aggregate_calls / get_percentiles / get_llm_budget / list_audit_log) and compresses them into one response. " +
      "Returns { window, totals: {calls, costUsd, errorRate (percent 0-100)}, latency: {p50, p95, p99 (ms)}, budget: {used, limit, percentUsed (0-100)}, recentEvents: count, summary: 'ok' | 'warn' | 'critical' }. critical = errorRate>=10% / budget>=90% / p95>=10s; warn = >=3% / >=70% / >=3s. " +
      "Example phrasing: \"how is our LLM infra doing right now?\" — answered in one prompt. Pure read aggregator (no new backend endpoint); individual endpoint failures return partial results (one axis timing out does not block the summary).",
    inputs: {
      window: "Observation window ('1h' / '24h' / '7d', default '24h')",
    },
  },
  aggregate_calls: {
    description:
      "Get an aggregation cube over calls (POST /v1/query/aggregate). groupBy (provider / model / day / hour / minute / tag / error) x metric (cost / latency / tokens / input_tokens / output_tokens / cached_tokens / cache_savings / count / error_rate) — e.g. \"aggregate this month's cost by model\" in one call. " +
      "tag mode requires tagKey (alphanumerics plus _ - only, e.g. 'env' / 'feature'). error mode aggregates only error rows by error string (which errors, how many; metric=count recommended). hour mode caps at 168h / minute mode at 60min (400 beyond). cost = SUM(cost_usd) / latency = AVG(latency_ms) / tokens = SUM(total_tokens) / input_tokens = SUM(prompt_tokens) / output_tokens = SUM(completion_tokens) / cached_tokens = SUM(cached_read_tokens) / cache_savings = SUM(cache_savings_usd) / count = COUNT(*) / error_rate = errors / total. " +
      "Returns { groups: [{key, value, count}], total: {value, count} }.",
    inputs: {
      startTime: "Range start ISO timestamp (UTC; omit = all time)",
      endTime: "Range end ISO timestamp (UTC; omit = now)",
      groupBy:
        "Aggregation axis ('provider' / 'model' / 'day' / 'hour' / 'minute' / 'tag' / 'error'), default = 'provider'. hour caps at 168h / minute at 60min. error aggregates only error rows by kind",
      metric:
        "Metric kind ('cost' / 'latency' / 'tokens' / 'input_tokens' / 'output_tokens' / 'cached_tokens' / 'cache_savings' / 'reasoning_tokens' / 'audio_tokens' / 'ttft' / 'count' / 'error_rate'), default = 'cost'. cached_tokens = SUM(cached_read_tokens), cache_savings = SUM(cache_savings_usd) (prompt-cache savings), reasoning_tokens = SUM(reasoning tokens), audio_tokens = SUM(audio tokens), ttft = AVG(ms to first token)",
      provider: "Provider filter ('openai' / 'anthropic' etc.); omit = all providers",
      tagKey: "Required when groupBy='tag'. Key name inside the tags JSON (alphanumerics plus _- only, 1-64 chars)",
    },
  },
  list_audit_log: {
    description:
      "List the audit log (GET /v1/audit-log). Scoped to your account; admin role only (viewer/member get 403). " +
      "Lets an AI agent autonomously review recent operation history such as invitations / API key revocations / project changes. " +
      "Filters = eventType ('invitation.created' / 'api_key.revoked' etc.) / targetKind / actorUserId / from / to. " +
      "Supports cursor pagination (nextCursor format = 'created_at|id'), max limit 200.",
    inputs: {
      limit: "Number of results (1-200, default 50)",
      eventType: "Exact-match event_type filter ('invitation.created' / 'api_key.revoked' / 'membership.removed' etc.)",
      targetKind: "target_kind filter ('invitation' / 'api_key' / 'membership' etc.)",
      actorUserId: "actor_user_id filter (only a specific user's operations)",
      from: "Range start ISO timestamp (UTC)",
      to: "Range end ISO timestamp (UTC)",
      cursor: "Pagination cursor (pass the previous response's nextCursor as-is, 'created_at|id' format)",
    },
  },
  list_saved_views: {
    description:
      "List the saved views (GET /v1/saved-views). A saved view is a named combination of frequently used /calls page filters (startDate/endDate/provider/model/limit). " +
      "Enables phrasing like \"show calls with my usual last-week OpenAI filter\". Per account, max 20.",
  },
  create_saved_view: {
    description:
      "Create a new saved view, or overwrite when the name exists (POST /v1/saved-views). name is unique within the account. filter follows the SavedViewFilter shape (startDate / endDate / provider / model / limit / preset / sortBy? / sortOrder?). " +
      "Lets an AI agent save frequently used filters under a name — e.g. create a \"last 7 days, GPT-4 only\" view and recall it later.",
    inputs: {
      name: "Name of the saved view (1-80 chars, no line breaks). Overwrites an existing view with the same name",
      filter:
        "Filter shape = startDate (ISO) + endDate (ISO) + provider (may be empty) + model (may be empty) + limit (number) + preset (string|null) + sortBy? + sortOrder?",
      "filter.startDate": "ISO timestamp (range start)",
      "filter.endDate": "ISO timestamp (range end)",
      "filter.provider": "Provider ('openai' / 'anthropic' / 'google' etc.); empty = all providers",
      "filter.model": "Model name; empty = all models",
      "filter.limit": "Cap on returned records",
      "filter.preset": "Preset identifier (dashboard default filter; null allowed)",
      "filter.sortBy": "Column to sort by",
      "filter.sortOrder": "Sort direction ('asc' / 'desc')",
    },
  },
  delete_saved_view: {
    description:
      "Delete the saved view with the given id (DELETE /v1/saved-views/:id). Scoped to your account.",
    inputs: {
      id: "Id of the saved view to delete (UUID)",
    },
  },
  export_calls: {
    description:
      "Large-batch export of calls (POST /v1/query/export). Higher limit than query_calls (per-plan max records: Free 1000 / Pro 50000); available on all plans. " +
      "Filter axes = startTime / endTime / provider / model plus limit. Example phrasing: \"pull all of last month's GPT-4 calls and analyze the trends\" — one call. " +
      "The result format is the same JSON as query_calls (the AI can feed it straight into CSV / statistics).",
    inputs: {
      startTime: "Range start ISO timestamp (UTC; omit = all time)",
      endTime: "Range end ISO timestamp (UTC; omit = now)",
      provider: "Provider filter (openai / anthropic / google / azure / cohere)",
      model: "Model name filter (exact match, no substring matching; e.g. 'gpt-4o-mini')",
      limit: "Cap on returned records. Passed through when within the plan max; clamped to the plan max beyond it",
    },
  },
  bulk_delete_calls: {
    description:
      "Bulk-delete the given call ids (max 100), scoped to your account (POST /v1/calls/bulk-delete). " +
      "Useful for cleaning up garbage calls accumulated by dogfooding / dev tests. " +
      "dryRun=true returns the matched count before deleting. The delete is one atomic SQL statement; a bulk_deleted event is recorded in the audit log. " +
      "Per FK constraints, related traces / annotations / scores are cascade-deleted via ON DELETE.",
    inputs: {
      callIds: "Array of call ids to delete (1-100 entries, each 1-128 chars)",
      dryRun: "true returns only the matched count without deleting (confirmation UX)",
      approvalId:
        "Approval id granted via request_approval (apr_ + 32 hex; create with action 'bulk_delete_calls'). Server-side verification + atomic consumption on actual deletion (1 approval = 1 execution). dryRun only verifies",
    },
  },
  compare_eval_runs: {
    description:
      "Compare two eval runs (baseline / candidate) and return per-criterion mean score deltas + the failed count delta + a verdict (GET /v1/eval-runs/compare). " +
      "Lets an AI agent grasp \"how did the candidate change relative to the baseline\" in one call, for prompt-improvement measurement and regression detection. " +
      "verdict = improved / regressed / mixed / unchanged. The failed count treats scores <= 2 as \"failed\". Same account only.",
    inputs: {
      baselineRunId: "Id of the baseline run (list_eval_runs.runs[].id)",
      candidateRunId: "Id of the candidate run (same source); must differ from the baseline",
    },
  },
  run_eval: {
    description:
      "Start a new eval run immediately (POST /v1/eval-runs). Scores the most recent N calls against the 5 default criteria (plus up to 8 custom criteria) using gpt-4o-mini. " +
      "Pro+ only (Free gets 403); environments without OPENAI_API_KEY provisioned return 500 from the backend. " +
      "Precondition: only calls with plaintext storage (the content-storage opt-in) ON are scored. With the opt-in OFF (the default) there are zero candidates and the run returns " +
      "summary.scoredCount=0 with reason='no_plaintext_calls' (gating, not a failure). " +
      "Cost: about $0.01 per run (20 calls x 5 criteria = 100 LLM calls); around 30 runs/month = $0.30 at founder-dogfood scale.",
    inputs: {
      name: "Free-form run name (1-100 chars, e.g. 'weekly-prod-eval-2026-06-02')",
      recentCount: "Number of calls to evaluate (1-20, default 10). The most recent N calls are passed to the judge.",
      label: "Label filter (substring match within tags). Omit = all calls.",
      promptRegistryId: "Target prompt registry id (list_prompts.prompts[].id). Omit = ad-hoc run.",
      idempotencyKey: "Opaque key for retry dedup (UUID recommended, 64 char cap). Re-POSTing the same key within 60 minutes returns the existing run.",
    },
  },
  list_eval_datasets: {
    description:
      "List your account's golden datasets (GET /v1/eval-datasets). Each dataset has a name / description / item count / frozen state. A golden dataset is a fixed test set with expected outputs — the population run_eval_dataset pushes through a target model to measure regression A/B.",
  },
  get_eval_dataset: {
    description:
      "Fetch one dataset's detail plus all of its items (GET /v1/eval-datasets/:id). datasetId is list_eval_datasets.datasets[].id.",
    inputs: {
      datasetId: "Target dataset id (list_eval_datasets.datasets[].id)",
    },
  },
  create_eval_dataset: {
    description:
      "Create a golden dataset (POST /v1/eval-datasets, Pro+ only). items can carry up to 20 test cases with expected outputs. Up to 50 datasets per account. frozen=true freezes the population (items can no longer be changed or unfrozen — fixing comparability for regression verdicts).",
    inputs: {
      name: "Dataset name (1-100 chars, unique within the account)",
      description: "Optional description (<= 500 chars)",
      items:
        "Test cases (up to 20). Each inputText is fed to the target model, and expectedOutput is used as the judge's [REFERENCE ANSWER] for scoring.",
      "items.inputText": "Input for the model (1-4000 chars)",
      "items.expectedOutput": "Expected output (optional, <= 4000 chars). Passed to the judge as the reference answer.",
      frozen: "true = freeze the population (items can no longer be changed or unfrozen). Omit = false.",
    },
  },
  run_eval_dataset: {
    description:
      "Run a golden dataset against a target model and produce a regression verdict (POST /v1/eval-datasets/:id/run, Pro+ only). Feeds each item's inputText to targetModel, has gpt-4o-mini score the outputs against the default criteria plus expectedOutput, and records eval_scores (regression A/B). Results can be compared across runs with compare_eval_runs. Run records are excluded from production cost / analytics / alert aggregation. Cost: item count x criteria count LLM calls. 503 in environments without OPENAI_API_KEY provisioned.",
    inputs: {
      datasetId: "Id of the dataset to run (list_eval_datasets.datasets[].id)",
      targetModel: "Model to measure regressions for (only OpenAI models present in the pricing table, e.g. 'gpt-4o-mini'). Unknown models get 400.",
      judgeModel: "Judge model (omit = gpt-4o-mini). Only OpenAI models present in the pricing table.",
      idempotencyKey: "Opaque key for retry dedup (UUID recommended, 200 char cap). Re-POSTing the same key returns the existing run (double-billing prevention).",
    },
  },
  delete_eval_dataset: {
    description:
      "Delete a golden dataset (DELETE /v1/eval-datasets/:id, Pro+ only). Items are cascade-deleted. Past eval runs / scores remain.",
    inputs: {
      datasetId: "Id of the dataset to delete",
    },
  },
};

/** resources (= 3 件) の英語オーバーレイ。 key は resources[].name。 */
export const RESOURCE_OVERLAYS_EN: Record<
  string,
  { title: string; description: string }
> = {
  account: {
    title: "Argosvix account info",
    description:
      "Snapshot of the current plan / quota / this month's record usage / retention settings. " +
      "Returns backend /v1/account (Bearer-only, read-only) as raw JSON. " +
      "Subscription detail (next billing date / auto-renew flag / Stripe state) is not included.",
  },
  alerts_active: {
    title: "Currently active alerts",
    description:
      "List of alerts with enabled=true (silenced ones included; enabled=false excluded). " +
      "Returns a snapshot in the same shape the list_alerts tool returns. Lets an LLM automatically pull " +
      "\"what is being monitored right now?\" into context.",
  },
  cost_today: {
    title: "Today's cost summary",
    description:
      "Snapshot of the last 24 hours' cost aggregation with a per-provider breakdown. " +
      "Response equivalent to get_cost_summary(rangePreset=\"24h\", groupBy=\"provider\"); " +
      "the overall total is included in the response.total field.",
  },
};

/** resource templates (= 8 件) の英語オーバーレイ。 key は resourceTemplates[].name。 */
export const RESOURCE_TEMPLATE_OVERLAYS_EN: Record<
  string,
  { title: string; description: string }
> = {
  call_detail: {
    title: "LLM call detail",
    description:
      "A single LLM call record (provider / model / tokens / cost / latency / tags / " +
      "error / trace_id) fetched directly by URI. The id is `records[].id` from the query_calls tool " +
      "response. Scoped to your account (backend PK path) — probing other accounts' ids returns 404 " +
      "(structural defense). Example: argosvix://calls/abc123",
  },
  alert_detail: {
    title: "Alert config + recent trigger history",
    description:
      "A single alert's rule config (name / type / threshold / window / filter / " +
      "channel kinds / sleep / enabled / silencedUntil) plus its latest 20 trigger events, fetched " +
      "directly by URI. The id is `alerts[].id` from the list_alerts tool response. " +
      "channelTargets (notification email / webhook URLs = sensitive) are structurally dropped; " +
      "only channelKinds (the kind enum) is carried. Example: argosvix://alerts/alt-abc123",
  },
  trace_detail: {
    title: "Whole trace (multiple spans = one trace's time series)",
    description:
      "All spans of a single trace (the time series of LLM calls sharing a trace_id), fetched directly " +
      "by URI. The id is the traceId included in query_calls / list_alerts tool responses, " +
      "or copied from a dashboard trace URL. Spans are capped at the top 50 (LLM " +
      "context budget); errorDetails / requestMeta are structurally dropped. Example: " +
      "argosvix://traces/trace-abc123",
  },
  annotation_detail: {
    title: "One annotation (the user's own review / comment)",
    description:
      "A single annotation's body (annotationText) + label + qualityScore (1-5) + " +
      "callId / createdAt / updatedAt, fetched directly by URI. The id is annotation.id from list_annotations_* " +
      "tool responses (AUTOINCREMENT integer). " +
      "annotationText is user-controlled, so it is carried through sanitizeText (control-character strip + " +
      "2000 char cap) to structurally guard the prompt-injection path. Scoped to your account " +
      "via a backend WHERE clause (other accounts' ids return 404). Example: " +
      "argosvix://annotations/42",
  },
  eval_criterion_detail: {
    title: "One eval criterion (LLM-as-judge evaluation axis)",
    description:
      "A single evaluation criterion's rubric (the instruction text for the judge) + scaleMin / scaleMax + " +
      "name + createdAt, fetched directly by URI. The id is criteria[].id from the list_eval_criteria tool " +
      "response. Both global defaults (accountId NULL) and your account's customs are visible; " +
      "other accounts' customs are guarded by a backend WHERE clause (404). The rubric is a user-controlled " +
      "string, carried through sanitizeText (control-character strip + 4000 char cap — a larger cap than " +
      "annotations since judge instructions can be long). Example: argosvix://eval-criteria/1",
  },
  prompt_detail: {
    title: "One prompt template (user-registered saved prompt with versioning + labels)",
    description:
      "A single prompt template's name / version / template (body) / variables (placeholder spec) / " +
      "labels (deploy axes such as production / staging) / description / createdAt / updatedAt, fetched directly by URI. " +
      "The id is prompts[].id from the list_prompts tool response. Scoped to your account via a " +
      "backend WHERE clause (other accounts' ids return 404). The template is user-controlled and " +
      "carried through sanitizeText (50000 char cap, structural guard for the prompt-injection path). Example: argosvix://prompts/42",
  },
  safety_assessment_detail: {
    title: "One safety assessment (OpenAI Moderation result)",
    description:
      "A single safety assessment's labels (array of flagged categories) / score (max category score 0-1) / " +
      "reasoning (e.g. a \"flagged: harassment, hate\" narrative) / classifier_id (e.g. openai-moderation-omni-2026) / " +
      "source ('cron' / 'mcp' (classify_calls_batch on-demand) / 'human_override' / 'api' / 'auto') / createdAt, " +
      "fetched directly by URI. The id is assessments[].id from the list_safety_assessments tool " +
      "response. Scoped to your account via a backend WHERE clause. reasoning is LLM-controlled " +
      "narrative, carried through sanitizeText (control-character strip + 4000 char cap). Example: argosvix://safety-assessments/42",
  },
  eval_run_detail: {
    title: "One eval run + all scores",
    description:
      "A single eval run's name / status / judge_provider / judge_model / summary (scoredCount / failedCount / " +
      "meanScoreByCriterion) plus the array of per-(criterion x call) scores (score / reasoning / criterionId / callId), fetched directly " +
      "by URI. The id is runs[].id from the list_eval_runs tool response. Scoped to your account via a backend WHERE " +
      "clause. reasoning (judge LLM output) is effectively user-controlled, carried through sanitizeText (4000 char cap). " +
      "Example: argosvix://eval-runs/42",
  },
};

/** prompts (= 3 件) の英語オーバーレイ。 key は prompts[].name、 arguments は 引数名 → 英文。 */
export const PROMPT_OVERLAYS_EN: Record<
  string,
  { title: string; description: string; arguments?: Record<string, string> }
> = {
  cost_review: {
    title: "Cost trend review",
    description:
      "Calls argosvix's get_cost_summary tool for 24h / 7d / 30d in order, compares the per-provider " +
      "breakdowns, and points out anomalies (spikes / over-concentration / unexpected models). " +
      "Passing the month argument steers the analysis toward the difference from that month.",
    arguments: {
      month: "Month to compare against (YYYY-MM format, e.g. 2026-04). Omit to evaluate the current month only.",
    },
  },
  alert_audit: {
    title: "Alert configuration audit",
    description:
      "Fetches all alerts with argosvix's list_alerts tool, cross-checks them against the plan constraints (Free / Pro / Team) and " +
      "the actual cost / error rates, and reviews whether the notification channels / sleepMinutes / thresholds are appropriate. " +
      "Also detects duplicate alerts and alerts left silenced, and proposes improvements.",
  },
  incident_triage: {
    title: "Incident triage",
    description:
      "Investigates error / latency anomalies over the last N hours. Checks recent triggers with list_alert_events, " +
      "pulls the raw records for that window with query_calls, and estimates the root cause (a specific model / " +
      "provider outage / cost spike) with a report.",
    arguments: {
      hours: "How many hours to look back (e.g. 6 / 24 / 72). Defaults to 24.",
    },
  },
};

/**
 * JSON Schema の node を dot path で辿る (= 配列は items を透過的に降りる)。
 * 例: "conditions.conditions.metric" は
 * properties.conditions.properties.conditions.items.properties.metric を指す。
 * drift テストからも参照される。
 */
export interface SchemaNode {
  description?: unknown;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  [key: string]: unknown;
}

export function resolveSchemaNode(
  root: SchemaNode,
  path: string,
): SchemaNode | undefined {
  let node: SchemaNode | undefined = root;
  for (const seg of path.split(".")) {
    if (!node) return undefined;
    node = node.properties?.[seg] ?? node.items?.properties?.[seg];
  }
  return node;
}

/** deep copy (= tool / resource / prompt 定義は plain JSON なので JSON 往復で足りる)。 */
function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * tools/list へ返す tool 一覧に言語を適用する。 ja = 正本そのまま (= 参照を返す)、
 * en = deep copy に英訳オーバーレイを適用 (= 元オブジェクトは汚さない)。
 */
export function localizeTools(list: Tool[], lang: McpLang): Tool[] {
  if (lang !== "en") return list;
  return list.map((tool) => {
    const overlay = TOOL_DESCRIPTIONS_EN[tool.name];
    if (!overlay) return tool;
    const copy = deepCopy(tool);
    copy.description = overlay.description;
    if (overlay.inputs) {
      for (const [path, text] of Object.entries(overlay.inputs)) {
        const node = resolveSchemaNode(copy.inputSchema as SchemaNode, path);
        if (node && typeof node.description === "string") {
          node.description = text;
        }
      }
    }
    return copy;
  });
}

export function localizeResources(list: Resource[], lang: McpLang): Resource[] {
  if (lang !== "en") return list;
  return list.map((resource) => {
    const overlay = RESOURCE_OVERLAYS_EN[resource.name];
    if (!overlay) return resource;
    const copy = deepCopy(resource);
    copy["title"] = overlay.title;
    copy.description = overlay.description;
    return copy;
  });
}

export function localizeResourceTemplates(
  list: ResourceTemplate[],
  lang: McpLang,
): ResourceTemplate[] {
  if (lang !== "en") return list;
  return list.map((template) => {
    const overlay = RESOURCE_TEMPLATE_OVERLAYS_EN[template.name];
    if (!overlay) return template;
    const copy = deepCopy(template);
    copy["title"] = overlay.title;
    copy.description = overlay.description;
    return copy;
  });
}

export function localizePrompts(list: Prompt[], lang: McpLang): Prompt[] {
  if (lang !== "en") return list;
  return list.map((prompt) => {
    const overlay = PROMPT_OVERLAYS_EN[prompt.name];
    if (!overlay) return prompt;
    const copy = deepCopy(prompt);
    copy["title"] = overlay.title;
    copy.description = overlay.description;
    if (overlay.arguments && copy.arguments) {
      for (const arg of copy.arguments) {
        const text = overlay.arguments[arg.name];
        if (text) arg.description = text;
      }
    }
    return copy;
  });
}
