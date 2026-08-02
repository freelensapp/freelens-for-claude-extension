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
          { name: "System prompt", tokens: 3900, color: "#c8963e" },
          { name: "Messages", tokens: 453_200, color: "#9c1f1f" },
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

  it("drops the SDK free-space category so the renderer derives the remainder", () => {
    const result = buildContextResponse(
      sdkResponse({
        maxTokens: 1_000_000,
        totalTokens: 500_000,
        categories: [
          { name: "Messages", tokens: 500_000, color: "#9c1f1f" },
          { name: "Free space", tokens: 500_000, color: "#333333" },
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
