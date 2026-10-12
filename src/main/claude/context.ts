/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";

import type { ClusterContextResponse, ContextCategory } from "../../common/protocol";

/** The `categories` array carried on the SDK context-usage response. */
type SdkCategory = SDKControlGetContextUsageResponse["categories"][number];

/**
 * Whether a category lies outside the used window: the free space (the SDK
 * includes it so the segments plus the remainder cover the whole window) or a
 * deferred tool schema, which is listed but not loaded into the window. The
 * SDK classifies each row in `kind`; older Claude Code builds send no `kind`,
 * so their rows fall back to `isDeferred` and to the name, matched loosely.
 */
function isOutsideWindow(category: SdkCategory): boolean {
  const kind: SdkCategory["kind"] | undefined = category.kind;
  if (kind) return kind === "free" || kind === "deferred";
  return category.isDeferred === true || /free\s*space/i.test(category.name ?? "");
}

/**
 * Shape the raw SDK `getContextUsage()` response into the renderer protocol.
 * Free-space and deferred entries are dropped: the renderer derives the
 * remainder from `maxTokens - totalTokens`, so keeping the SDK's free row would
 * double count it, and deferred rows take no room in the window.
 * Tolerant of a missing response (older Claude Code builds) and missing fields.
 */
export function buildContextResponse(usage: SDKControlGetContextUsageResponse | undefined): ClusterContextResponse {
  if (!usage) {
    return { model: "", categories: [], totalTokens: 0, maxTokens: 0, percentage: 0 };
  }
  const categories: ContextCategory[] = (Array.isArray(usage.categories) ? usage.categories : [])
    .filter((category: SdkCategory) => !isOutsideWindow(category))
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
