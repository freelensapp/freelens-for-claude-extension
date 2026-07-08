/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Main } from "@freelensapp/extensions";
import { CoreV1Api, KubeConfig, KubernetesObjectApi } from "@kubernetes/client-node";

// Path 1 of the two viable tool backends in D4: a main-process
// `@kubernetes/client-node` client built from the target cluster's kubeconfig
// path and context. This keeps the read-only M0 tools working regardless of
// renderer page lifecycle and gives per-cluster isolation for free.

export interface KubeClient {
  clusterId: string;
  clusterName: string;
  config: KubeConfig;
  objects: KubernetesObjectApi;
  core: CoreV1Api;
}

const clientCache = new Map<string, KubeClient>();

/**
 * Resolve (and cache) a Kubernetes client set for the given cluster id. Throws
 * a descriptive error when the cluster is unknown; callers surface that text as
 * a tool result rather than letting it crash the session.
 */
export function getKubeClient(clusterId: string): KubeClient {
  const cached = clientCache.get(clusterId);
  if (cached) return cached;

  const cluster = Main.Catalog.getClusterById(clusterId);
  if (!cluster) {
    throw new Error(`Cluster "${clusterId}" is not registered in Freelens.`);
  }

  const config = new KubeConfig();
  config.loadFromFile(cluster.kubeConfigPath);
  if (cluster.contextName) {
    config.setCurrentContext(cluster.contextName);
  }

  const client: KubeClient = {
    clusterId,
    clusterName: cluster.name,
    config,
    objects: KubernetesObjectApi.makeApiClient(config),
    core: config.makeApiClient(CoreV1Api),
  };
  clientCache.set(clusterId, client);
  return client;
}

/** Drop a cached client (e.g. when a session is disposed). */
export function disposeKubeClient(clusterId: string): void {
  clientCache.delete(clusterId);
}
