/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { z } from "zod";

import type { KubeRequests } from "./kube-client";

export const clusterVersionSchema = {};

const clusterVersionInput = z.object(clusterVersionSchema);
export type ClusterVersionInput = z.infer<typeof clusterVersionInput>;

/** The slice of the Kubernetes client the cluster-version tool needs. */
export type ClusterVersionClient = Pick<KubeRequests, "version">;

/**
 * Report the API server version: gitVersion, major/minor, platform, buildDate.
 * Hits the `/version` endpoint.
 */
export async function runClusterVersion(client: ClusterVersionClient): Promise<string> {
  const info = await client.version();
  return [
    `Kubernetes ${info.gitVersion}`,
    `major/minor: ${info.major}.${info.minor}`,
    `platform: ${info.platform}`,
    `buildDate: ${info.buildDate}`,
  ].join("\n");
}
