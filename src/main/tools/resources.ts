/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { z } from "zod";
import { DEFAULT_LIST_LIMIT, selectFields, stripManagedFields, toYaml } from "./kube-format";

import type { KubernetesObjectApi } from "@kubernetes/client-node";

export const resourcesSchema = {
  apiVersion: z.string().describe('API group and version, e.g. "v1" or "apps/v1".'),
  kind: z.string().describe('Resource kind, e.g. "Pod" or "Deployment".'),
  namespace: z.string().optional().describe("Namespace to scope the query. Omit for cluster-scoped or all namespaces."),
  name: z.string().optional().describe("Name of a single resource to get. Omit to list."),
  labelSelector: z.string().optional().describe('Label selector for list queries, e.g. "app=nginx".'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Maximum number of items to return when listing (default ${DEFAULT_LIST_LIMIT}).`),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      "JSONPath-subset selectors to project each object down to, e.g. " +
        '["metadata.name", "spec.containers[*].image", "status.conditions[0].type", ' +
        "\"metadata.labels['app.kubernetes.io/name']\"]. Supports dot keys, [*] wildcards, numeric and negative " +
        "indexes, and bracketed quoted keys.",
    ),
  includeManagedFields: z
    .boolean()
    .optional()
    .describe("Include metadata.managedFields in the output (default false; they are noisy and rarely useful)."),
};

const resourcesInput = z.object(resourcesSchema);
export type ResourcesInput = z.infer<typeof resourcesInput>;

/** The slice of the Kubernetes client the resources tool needs. */
export interface ResourcesClient {
  objects: Pick<KubernetesObjectApi, "list" | "read">;
}

/**
 * List or get Kubernetes resources of any kind. Returns YAML with
 * `metadata.managedFields` stripped; lists are truncated to `limit`.
 */
export async function runResources(client: ResourcesClient, input: ResourcesInput): Promise<string> {
  const { apiVersion, kind, namespace, name, labelSelector, fields, includeManagedFields } = input;
  const limit = input.limit ?? DEFAULT_LIST_LIMIT;

  // Project a single object: strip managedFields unless opted in, then apply field selection.
  const project = <T>(object: T): unknown => {
    const stripped = includeManagedFields ? object : stripManagedFields(object);
    return fields && fields.length > 0 ? selectFields(stripped, fields) : stripped;
  };

  if (name) {
    const resource = await client.objects.read({
      apiVersion,
      kind,
      metadata: { name, namespace },
    });
    return toYaml(project(resource));
  }

  const list = await client.objects.list(
    apiVersion,
    kind,
    namespace,
    undefined,
    undefined,
    undefined,
    undefined,
    labelSelector,
    // Request one extra item so we can tell whether more exist.
    limit + 1,
  );

  const items = Array.isArray(list.items) ? list.items : [];
  const truncated = items.length > limit;
  const page = truncated ? items.slice(0, limit) : items;
  const yaml = toYaml({ items: page.map((item) => project(item)) });

  if (page.length === 0) {
    return `No ${kind} resources found${namespace ? ` in namespace "${namespace}"` : ""}.`;
  }
  if (truncated) {
    return `${yaml}\n# ... list truncated to ${limit} items; more resources exist.`;
  }
  return yaml;
}
