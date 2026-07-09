/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { ALLOWED_TOOL_NAMES } from "../tools/mcp-server";

import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

/** The one built-in subagent the main agent may delegate deep read-only investigations to. */
export const CLUSTER_ANALYZER_NAME = "cluster-analyzer";

/**
 * A read-only investigator with its own context. Delegation surfaces as an
 * `Agent` tool call; every tool the subagent runs is still individually gated by
 * `canUseTool` (which fires inside subagents), so the pod-logs consent gate and
 * read-only/approve modes hold. Only the read-only tools are exposed — the
 * qualified names include `mcp__freelens-kube__freelens_pod_logs`. No `model` so
 * the subagent inherits the main model.
 */
export const clusterAnalyzerAgent: AgentDefinition = {
  description:
    "Read-only deep investigation of cluster state: correlating resources, warning events and pod logs " +
    "across many objects. Use for broad health checks or root-cause hunts that would need many tool calls, " +
    "and return a concise findings report.",
  prompt:
    "You are a read-only Kubernetes cluster investigator. Use the available freelens_ read tools " +
    "(list/get resources, pod logs, warning events, cluster version) to gather evidence, correlating " +
    "resources, warning events and logs across many objects to reach a conclusion. You have no mutating " +
    "tools and must never attempt or suggest changes you cannot make yourself; report what you find and " +
    "let the main agent decide on any action. Be economical with tool calls. Finish with a single concise " +
    "findings report: this summary is the only text returned to the main agent, so make it self-contained - " +
    "what you checked, what is wrong, and the most likely root cause.",
  tools: [...ALLOWED_TOOL_NAMES],
};

/** The `agents` option payload: the single built-in `cluster-analyzer` definition. */
export function buildAgents(): Record<string, AgentDefinition> {
  return { [CLUSTER_ANALYZER_NAME]: clusterAnalyzerAgent };
}
