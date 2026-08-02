/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";

import type { ClusterContextResponse, ContextCategory } from "../../common/protocol";

/** The `categories` array carried on the SDK context-usage response. */
type SdkCategory = SDKControlGetContextUsageResponse["categories"][number];

/**
 * A category is "free space" when its name reads as such (the SDK includes a
 * Free-space entry so the segments plus the remainder cover the whole window).
 * Matched loosely so a small wording change does not resurrect a double count.
 */
function isFreeSpace(name: string): boolean {
  return /free\s*space/i.test(name);
}

/**
 * Shape the raw SDK `getContextUsage()` response into the renderer protocol.
 * Free-space entries are dropped: the renderer derives the remainder from
 * `maxTokens - totalTokens`, so keeping the SDK's own row would double count it.
 * Tolerant of a missing response (older Claude Code builds) and missing fields.
 */
export function buildContextResponse(usage: SDKControlGetContextUsageResponse | undefined): ClusterContextResponse {
  if (!usage) {
    return { model: "", categories: [], totalTokens: 0, maxTokens: 0, percentage: 0 };
  }
  const categories: ContextCategory[] = (Array.isArray(usage.categories) ? usage.categories : [])
    .filter((category: SdkCategory) => !isFreeSpace(category.name ?? ""))
    .map((category: SdkCategory) => ({
      name: String(category.name ?? ""),
      tokens: category.tokens ?? 0,
      color: String(category.color ?? ""),
    }));
  return {
    model: String(usage.model ?? ""),
    categories,
    totalTokens: usage.totalTokens ?? 0,
    maxTokens: usage.maxTokens ?? 0,
    percentage: usage.percentage ?? 0,
  };
}
