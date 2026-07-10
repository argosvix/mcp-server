/**
 * MCP prompt definitions and handler (added in v0.4.0-alpha.1).
 *
 * A prompt is a template message the user explicitly selects and launches
 * (similar to a slash command). Argosvix provides 3 of them as scaffolds that
 * inject a typical LLM observability query in one click. Each prompt is a
 * single user-role text message that instructs the agent to make the needed
 * argosvix tool calls.
 *
 * Prompts:
 *   - cost_review       = analyze 24h / 7d / 30d cost trends and report anomalies
 *   - alert_audit       = audit current alert settings and suggest improvements
 *                         appropriate to the plan / use case
 *   - incident_triage   = investigate error / latency anomalies in the last N
 *                         hours and estimate the root cause
 *
 * Future candidates: dynamic argument completion (completion API), per-model /
 * per-provider templates.
 */

import type {
  Prompt,
  GetPromptResult,
} from "@modelcontextprotocol/sdk/types.js";

export const prompts: Prompt[] = [
  {
    name: "cost_review",
    title: "コスト傾向レビュー",
    description:
      "argosvix の get_cost_summary tool を 24h / 7d / 30d で順に呼び、 provider 別 " +
      "breakdown を比較して 異常 (= 急増 / 一極集中 / 想定外モデル) を 指摘する。 " +
      "month argument を 渡すと 「先月との 差分」 を 念頭に置いた analysis に carry。",
    arguments: [
      {
        name: "month",
        description:
          "比較対象月 (= YYYY-MM 形式、 例 2026-04)。 省略すると 今月のみ 評価。",
        required: false,
      },
    ],
  },
  {
    name: "alert_audit",
    title: "アラート設定 監査",
    description:
      "argosvix の list_alerts tool で 全 alert を取得し、 plan の制約 (= Free / Pro / Team) と " +
      "実 cost / error rate を 突き合わせて、 通知 channel / sleepMinutes / threshold が 適切か " +
      "review する。 重複 alert や silence しっぱなしの alert も 検出して 提案を出す。",
  },
  {
    name: "incident_triage",
    title: "インシデント トリアージ",
    description:
      "直近 N 時間の error / latency 異常を 調査する。 list_alert_events で 最近の trigger を " +
      "確認し、 query_calls で 該当時間帯の生データを引いて、 root cause (= 特定 model / " +
      "provider 障害 / cost spike) を 推定して report する。",
    arguments: [
      {
        name: "hours",
        description: "調査する遡及時間 (= 例 6 / 24 / 72)。 省略時は 24。",
        required: false,
      },
    ],
  },
];

export interface GetPromptInput {
  name: string;
  args: Record<string, unknown>;
}

export class PromptNotFoundError extends Error {
  constructor(public promptName: string) {
    super(`prompt not found: ${promptName}`);
    this.name = "PromptNotFoundError";
  }
}

export function getPrompt(input: GetPromptInput): GetPromptResult {
  const { name, args } = input;
  switch (name) {
    case "cost_review":
      return buildCostReview(args);
    case "alert_audit":
      return buildAlertAudit();
    case "incident_triage":
      return buildIncidentTriage(args);
    default:
      throw new PromptNotFoundError(name);
  }
}

function buildCostReview(args: Record<string, unknown>): GetPromptResult {
  const month = sanitizeMonth(args["month"]);
  const monthLine = month
    ? `\n比較対象月: ${month} (= 先月との差分も 念頭に置いて分析する)`
    : "\n今月 + 直近 7 日のみを 評価する (= 比較対象月の指定なし)。";
  return {
    description: "Argosvix の cost トレンドを 自動分析する prompt",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "Argosvix tool を使って LLM cost の トレンドを分析してください。\n\n" +
            "実行手順:\n" +
            "1. get_cost_summary(rangePreset=\"24h\", groupBy=\"provider\") を呼んで 直近 24h の cost を取得\n" +
            "2. get_cost_summary(rangePreset=\"7d\", groupBy=\"provider\") を 7d で取得\n" +
            "3. get_cost_summary(rangePreset=\"30d\", groupBy=\"provider\") を 30d で取得\n" +
            "4. provider 別 breakdown を比較し、 以下を report する:\n" +
            "   - 全体 cost の trend (= 増 / 減 / 安定)\n" +
            "   - provider シェアの偏り (= 1 provider に 80% 集中 等)\n" +
            "   - 想定外モデル (= 上位 model に コスト上 違和感ない か)\n" +
            "   - 24h スパイク (= 30d 平均 比で 異常 か)\n" +
            monthLine,
        },
      },
    ],
  };
}

function buildAlertAudit(): GetPromptResult {
  return {
    description: "Argosvix alert 設定を 監査して 改善案を 出す prompt",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "Argosvix の alert 設定を 監査してください。\n\n" +
            "実行手順:\n" +
            "1. list_alerts(includeTriggered=true) で 全 alert + 直近 trigger 状況を取得\n" +
            "2. 各 alert について 以下を review:\n" +
            "   - threshold の妥当性 (= 実 cost / error rate / latency 分布に対して 過敏 or 緩すぎないか)\n" +
            "   - sleepMinutes (= 連続発火を抑制する間隔、 5 分未満は alert 嵐の温床)\n" +
            "   - channel (= Free plan で email のみ / Pro+ で 適切な channel を 使えているか)\n" +
            "   - 重複 (= 同じ provider × 同じ閾値で 複数 alert が ないか)\n" +
            "   - silence しっぱなし (= 長期間 silenced で 実質 disable に なっていないか)\n" +
            "3. 改善案を 「重要度: 高 / 中 / 低」 で 仕分けて 出力する。",
        },
      },
    ],
  };
}

function buildIncidentTriage(args: Record<string, unknown>): GetPromptResult {
  const hours = sanitizeHours(args["hours"]);
  // The instructions used to say "investigate the last N hours" while
  // hard-coding rangePreset="24h", which was self-contradictory. Unified to an
  // absolute time range (startTime/endTime ISO) derived from hours. query_calls
  // does not accept rangePreset, so it cannot be passed in the body directly;
  // instead startTime/endTime are computed and stated explicitly in the text
  // (the LLM receives absolute values).
  const now = Date.now();
  const startIso = new Date(now - hours * 3600 * 1000).toISOString();
  const endIso = new Date(now).toISOString();
  return {
    description: `直近 ${hours}h の error / latency 異常を triage する prompt`,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `直近 ${hours} 時間 (= ${startIso} から ${endIso}) の error / latency ` +
            "異常を 調査してください。\n\n" +
            "実行手順:\n" +
            `1. list_alert_events(limit=50) で 直近 ${hours} 時間の trigger 履歴を取得\n` +
            "2. 異常な provider / model が 浮上したら query_calls で 該当 record を引く。 " +
            `この時 rangePreset は ${hours <= 24 ? "\"24h\"" : hours <= 168 ? "\"7d\"" : "\"30d\""} ` +
            "を 選び (= 上記範囲 を 包含する 最小 preset)、 provider / model で filter する\n" +
            "3. root cause を 以下のいずれかに分類:\n" +
            "   - 特定 provider の障害 (= 全 model で error 同時上昇)\n" +
            "   - 特定 model の degradation (= 同 provider 内で 1 model のみ error)\n" +
            "   - cost spike (= 想定外 model の 過剰呼び出し / loop)\n" +
            "   - latency 上昇 (= timeout 起因か、 prompt 長 起因か)\n" +
            "4. 推定された root cause + 推奨アクションを report。",
        },
      },
    ],
  };
}

function sanitizeMonth(value: unknown): string | null {
  // In addition to the YYYY-MM shape, gate the month's semantic range (1-12)
  // to keep semantically invalid values like "2026-99" out of the prompt body.
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  if (!m) return null;
  const mm = Number(m[2]);
  return mm >= 1 && mm <= 12 ? value : null;
}

function sanitizeHours(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    const n = Math.floor(value);
    if (n >= 1 && n <= 168) return n;
  }
  if (typeof value === "string") {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 168) return n;
  }
  return 24;
}
