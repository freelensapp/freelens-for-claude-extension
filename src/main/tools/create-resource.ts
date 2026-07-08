/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { z } from "zod";
import { stripManagedFields } from "./kube-format";

import type { KubernetesObject, KubernetesObjectApi } from "@kubernetes/client-node";

export const createResourceSchema = {
  manifest: z
    .record(z.string(), z.unknown())
    .describe(
      "The full resource manifest as a JSON object. Must include apiVersion, kind, and metadata.name " +
        "(and metadata.namespace for namespaced kinds). Any metadata.managedFields are ignored.",
    ),
};

const createResourceInput = z.object(createResourceSchema);
export type CreateResourceInput = z.infer<typeof createResourceInput>;

/** The slice of the Kubernetes client the create tool needs. */
export interface CreateResourceClient {
  objects: Pick<KubernetesObjectApi, "create">;
}

/** Read `apiVersion`, `kind`, and `metadata.name`, erroring with a clear message if any is missing. */
function validateManifest(manifest: Record<string, unknown>): { apiVersion: string; kind: string; name: string } {
  const apiVersion = manifest.apiVersion;
  const kind = manifest.kind;
  const metadata = (manifest.metadata ?? {}) as Record<string, unknown>;
  const name = metadata.name;
  if (typeof apiVersion !== "string" || !apiVersion) throw new Error("manifest.apiVersion is required.");
  if (typeof kind !== "string" || !kind) throw new Error("manifest.kind is required.");
  if (typeof name !== "string" || !name) throw new Error("manifest.metadata.name is required.");
  return { apiVersion, kind, name };
}

/** Create any Kubernetes resource from a full manifest. */
export async function runCreateResource(client: CreateResourceClient, input: CreateResourceInput): Promise<string> {
  const { kind, name } = validateManifest(input.manifest);
  const manifest = stripManagedFields(input.manifest) as KubernetesObject;
  const created = await client.objects.create(manifest);
  const namespace = created.metadata?.namespace;
  return `Created ${kind} "${name}"${namespace ? ` in namespace "${namespace}"` : ""}.`;
}
