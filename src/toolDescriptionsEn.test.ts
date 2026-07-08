import { describe, expect, it, vi } from "vitest";

import { tools } from "./tools.js";
import { resources, resourceTemplates } from "./resources.js";
import { prompts } from "./prompts.js";
import {
  PROMPT_OVERLAYS_EN,
  RESOURCE_OVERLAYS_EN,
  RESOURCE_TEMPLATE_OVERLAYS_EN,
  TOOL_DESCRIPTIONS_EN,
  localizePrompts,
  localizeResourceTemplates,
  localizeResources,
  localizeTools,
  resolveMcpLang,
  resolveSchemaNode,
  type SchemaNode,
} from "./toolDescriptionsEn.js";

/**
 * 2026-07-03 = MCP 説明の言語切替 (ARGOSVIX_MCP_LANG)。
 * drift 防御 = 「正本 (tools.ts / resources.ts / prompts.ts) の description 持ち
 * フィールド全部 ⇔ 英語オーバーレイのエントリ全部」の集合一致を CI で固定する。
 * 片方向でなく双方向 assert (= 追加漏れとタイプミスの両方を検出)。
 */

/** 実スキーマから description 持ちフィールドの dot path を再帰収集する。 */
function collectDescribedPaths(
  node: SchemaNode,
  prefix: string,
  out: string[],
): void {
  if (node.properties) {
    for (const [key, child] of Object.entries(node.properties)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof child.description === "string") out.push(path);
      collectDescribedPaths(child, path, out);
    }
  }
  // 配列は items を同じ prefix で透過的に降りる (= resolveSchemaNode と同じ規約)
  if (node.items) {
    collectDescribedPaths(node.items, prefix, out);
  }
}

describe("tool description EN overlay (drift defense)", () => {
  it("全ツール (87 件) がオーバーレイに存在する", () => {
    const overlayNames = new Set(Object.keys(TOOL_DESCRIPTIONS_EN));
    for (const tool of tools) {
      expect(overlayNames.has(tool.name), `missing EN overlay: ${tool.name}`).toBe(
        true,
      );
    }
    expect(tools).toHaveLength(87);
  });

  it("オーバーレイのツール名は全て実在する (= タイプミス検出)", () => {
    const realNames = new Set(tools.map((t) => t.name));
    for (const name of Object.keys(TOOL_DESCRIPTIONS_EN)) {
      expect(realNames.has(name), `unknown tool in EN overlay: ${name}`).toBe(true);
    }
  });

  it("inputs は実スキーマの description 持ちフィールドと双方向一致する", () => {
    for (const tool of tools) {
      const overlay = TOOL_DESCRIPTIONS_EN[tool.name];
      expect(overlay, `missing EN overlay: ${tool.name}`).toBeDefined();
      const described: string[] = [];
      collectDescribedPaths(tool.inputSchema as SchemaNode, "", described);
      const overlayKeys = Object.keys(overlay?.inputs ?? {});
      expect(overlayKeys.sort(), `inputs drift in tool: ${tool.name}`).toEqual(
        described.sort(),
      );
    }
  });

  it("inputs の各 path は resolveSchemaNode で実ノードに解決できる", () => {
    for (const tool of tools) {
      const overlay = TOOL_DESCRIPTIONS_EN[tool.name];
      for (const path of Object.keys(overlay?.inputs ?? {})) {
        const node = resolveSchemaNode(tool.inputSchema as SchemaNode, path);
        expect(node, `${tool.name}: unresolved path "${path}"`).toBeDefined();
        expect(
          typeof node?.description,
          `${tool.name}: path "${path}" has no ja description`,
        ).toBe("string");
      }
    }
  });

  it("description は非空 + 日本語が混入していない (= 英訳漏れ検出)", () => {
    const hasJapanese = (s: string): boolean =>
      /[　-ヿ一-鿿]/.test(s);
    for (const [name, overlay] of Object.entries(TOOL_DESCRIPTIONS_EN)) {
      expect(overlay.description.length, `${name}: empty description`).toBeGreaterThan(0);
      expect(hasJapanese(overlay.description), `${name}: Japanese in EN description`).toBe(false);
      for (const [path, text] of Object.entries(overlay.inputs ?? {})) {
        expect(text.length, `${name}.${path}: empty`).toBeGreaterThan(0);
        expect(hasJapanese(text), `${name}.${path}: Japanese in EN text`).toBe(false);
      }
    }
  });
});

describe("resource / prompt EN overlay (drift defense)", () => {
  it("resources (3 件) と双方向一致", () => {
    expect(Object.keys(RESOURCE_OVERLAYS_EN).sort()).toEqual(
      resources.map((r) => r.name).sort(),
    );
  });

  it("resource templates (8 件) と双方向一致", () => {
    expect(Object.keys(RESOURCE_TEMPLATE_OVERLAYS_EN).sort()).toEqual(
      resourceTemplates.map((t) => t.name).sort(),
    );
  });

  it("prompts (3 件) と双方向一致 + 引数名も実在する", () => {
    expect(Object.keys(PROMPT_OVERLAYS_EN).sort()).toEqual(
      prompts.map((p) => p.name).sort(),
    );
    for (const prompt of prompts) {
      const overlay = PROMPT_OVERLAYS_EN[prompt.name];
      const realArgs = (prompt.arguments ?? []).map((a) => a.name).sort();
      const overlayArgs = Object.keys(overlay?.arguments ?? {}).sort();
      expect(overlayArgs, `prompt args drift: ${prompt.name}`).toEqual(realArgs);
    }
  });
});

describe("resolveMcpLang", () => {
  it("未設定 / 空 / en は en、 ja は ja", () => {
    expect(resolveMcpLang(undefined)).toBe("en");
    expect(resolveMcpLang("")).toBe("en");
    expect(resolveMcpLang("en")).toBe("en");
    expect(resolveMcpLang("ja")).toBe("ja");
  });

  it("不明値は warn して en に倒す", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveMcpLang("fr")).toBe("en");
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

describe("localize* の適用挙動", () => {
  it("en: description が英訳に差し替わり、 元オブジェクトは汚れない", () => {
    const originalDescription = tools[0]!.description;
    const localized = localizeTools(tools, "en");
    expect(localized).toHaveLength(tools.length);
    expect(localized[0]!.description).toBe(
      TOOL_DESCRIPTIONS_EN[tools[0]!.name]!.description,
    );
    // 元 (正本) は日本語のまま = deep copy されている
    expect(tools[0]!.description).toBe(originalDescription);
    expect(localized[0]).not.toBe(tools[0]);
  });

  it("en: inputSchema のフィールド description も差し替わる (nested 含む)", () => {
    const localized = localizeTools(tools, "en");
    const queryCalls = localized.find((t) => t.name === "query_calls")!;
    const limit = resolveSchemaNode(queryCalls.inputSchema as SchemaNode, "limit");
    expect(limit?.description).toBe(
      TOOL_DESCRIPTIONS_EN["query_calls"]!.inputs!["limit"],
    );
    const createAlert = localized.find((t) => t.name === "create_alert")!;
    const metric = resolveSchemaNode(
      createAlert.inputSchema as SchemaNode,
      "conditions.conditions.metric",
    );
    expect(metric?.description).toBe(
      TOOL_DESCRIPTIONS_EN["create_alert"]!.inputs!["conditions.conditions.metric"],
    );
    // 元スキーマは日本語のまま
    const originalMetric = resolveSchemaNode(
      tools.find((t) => t.name === "create_alert")!.inputSchema as SchemaNode,
      "conditions.conditions.metric",
    );
    expect(originalMetric?.description).not.toBe(metric?.description);
  });

  it("ja: 正本をそのまま返す (= 参照同一 = deep copy コストゼロ)", () => {
    expect(localizeTools(tools, "ja")).toBe(tools);
    expect(localizeResources(resources, "ja")).toBe(resources);
    expect(localizeResourceTemplates(resourceTemplates, "ja")).toBe(resourceTemplates);
    expect(localizePrompts(prompts, "ja")).toBe(prompts);
  });

  it("en: resources / templates / prompts の title + description + 引数が差し替わる", () => {
    const r = localizeResources(resources, "en").find((x) => x.name === "account")!;
    expect(r.description).toBe(RESOURCE_OVERLAYS_EN["account"]!.description);
    expect(r["title"]).toBe(RESOURCE_OVERLAYS_EN["account"]!.title);

    const t = localizeResourceTemplates(resourceTemplates, "en").find(
      (x) => x.name === "call_detail",
    )!;
    expect(t.description).toBe(RESOURCE_TEMPLATE_OVERLAYS_EN["call_detail"]!.description);

    const p = localizePrompts(prompts, "en").find((x) => x.name === "cost_review")!;
    expect(p.description).toBe(PROMPT_OVERLAYS_EN["cost_review"]!.description);
    expect(p.arguments?.[0]?.description).toBe(
      PROMPT_OVERLAYS_EN["cost_review"]!.arguments!["month"],
    );
    // 元 prompt の引数 description は日本語のまま
    expect(prompts.find((x) => x.name === "cost_review")!.arguments?.[0]?.description).not.toBe(
      p.arguments?.[0]?.description,
    );
  });
});
