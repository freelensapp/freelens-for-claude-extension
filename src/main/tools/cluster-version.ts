/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { z } from "zod";

import type { VersionApi } from "@kubernetes/client-node";

export const clusterVersionSchema = {};

const clusterVersionInput = z.object(clusterVersionSchema);
export type ClusterVersionInput = z.infer<typeof clusterVersionInput>;

/** The slice of the Kubernetes client the cluster-version tool needs. */
export interface ClusterVersionClient {
  version: Pick<VersionApi, "getCode">;
}

/**
 * Report the API server version: gitVersion, major/minor, platform, buildDate.
 * Hits the `/version` endpoint through {@link VersionApi.getCode}.
 */
export async function runClusterVersion(client: ClusterVersionClient): Promise<string> {
  const info = await client.version.getCode();
  return [
    `Kubernetes ${info.gitVersion}`,
    `major/minor: ${info.major}.${info.minor}`,
    `platform: ${info.platform}`,
    `buildDate: ${info.buildDate}`,
  ].join("\n");
}
