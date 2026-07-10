/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import type { AccountInfo, SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";

import type { ClusterUsageResponse, UsageContributing, UsageWindow } from "../../common/protocol";

/** Human-readable auth method from the account's active API backend. */
function authMethodLabel(account: AccountInfo | undefined): string | undefined {
  if (!account) return undefined;
  switch (account.apiProvider) {
    case "firstParty":
      return "Claude AI";
    case "bedrock":
    case "anthropicAws":
      return "AWS Bedrock";
    case "vertex":
      return "Google Vertex AI";
    case "foundry":
      return "Azure AI Foundry";
    case "gateway":
      return "Gateway";
    case "mantle":
      return "Mantle";
  }
  if (account.apiKeySource) return "API key";
  return account.tokenSource ? "Claude AI" : undefined;
}

const PLAN_LABELS: Record<string, string> = {
  pro: "Claude Pro",
  max: "Claude Max",
  team: "Claude Team",
  enterprise: "Claude Enterprise",
};

/** Human-readable plan from the subscription type (usage data wins over account). */
function planLabel(subscription: string | null | undefined): string | undefined {
  if (!subscription) return undefined;
  return PLAN_LABELS[subscription] ?? `Claude ${subscription}`;
}

type RateLimits = NonNullable<SDKControlGetUsageResponse["rate_limits"]>;
type Window = { utilization: number | null; resets_at: string | null };

function toWindow(label: string, source: Window | null | undefined): UsageWindow | undefined {
  if (!source) return undefined;
  return { label, utilization: source.utilization ?? null, resetsAt: source.resets_at ?? null };
}

/** Ordered rate-limit windows for display: 5-hour, 7-day, per-model, then legacy Opus/Sonnet. */
function toWindows(limits: RateLimits | null | undefined): UsageWindow[] {
  if (!limits) return [];
  const windows = [
    toWindow("Session (5hr)", limits.five_hour),
    toWindow("Weekly (7 day)", limits.seven_day),
    ...(limits.model_scoped ?? []).map((entry) =>
      toWindow(`Weekly ${entry.display_name}`, { utilization: entry.utilization, resets_at: entry.resets_at }),
    ),
    toWindow("Weekly Opus", limits.seven_day_opus),
    toWindow("Weekly Sonnet", limits.seven_day_sonnet),
  ];
  return windows.filter((window): window is UsageWindow => window !== undefined);
}

type BehaviorWindow = NonNullable<SDKControlGetUsageResponse["behaviors"]>["day"];

/** Behaviors for one window, largest share first. */
function toContributing(window: BehaviorWindow): UsageContributing {
  return {
    behaviors: window.behaviors
      .map((behavior) => ({ key: behavior.key, pct: behavior.pct }))
      .sort((a, b) => b.pct - a.pct),
  };
}

/**
 * Shape the raw SDK `accountInfo` and `/usage` responses into the renderer
 * protocol. Tolerant of missing pieces: either input may be undefined, and the
 * plan prefers the usage subscription type over the account's.
 */
export function buildUsageResponse(
  account: AccountInfo | undefined,
  usage: SDKControlGetUsageResponse | undefined,
): ClusterUsageResponse {
  const behaviors = usage?.behaviors ?? null;
  return {
    account: {
      authMethod: authMethodLabel(account),
      email: account?.email,
      organization: account?.organization,
      plan: planLabel(usage?.subscription_type ?? account?.subscriptionType),
    },
    rateLimitsAvailable: usage?.rate_limits_available ?? false,
    windows: toWindows(usage?.rate_limits),
    contributing: behaviors ? { day: toContributing(behaviors.day), week: toContributing(behaviors.week) } : null,
  };
}
