/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { z } from "zod";
import { stripManagedFields } from "./kube-format";

import type { KubernetesObject, KubernetesObjectApi } from "@kubernetes/client-node";

export const updateResourceSchema = {
  manifest: z
    .record(z.string(), z.unknown())
    .describe(
      "The full replacement manifest as a JSON object (apiVersion, kind, metadata.name required). This replaces the " +
        "existing resource wholesale, so include every field you want to keep. metadata.resourceVersion is carried " +
        "over from the live object when omitted.",
    ),
};

const updateResourceInput = z.object(updateResourceSchema);
export type UpdateResourceInput = z.infer<typeof updateResourceInput>;

/** The slice of the Kubernetes client the update tool needs. */
export interface UpdateResourceClient {
  objects: Pick<KubernetesObjectApi, "read" | "replace">;
}

function validateManifest(manifest: Record<string, unknown>): {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
} {
  const apiVersion = manifest.apiVersion;
  const kind = manifest.kind;
  const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;
  const name = metadata.name;
  const namespace = typeof metadata.namespace === "string" ? metadata.namespace : undefined;
  if (typeof apiVersion !== "string" || !apiVersion) throw new Error("manifest.apiVersion is required.");
  if (typeof kind !== "string" || !kind) throw new Error("manifest.kind is required.");
  if (typeof name !== "string" || !name) throw new Error("manifest.metadata.name is required.");
  return { apiVersion, kind, name, namespace };
}

/** Replace any Kubernetes resource with a full manifest, carrying over the live resourceVersion. */
export async function runUpdateResource(client: UpdateResourceClient, input: UpdateResourceInput): Promise<string> {
  const { apiVersion, kind, name, namespace } = validateManifest(input.manifest);
  const manifest = stripManagedFields(input.manifest) as KubernetesObject;
  const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;

  if (!metadata.resourceVersion) {
    const current = await client.objects.read({ apiVersion, kind, metadata: { name, namespace } });
    manifest.metadata = { ...metadata, resourceVersion: current.metadata?.resourceVersion };
  }

  await client.objects.replace(manifest);
  return `Updated ${kind} "${name}"${namespace ? ` in namespace "${namespace}"` : ""}.`;
}
