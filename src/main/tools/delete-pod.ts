/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { z } from "zod";

import type { KubeRequests } from "./kube-client";

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
export type DeletePodClient = Pick<KubeRequests, "evictPod" | "delete" | "patch">;

/** Delete or evict a pod with the requested strategy. */
export async function runDeletePod(client: DeletePodClient, input: DeletePodInput): Promise<string> {
  const { namespace, name, mode } = input;
  const ref = { apiVersion: "v1", kind: "Pod", namespace, name };

  if (mode === "evict") {
    await client.evictPod(namespace, name);
    return `Evicted pod "${name}" in namespace "${namespace}".`;
  }

  if (mode === "force_delete") {
    await client.delete(ref, { gracePeriodSeconds: 0 });
    return `Force-deleted pod "${name}" in namespace "${namespace}".`;
  }

  await client.patch(ref, { metadata: { finalizers: [] } }, "merge");
  await client.delete(ref);
  return `Cleared finalizers and deleted pod "${name}" in namespace "${namespace}".`;
}
