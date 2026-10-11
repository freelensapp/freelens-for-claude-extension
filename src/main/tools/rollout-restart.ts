/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { z } from "zod";

import type { KubeRequests } from "./kube-client";

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
export type RolloutRestartClient = Pick<KubeRequests, "patch">;

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
  const patch = {
    spec: {
      template: {
        metadata: {
          annotations: { "kubectl.kubernetes.io/restartedAt": now() },
        },
      },
    },
  };

  await client.patch({ apiVersion: "apps/v1", kind, namespace, name }, patch, "strategic");
  return `Restarted ${kind} "${name}" in namespace "${namespace}".`;
}
