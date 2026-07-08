import { describe, expect, it, vi } from "vitest";

import {
  CORE_TOOL_NAMES,
  resolveToolProfile,
  tools,
  toolsForProfile,
} from "./tools.js";

/**
 * 2026-07-02 #6 = core プロファイル(ARGOSVIX_MCP_PROFILE=core)。
 * 87 ツール全載せのコンテキスト圧迫への対処。既定 full = 挙動不変を固定する。
 */
describe("tool profile (core / full)", () => {
  it("CORE_TOOL_NAMES は実在するツール名のみ(タイプミス・改名ドリフトを CI で検出)", () => {
    const all = new Set(tools.map((t) => t.name));
    for (const name of CORE_TOOL_NAMES) {
      expect(all.has(name), `unknown core tool: ${name}`).toBe(true);
    }
  });

  it("core は 11 ツール、full は全ツール", () => {
    expect(toolsForProfile("core")).toHaveLength(11);
    expect(toolsForProfile("full")).toHaveLength(tools.length);
  });

  it("resolveToolProfile: 未指定/空/full は full、core は core", () => {
    expect(resolveToolProfile(undefined)).toBe("full");
    expect(resolveToolProfile("")).toBe("full");
    expect(resolveToolProfile("full")).toBe("full");
    expect(resolveToolProfile("core")).toBe("core");
  });

  it("resolveToolProfile: 未知値は warn して full に倒す(誤設定でツールが消えない)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveToolProfile("mini")).toBe("full");
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("core の中身 = 記録/集計/コスト/レイテンシ/健康/異常検知/アラート基本/プロンプト解決", () => {
    expect([...CORE_TOOL_NAMES].sort()).toEqual([
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
  });
});
