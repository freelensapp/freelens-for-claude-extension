/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { buildContextResponse } from "./context";

import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";

/** A minimal SDK context-usage response; only the mapped fields matter here. */
function sdkResponse(overrides: Partial<SDKControlGetContextUsageResponse> = {}): SDKControlGetContextUsageResponse {
  return {
    categories: [],
    totalTokens: 0,
    maxTokens: 0,
    rawMaxTokens: 0,
    percentage: 0,
    gridRows: [],
    model: "",
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    isAutoCompactEnabled: false,
    apiUsage: null,
    ...overrides,
  } as SDKControlGetContextUsageResponse;
}

describe("buildContextResponse", () => {
  it("returns an empty breakdown when the SDK reports nothing", () => {
    expect(buildContextResponse(undefined)).toEqual({
      model: "",
      categories: [],
      totalTokens: 0,
      maxTokens: 0,
      percentage: 0,
    });
  });

  it("maps categories, totals, and the model through", () => {
    const result = buildContextResponse(
      sdkResponse({
        model: "claude-opus-5",
        totalTokens: 497_300,
        maxTokens: 1_000_000,
        percentage: 50,
        categories: [
          { name: "System prompt", tokens: 3900, color: "#c8963e", kind: "used" },
          { name: "Messages", tokens: 453_200, color: "#9c1f1f", kind: "used" },
        ],
      }),
    );
    expect(result).toEqual({
      model: "claude-opus-5",
      totalTokens: 497_300,
      maxTokens: 1_000_000,
      percentage: 50,
      categories: [
        { name: "System prompt", tokens: 3900, color: "#c8963e" },
        { name: "Messages", tokens: 453_200, color: "#9c1f1f" },
      ],
    });
  });

  it("drops the free and deferred categories by kind so the renderer derives the remainder", () => {
    const result = buildContextResponse(
      sdkResponse({
        maxTokens: 1_000_000,
        totalTokens: 500_000,
        categories: [
          { name: "Messages", tokens: 450_000, color: "#9c1f1f", kind: "used" },
          { name: "Autocompact buffer", tokens: 50_000, color: "#666666", kind: "buffer" },
          { name: "MCP tools (deferred)", tokens: 20_000, color: "#444444", isDeferred: true, kind: "deferred" },
          { name: "Remaining", tokens: 500_000, color: "#333333", kind: "free" },
        ],
      }),
    );
    expect(result.categories).toEqual([
      { name: "Messages", tokens: 450_000, color: "#9c1f1f" },
      { name: "Autocompact buffer", tokens: 50_000, color: "#666666" },
    ]);
  });

  it("falls back to the name and isDeferred when an older Claude Code sends no kind", () => {
    type Category = SDKControlGetContextUsageResponse["categories"][number];
    const result = buildContextResponse(
      sdkResponse({
        categories: [
          { name: "Messages", tokens: 500_000, color: "#9c1f1f" } as Category,
          { name: "MCP tools", tokens: 20_000, color: "#444444", isDeferred: true } as Category,
          { name: "Free space", tokens: 500_000, color: "#333333" } as Category,
        ],
      }),
    );
    expect(result.categories).toEqual([{ name: "Messages", tokens: 500_000, color: "#9c1f1f" }]);
  });

  it("tolerates missing fields on the categories", () => {
    const result = buildContextResponse(
      sdkResponse({
        categories: [{ name: "MCP tools" } as SDKControlGetContextUsageResponse["categories"][number]],
      }),
    );
    expect(result.categories).toEqual([{ name: "MCP tools", tokens: 0, color: "" }]);
  });
});
