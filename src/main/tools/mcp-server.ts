/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { type PodLogsInput, podLogsSchema, runPodLogs } from "./pod-logs";
import { type ResourcesInput, resourcesSchema, runResources } from "./resources";
import { runWarningEvents, type WarningEventsInput, warningEventsSchema } from "./warning-events";

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";

import type { KubeClient } from "./kube-client";

/** MCP server name; combined with tool names to form `mcp__<server>__<tool>`. */
export const MCP_SERVER_NAME = "freelens-kube";

/** Read-only tools: auto-allowed, listed in the SDK `allowedTools` option. */
export const READ_ONLY_TOOL_NAMES = [
  "kube_resources",
  "kube_pod_logs",
  "kube_warning_events",
  "kube_cluster_version",
] as const;

/** Mutating tools: routed through `canUseTool` for approval. */
export const MUTATING_TOOL_NAMES = [
  "kube_create_resource",
  "kube_update_resource",
  "kube_patch_resource",
  "kube_delete_resource",
  "kube_delete_pod",
  "kube_rollout_restart",
] as const;

/** Qualify a short tool name to its `mcp__<server>__<tool>` form. */
export function qualifyToolName(name: string): string {
  return `mcp__${MCP_SERVER_NAME}__${name}`;
}

/** The short tool name from a fully-qualified `mcp__<server>__<tool>`, or the input unchanged. */
export function unqualifyToolName(name: string): string {
  const prefix = `mcp__${MCP_SERVER_NAME}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** Fully-qualified read-only tool names for the SDK `allowedTools` option. */
export const ALLOWED_TOOL_NAMES = READ_ONLY_TOOL_NAMES.map(qualifyToolName);

/** Fully-qualified mutating tool names (never in `allowedTools`). */
export const MUTATING_QUALIFIED_TOOL_NAMES = MUTATING_TOOL_NAMES.map(qualifyToolName);

/** Whether a fully-qualified or short tool name is one of ours. */
export function isKnownToolName(name: string): boolean {
  const short = unqualifyToolName(name);
  return (
    (READ_ONLY_TOOL_NAMES as readonly string[]).includes(short) ||
    (MUTATING_TOOL_NAMES as readonly string[]).includes(short)
  );
}

/** Whether a fully-qualified or short tool name is a mutating tool. */
export function isMutatingToolName(name: string): boolean {
  return (MUTATING_TOOL_NAMES as readonly string[]).includes(unqualifyToolName(name));
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Run a tool body, converting any thrown error into an explanatory result. */
async function guard(run: () => Promise<string>) {
  try {
    return textResult(await run());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return textResult(`Tool error: ${message}`);
  }
}

/**
 * Build an in-process MCP server exposing the three read-only Kubernetes tools,
 * bound to a single cluster's kube client.
 */
export function createKubeMcpServer(client: KubeClient): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "0.1.0",
    tools: [
      tool(
        "kube_resources",
        "List or get Kubernetes resources of any kind (built-in or CRD). Returns YAML with managedFields stripped.",
        resourcesSchema,
        (args: ResourcesInput) => guard(() => runResources(client, args)),
      ),
      tool(
        "kube_pod_logs",
        "Fetch a snapshot of a pod's logs, optionally filtered by a regex.",
        podLogsSchema,
        (args: PodLogsInput) => guard(() => runPodLogs(client, args)),
      ),
      tool(
        "kube_warning_events",
        "List Warning-type events across the cluster or a namespace, most recent first.",
        warningEventsSchema,
        (args: WarningEventsInput) => guard(() => runWarningEvents(client, args)),
      ),
    ],
  });
}
