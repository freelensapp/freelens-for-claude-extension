/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_POD_LOGS_TAIL_LINES } from "../../common/preferences-store";
import { RESERVED_MCP_SERVER_NAME } from "../../common/protocol";
import { ProcessRegistry } from "./cli-exec";
import { clusterVersionSchema, runClusterVersion } from "./cluster-version";
import { type CreateResourceInput, createResourceSchema, runCreateResource } from "./create-resource";
import { type DeletePodInput, deletePodSchema, runDeletePod } from "./delete-pod";
import { type DeleteResourceInput, deleteResourceSchema, runDeleteResource } from "./delete-resource";
import { type HelmInput, helmSchema, runHelm } from "./helm";
import { type KubectlInput, kubectlSchema, runKubectl } from "./kubectl";
import { type PatchResourceInput, patchResourceSchema, runPatchResource } from "./patch-resource";
import { type PodLogsInput, podLogsSchema, runPodLogs } from "./pod-logs";
import { type ResourcesInput, resourcesSchema, runResources } from "./resources";
import { type RolloutRestartInput, rolloutRestartSchema, runRolloutRestart } from "./rollout-restart";
import { runUpdateResource, type UpdateResourceInput, updateResourceSchema } from "./update-resource";
import { runWarningEvents, type WarningEventsInput, warningEventsSchema } from "./warning-events";

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";

import type { KubeClient } from "./kube-client";

/** MCP server name; combined with tool names to form `mcp__<server>__<tool>`. */
export const MCP_SERVER_NAME = RESERVED_MCP_SERVER_NAME;

/** Read-only tools: auto-allowed, listed in the SDK `allowedTools` option. */
export const READ_ONLY_TOOL_NAMES = [
  "freelens_resources",
  "freelens_pod_logs",
  "freelens_warning_events",
  "freelens_cluster_version",
] as const;

/** Mutating tools: routed through `canUseTool` for approval. */
export const MUTATING_TOOL_NAMES = [
  "freelens_create_resource",
  "freelens_update_resource",
  "freelens_patch_resource",
  "freelens_delete_resource",
  "freelens_delete_pod",
  "freelens_rollout_restart",
  "freelens_kubectl",
  "freelens_helm",
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

/**
 * The tool descriptions registered with the SDK, keyed by short tool name.
 * Single source of truth so the Available Tools panel cannot drift from the
 * registrations below.
 */
const TOOL_DESCRIPTIONS: Record<string, string> = {
  freelens_resources:
    "List or get Kubernetes resources of any kind (built-in or CRD). Returns YAML with managedFields stripped.",
  freelens_pod_logs: "Fetch a snapshot of a pod's logs, optionally filtered by a regex.",
  freelens_warning_events: "List Warning-type events across the cluster or a namespace, most recent first.",
  freelens_cluster_version: "Report the Kubernetes API server version (gitVersion, major/minor, platform, buildDate).",
  freelens_create_resource: "Create a Kubernetes resource from a full manifest. Requires user approval.",
  freelens_update_resource: "Replace a Kubernetes resource with a full manifest. Requires user approval.",
  freelens_patch_resource:
    'Patch a Kubernetes resource (JSON merge patch), or a subresource like "scale" with a strategic-merge ' +
    "patch to scale a workload via { spec: { replicas: N } }. Requires user approval.",
  freelens_delete_resource:
    "Delete a Kubernetes resource (normal, force, or finalizer-clearing). Requires user approval.",
  freelens_delete_pod:
    "Evict or delete a pod (evict, force_delete, or delete_with_finalizers). Requires user approval.",
  freelens_rollout_restart:
    "Trigger a rolling restart of a Deployment, DaemonSet, or StatefulSet. Requires user approval.",
  freelens_kubectl:
    "Run kubectl against this cluster (argv array, no shell) as a fallback for actions the dedicated freelens_ " +
    "tools do not cover. Prefer the dedicated tools; requires user approval.",
  freelens_helm:
    "Run helm against this cluster (argv array, no shell) as a fallback for actions the dedicated freelens_ " +
    "tools do not cover. Prefer the dedicated tools; requires user approval.",
};

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
 * Build an in-process MCP server exposing the Kubernetes tools, bound to a
 * single cluster's kube client. `podLogsTailLines` is read lazily on each call
 * so a preference change applies without rebuilding the server.
 */
export function createKubeMcpServer(
  client: KubeClient,
  podLogsTailLines: () => number = () => DEFAULT_POD_LOGS_TAIL_LINES,
  registry: ProcessRegistry = new ProcessRegistry(),
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "0.1.0",
    tools: [
      tool("freelens_resources", TOOL_DESCRIPTIONS.freelens_resources, resourcesSchema, (args: ResourcesInput) =>
        guard(() => runResources(client, args)),
      ),
      tool("freelens_pod_logs", TOOL_DESCRIPTIONS.freelens_pod_logs, podLogsSchema, (args: PodLogsInput) =>
        guard(() => runPodLogs(client, args, podLogsTailLines())),
      ),
      tool(
        "freelens_warning_events",
        TOOL_DESCRIPTIONS.freelens_warning_events,
        warningEventsSchema,
        (args: WarningEventsInput) => guard(() => runWarningEvents(client, args)),
      ),
      tool("freelens_cluster_version", TOOL_DESCRIPTIONS.freelens_cluster_version, clusterVersionSchema, () =>
        guard(() => runClusterVersion(client)),
      ),
      tool(
        "freelens_create_resource",
        TOOL_DESCRIPTIONS.freelens_create_resource,
        createResourceSchema,
        (args: CreateResourceInput) => guard(() => runCreateResource(client, args)),
      ),
      tool(
        "freelens_update_resource",
        TOOL_DESCRIPTIONS.freelens_update_resource,
        updateResourceSchema,
        (args: UpdateResourceInput) => guard(() => runUpdateResource(client, args)),
      ),
      tool(
        "freelens_patch_resource",
        TOOL_DESCRIPTIONS.freelens_patch_resource,
        patchResourceSchema,
        (args: PatchResourceInput) => guard(() => runPatchResource(client, args)),
      ),
      tool(
        "freelens_delete_resource",
        TOOL_DESCRIPTIONS.freelens_delete_resource,
        deleteResourceSchema,
        (args: DeleteResourceInput) => guard(() => runDeleteResource(client, args)),
      ),
      tool("freelens_delete_pod", TOOL_DESCRIPTIONS.freelens_delete_pod, deletePodSchema, (args: DeletePodInput) =>
        guard(() => runDeletePod(client, args)),
      ),
      tool(
        "freelens_rollout_restart",
        TOOL_DESCRIPTIONS.freelens_rollout_restart,
        rolloutRestartSchema,
        (args: RolloutRestartInput) => guard(() => runRolloutRestart(client, args)),
      ),
      tool("freelens_kubectl", TOOL_DESCRIPTIONS.freelens_kubectl, kubectlSchema, (args: KubectlInput) =>
        guard(() =>
          runKubectl({ kubeConfigPath: client.kubeConfigPath, contextName: client.contextName, registry }, args),
        ),
      ),
      tool("freelens_helm", TOOL_DESCRIPTIONS.freelens_helm, helmSchema, (args: HelmInput) =>
        guard(() =>
          runHelm({ kubeConfigPath: client.kubeConfigPath, contextName: client.contextName, registry }, args),
        ),
      ),
    ],
  });
}
