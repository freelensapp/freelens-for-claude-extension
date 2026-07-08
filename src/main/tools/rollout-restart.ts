/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { PatchStrategy } from "@kubernetes/client-node";
import { z } from "zod";

import type { KubernetesObject, KubernetesObjectApi } from "@kubernetes/client-node";

/** Workload kinds that support a rollout restart. */
const RESTARTABLE_KINDS = ["Deployment", "DaemonSet", "StatefulSet"] as const;

export const rolloutRestartSchema = {
  kind: z.enum(RESTARTABLE_KINDS).describe("Workload kind: Deployment, DaemonSet, or StatefulSet."),
  namespace: z.string().describe("Namespace of the workload."),
  name: z.string().describe("Name of the workload."),
};

const rolloutRestartInput = z.object(rolloutRestartSchema);
export type RolloutRestartInput = z.infer<typeof rolloutRestartInput>;

/** The slice of the Kubernetes client the rollout-restart tool needs. */
export interface RolloutRestartClient {
  objects: Pick<KubernetesObjectApi, "patch">;
}

/**
 * Trigger a rolling restart by stamping
 * `spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]`,
 * exactly as `kubectl rollout restart` does.
 */
export async function runRolloutRestart(
  client: RolloutRestartClient,
  input: RolloutRestartInput,
  now: () => string = () => new Date().toISOString(),
): Promise<string> {
  const { kind, namespace, name } = input;
  const spec = {
    apiVersion: "apps/v1",
    kind,
    metadata: { name, namespace },
    spec: {
      template: {
        metadata: {
          annotations: { "kubectl.kubernetes.io/restartedAt": now() },
        },
      },
    },
  } as KubernetesObject;

  await client.objects.patch(spec, undefined, undefined, undefined, undefined, PatchStrategy.StrategicMergePatch);
  return `Restarted ${kind} "${name}" in namespace "${namespace}".`;
}
