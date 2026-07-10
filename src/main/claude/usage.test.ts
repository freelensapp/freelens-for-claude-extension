/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { buildUsageResponse } from "./usage";

import type { AccountInfo, SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";

const account = {
  email: "user@example.com",
  organization: "Pay-Eye",
  subscriptionType: "team",
  apiProvider: "firstParty",
  tokenSource: "oauth",
} as AccountInfo;

const emptyBehaviorWindow = {
  request_count: 0,
  session_count: 0,
  behaviors: [],
  agents: [],
  skills: [],
  plugins: [],
  mcp_servers: [],
};

const usage = {
  session: {
    total_cost_usd: 0,
    total_api_duration_ms: 0,
    total_duration_ms: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    model_usage: {},
  },
  subscription_type: "team",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 10, resets_at: "2026-07-10T20:00:00Z" },
    seven_day: { utilization: 3, resets_at: "2026-07-16T00:00:00Z" },
    model_scoped: [{ display_name: "Fable", utilization: 0, resets_at: "2026-07-16T00:00:00Z" }],
  },
  behaviors: {
    day: {
      ...emptyBehaviorWindow,
      behaviors: [
        { key: "subagent_heavy", pct: 17, count: 3 },
        { key: "long_context", pct: 56, count: 9 },
      ],
    },
    week: emptyBehaviorWindow,
  },
} as unknown as SDKControlGetUsageResponse;

describe("buildUsageResponse", () => {
  it("maps account, plan, windows, and sorts contributing behaviors by share", () => {
    const result = buildUsageResponse(account, usage);

    expect(result.account).toEqual({
      authMethod: "Claude AI",
      email: "user@example.com",
      organization: "Pay-Eye",
      plan: "Claude Team",
    });
    expect(result.rateLimitsAvailable).toBe(true);
    expect(result.windows).toEqual([
      { label: "Session (5hr)", utilization: 10, resetsAt: "2026-07-10T20:00:00Z" },
      { label: "Weekly (7 day)", utilization: 3, resetsAt: "2026-07-16T00:00:00Z" },
      { label: "Weekly Fable", utilization: 0, resetsAt: "2026-07-16T00:00:00Z" },
    ]);
    // Largest share first.
    expect(result.contributing?.day.behaviors).toEqual([
      { key: "long_context", pct: 56 },
      { key: "subagent_heavy", pct: 17 },
    ]);
    expect(result.contributing?.week.behaviors).toEqual([]);
  });

  it("returns an empty, safe shape when usage data is missing", () => {
    const result = buildUsageResponse(account, undefined);
    expect(result.rateLimitsAvailable).toBe(false);
    expect(result.windows).toEqual([]);
    expect(result.contributing).toBeNull();
    // Falls back to the account subscription type when usage has none.
    expect(result.account.plan).toBe("Claude Team");
  });

  it("omits windows when plan rate limits do not apply", () => {
    const apiKeyUsage = {
      ...usage,
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null,
      behaviors: null,
    } as unknown as SDKControlGetUsageResponse;
    const result = buildUsageResponse({ apiKeySource: "env" } as AccountInfo, apiKeyUsage);
    expect(result.account.authMethod).toBe("API key");
    expect(result.account.plan).toBeUndefined();
    expect(result.rateLimitsAvailable).toBe(false);
    expect(result.windows).toEqual([]);
    expect(result.contributing).toBeNull();
  });

  it("labels non-first-party providers", () => {
    expect(buildUsageResponse({ apiProvider: "bedrock" } as AccountInfo, undefined).account.authMethod).toBe(
      "AWS Bedrock",
    );
    expect(buildUsageResponse({ apiProvider: "vertex" } as AccountInfo, undefined).account.authMethod).toBe(
      "Google Vertex AI",
    );
  });
});
