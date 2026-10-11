/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Main } from "@freelensapp/extensions";
import {
  CoreV1Api,
  HttpMethod,
  IsomorphicFetchHttpLibrary,
  KubeConfig,
  KubernetesObjectApi,
  RequestContext,
  type ResponseContext,
  VersionApi,
} from "@kubernetes/client-node";

// Path 1 of the two viable tool backends in D4: a main-process
// `@kubernetes/client-node` client built from the target cluster's kubeconfig
// path and context. This keeps the read-only M0 tools working regardless of
// renderer page lifecycle and gives per-cluster isolation for free.

/** Arguments for a strategic-merge PATCH against a resource subresource (e.g. scale). */
export interface SubresourcePatchArgs {
  apiVersion: string;
  kind: string;
  namespace?: string;
  name: string;
  subresource: string;
  patch: unknown;
}

export interface KubeClient {
  clusterId: string;
  clusterName: string;
  /** The cluster's kubeconfig file path, passed to spawned CLI tools as `--kubeconfig`. */
  kubeConfigPath: string;
  /** The selected context name, passed to spawned CLI tools as `--context`/`--kube-context`. */
  contextName?: string;
  config: KubeConfig;
  objects: KubernetesObjectApi;
  core: CoreV1Api;
  version: VersionApi;
  /**
   * Strategic-merge PATCH of a resource subresource (`scale`, `resize`,
   * `status`, ...). `KubernetesObjectApi.patch` cannot address a subresource, so
   * this resolves the resource URI via discovery and issues a raw fetch.
   */
  patchSubresource(args: SubresourcePatchArgs): Promise<void>;
}

/**
 * Send a raw request to the API server with the kubeconfig's authentication
 * and TLS settings applied, through the HTTP library of the generated client.
 */
async function sendRequest(
  config: KubeConfig,
  url: string,
  method: HttpMethod,
  headers: Record<string, string> = {},
  body?: string,
): Promise<ResponseContext> {
  const request = new RequestContext(url, method);
  for (const [key, value] of Object.entries(headers)) {
    request.setHeaderParam(key, value);
  }
  if (body !== undefined) {
    request.setBody(body);
  }
  await config.applySecurityAuthentication(request);
  return new IsomorphicFetchHttpLibrary().send(request).toPromise();
}

/** Whether a response has a 2xx status. */
function isSuccess(response: ResponseContext): boolean {
  return response.httpStatusCode >= 200 && response.httpStatusCode < 300;
}

/** Discover the plural resource name for an apiVersion/kind pair. */
async function resolveResourceName(
  config: KubeConfig,
  server: string,
  apiVersion: string,
  kind: string,
): Promise<string> {
  const groupPath = apiVersion.includes("/") ? `/apis/${apiVersion}` : `/api/${apiVersion}`;
  const response = await sendRequest(config, `${server}${groupPath}`, HttpMethod.GET);
  if (!isSuccess(response)) {
    throw new Error(`Failed to discover resources for "${apiVersion}" (${response.httpStatusCode}).`);
  }
  const body = JSON.parse(await response.body.text()) as { resources?: Array<{ name: string; kind: string }> };
  // Skip subresource entries (their names contain a slash, e.g. "deployments/scale").
  const match = body.resources?.find((resource) => resource.kind === kind && !resource.name.includes("/"));
  if (!match) {
    throw new Error(`Could not resolve a resource for kind "${kind}" in "${apiVersion}".`);
  }
  return match.name;
}

async function patchSubresource(config: KubeConfig, args: SubresourcePatchArgs): Promise<void> {
  const cluster = config.getCurrentCluster();
  if (!cluster) throw new Error("No current cluster is set in the kubeconfig.");
  const server = cluster.server.replace(/\/$/, "");
  const plural = await resolveResourceName(config, server, args.apiVersion, args.kind);
  const groupPath = args.apiVersion.includes("/") ? `/apis/${args.apiVersion}` : `/api/${args.apiVersion}`;
  const namespacePath = args.namespace ? `/namespaces/${args.namespace}` : "";
  const url = `${server}${groupPath}${namespacePath}/${plural}/${args.name}/${args.subresource}`;

  const response = await sendRequest(
    config,
    url,
    HttpMethod.PATCH,
    { "Content-Type": "application/strategic-merge-patch+json" },
    JSON.stringify(args.patch),
  );
  if (!isSuccess(response)) {
    const detail = await response.body.text().catch(() => "");
    throw new Error(`Subresource PATCH failed (${response.httpStatusCode})${detail ? `: ${detail}` : ""}.`);
  }
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
    kubeConfigPath: cluster.kubeConfigPath,
    contextName: cluster.contextName,
    config,
    objects: KubernetesObjectApi.makeApiClient(config),
    core: config.makeApiClient(CoreV1Api),
    version: config.makeApiClient(VersionApi),
    patchSubresource: (args) => patchSubresource(config, args),
  };
  clientCache.set(clusterId, client);
  return client;
}

/** Drop a cached client (e.g. when a session is disposed). */
export function disposeKubeClient(clusterId: string): void {
  clientCache.delete(clusterId);
}
