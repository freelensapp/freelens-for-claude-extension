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

const TOOL_NAMES = ["kube_resources", "kube_pod_logs", "kube_warning_events"] as const;

/** Fully-qualified tool names for the SDK `allowedTools` option. */
export const ALLOWED_TOOL_NAMES = TOOL_NAMES.map((name) => `mcp__${MCP_SERVER_NAME}__${name}`);

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
