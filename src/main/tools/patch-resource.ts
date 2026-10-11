/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { z } from "zod";

import type { KubeRequests } from "./kube-client";

export const patchResourceSchema = {
  apiVersion: z.string().describe('API group and version, e.g. "v1" or "apps/v1".'),
  kind: z.string().describe('Resource kind, e.g. "Deployment".'),
  namespace: z.string().optional().describe("Namespace of the resource. Omit for cluster-scoped kinds."),
  name: z.string().describe("Name of the resource to patch."),
  patch: z
    .record(z.string(), z.unknown())
    .describe("The patch document as a JSON object, e.g. { spec: { replicas: 3 } }."),
  subresource: z
    .string()
    .optional()
    .describe(
      'Target a subresource with a strategic-merge patch, e.g. "scale" to scale a workload with ' +
        '{ spec: { replicas: N } }, or "resize". Omit to patch the resource itself with a JSON merge patch.',
    ),
};

const patchResourceInput = z.object(patchResourceSchema);
export type PatchResourceInput = z.infer<typeof patchResourceInput>;

/** The slice of the Kubernetes client the patch tool needs. */
export type PatchResourceClient = Pick<KubeRequests, "patch">;

/** Patch a Kubernetes resource, or a subresource such as `scale`, with the appropriate patch strategy. */
export async function runPatchResource(client: PatchResourceClient, input: PatchResourceInput): Promise<string> {
  const { apiVersion, kind, namespace, name, patch } = input;
  const subresource = input.subresource?.trim().toLowerCase();

  if (subresource) {
    await client.patch({ apiVersion, kind, namespace, name, subresource }, patch, "strategic");
    return `Patched ${kind} "${name}" subresource "${subresource}"${namespace ? ` in namespace "${namespace}"` : ""}.`;
  }

  await client.patch({ apiVersion, kind, namespace, name }, patch, "merge");
  return `Patched ${kind} "${name}"${namespace ? ` in namespace "${namespace}"` : ""}.`;
}
