/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { z } from "zod";

import type { CoreV1Api, V1Eviction } from "@kubernetes/client-node";

export const deletePodSchema = {
  namespace: z.string().describe("Namespace of the pod."),
  name: z.string().describe("Pod name."),
  mode: z
    .enum(["evict", "force_delete", "delete_with_finalizers"])
    .describe(
      '"evict" creates a policy/v1 Eviction that honors PodDisruptionBudgets (preferred for voluntary disruption); ' +
        '"force_delete" deletes with grace period 0 (for pods on unreachable or NotReady nodes); ' +
        '"delete_with_finalizers" clears the pod finalizers then deletes (last resort for pods stuck Terminating).',
    ),
};

const deletePodInput = z.object(deletePodSchema);
export type DeletePodInput = z.infer<typeof deletePodInput>;

/** The slice of the Kubernetes client the delete-pod tool needs. */
export interface DeletePodClient {
  core: Pick<CoreV1Api, "createNamespacedPodEviction" | "deleteNamespacedPod" | "patchNamespacedPod">;
}

/** Delete or evict a pod with the requested strategy. */
export async function runDeletePod(client: DeletePodClient, input: DeletePodInput): Promise<string> {
  const { namespace, name, mode } = input;

  if (mode === "evict") {
    const body = {
      apiVersion: "policy/v1",
      kind: "Eviction",
      metadata: { name, namespace },
    } as V1Eviction;
    await client.core.createNamespacedPodEviction({ name, namespace, body });
    return `Evicted pod "${name}" in namespace "${namespace}".`;
  }

  if (mode === "force_delete") {
    await client.core.deleteNamespacedPod({ name, namespace, gracePeriodSeconds: 0 });
    return `Force-deleted pod "${name}" in namespace "${namespace}".`;
  }

  await client.core.patchNamespacedPod({ name, namespace, body: { metadata: { finalizers: [] } } });
  await client.core.deleteNamespacedPod({ name, namespace });
  return `Cleared finalizers and deleted pod "${name}" in namespace "${namespace}".`;
}
