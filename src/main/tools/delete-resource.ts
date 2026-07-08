/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { PatchStrategy } from "@kubernetes/client-node";
import { z } from "zod";

import type { KubernetesObject, KubernetesObjectApi } from "@kubernetes/client-node";

export const deleteResourceSchema = {
  apiVersion: z.string().describe('API group and version, e.g. "v1" or "apps/v1".'),
  kind: z.string().describe('Resource kind, e.g. "ConfigMap".'),
  namespace: z.string().optional().describe("Namespace of the resource. Omit for cluster-scoped kinds."),
  name: z.string().describe("Name of the resource to delete."),
  mode: z
    .enum(["delete", "force_delete", "force_finalize"])
    .optional()
    .describe(
      'Deletion strategy (default "delete"): "delete" is a normal delete; "force_delete" uses grace period 0 with ' +
        'background propagation; "force_finalize" clears metadata.finalizers as a last resort for a resource stuck ' +
        "Terminating.",
    ),
};

const deleteResourceInput = z.object(deleteResourceSchema);
export type DeleteResourceInput = z.infer<typeof deleteResourceInput>;

/** The slice of the Kubernetes client the delete tool needs. */
export interface DeleteResourceClient {
  objects: Pick<KubernetesObjectApi, "delete" | "patch">;
}

/** Delete any Kubernetes resource, optionally forcing or clearing finalizers. */
export async function runDeleteResource(client: DeleteResourceClient, input: DeleteResourceInput): Promise<string> {
  const { apiVersion, kind, namespace, name } = input;
  const mode = input.mode ?? "delete";
  const spec = { apiVersion, kind, metadata: { name, namespace } } as KubernetesObject;

  if (mode === "force_finalize") {
    const patch = { apiVersion, kind, metadata: { name, namespace, finalizers: [] } } as KubernetesObject;
    await client.objects.patch(patch, undefined, undefined, undefined, undefined, PatchStrategy.MergePatch);
    return `Cleared finalizers on ${kind} "${name}"${namespace ? ` in namespace "${namespace}"` : ""}.`;
  }

  if (mode === "force_delete") {
    await client.objects.delete(spec, undefined, undefined, 0, undefined, "Background");
    return `Force-deleted ${kind} "${name}"${namespace ? ` in namespace "${namespace}"` : ""}.`;
  }

  await client.objects.delete(spec);
  return `Deleted ${kind} "${name}"${namespace ? ` in namespace "${namespace}"` : ""}.`;
}
