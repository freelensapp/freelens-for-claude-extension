/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Common, Main } from "@freelensapp/extensions";

// The tools reach the cluster through Freelens: `KubeJsonApi.forCluster` sends
// every request to the Freelens proxy, which forwards it to the cluster's
// `freelens-k8s-proxy`. That proxy authenticates with the cluster's kubeconfig
// and applies its proxy settings, so the tools see the cluster exactly as the
// rest of Freelens does.

/** The `KubeJsonApi` instance the host builds for a cluster. */
type KubeJsonApi = ReturnType<typeof Main.K8sApi.KubeJsonApi.forCluster>;

/** The part of {@link KubeJsonApi} the client uses. */
export type KubeJsonApiLike = Pick<KubeJsonApi, "get" | "post" | "put" | "patch" | "del" | "getResponse">;

/**
 * Time allowed for one request, response body included. A list over all
 * namespaces of a large cluster, or a long log tail, can take tens of seconds;
 * nothing on the path to the cluster times out on its own, so without a limit
 * an unanswered request would hang the tool call.
 */
export const REQUEST_TIMEOUT_MS = 60_000;

/** A Kubernetes object as the API server returns it. */
export interface KubeObjectData {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string; resourceVersion?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** A Kubernetes list as the API server returns it. */
export interface KubeListData<T = KubeObjectData> {
  items?: T[];
  [key: string]: unknown;
}

/** The `/version` response of the API server. */
export interface KubeVersionInfo {
  major?: string;
  minor?: string;
  gitVersion?: string;
  platform?: string;
  buildDate?: string;
}

/** One resource, addressed by kind and name. */
export interface ResourceRef {
  apiVersion: string;
  kind: string;
  namespace?: string;
  name: string;
}

export interface ListArgs {
  apiVersion: string;
  kind: string;
  /** Omit for all namespaces. Ignored for a cluster-scoped kind. */
  namespace?: string;
  labelSelector?: string;
  fieldSelector?: string;
  limit?: number;
}

/** Content types of the patch strategies the tools use. */
const PATCH_CONTENT_TYPES = {
  merge: "application/merge-patch+json",
  strategic: "application/strategic-merge-patch+json",
} as const;

export type PatchType = keyof typeof PATCH_CONTENT_TYPES;

export interface DeleteOptions {
  gracePeriodSeconds?: number;
  propagationPolicy?: "Foreground" | "Background" | "Orphan";
}

export interface PodLogOptions {
  container?: string;
  tailLines?: number;
  previous?: boolean;
  timestamps?: boolean;
}

/** The requests the tools send to a cluster. */
export interface KubeRequests {
  read(ref: ResourceRef): Promise<KubeObjectData>;
  list(args: ListArgs): Promise<KubeListData>;
  create(manifest: KubeObjectData): Promise<KubeObjectData>;
  /** PUT the full manifest in place of the live object. */
  replace(manifest: KubeObjectData): Promise<KubeObjectData>;
  /** PATCH the object, or one of its subresources (`scale`, `resize`, `status`, ...). */
  patch(ref: ResourceRef & { subresource?: string }, patch: Record<string, unknown>, type: PatchType): Promise<unknown>;
  delete(ref: ResourceRef, options?: DeleteOptions): Promise<unknown>;
  /** Create a policy/v1 Eviction for a pod. */
  evictPod(namespace: string, name: string): Promise<unknown>;
  /** The pod's log as plain text. */
  podLog(namespace: string, name: string, options: PodLogOptions): Promise<string>;
  /** The API server version (`/version`). */
  version(): Promise<KubeVersionInfo>;
}

export interface KubeClient extends KubeRequests {
  clusterId: string;
  clusterName: string;
  /** The cluster's kubeconfig file path, passed to spawned CLI tools as `--kubeconfig`. */
  kubeConfigPath: string;
  /** The selected context name, passed to spawned CLI tools as `--context`/`--kube-context`. */
  contextName?: string;
}

/** A `Status` object of the API server, as far as the client reads it. */
interface KubeStatus {
  kind: "Status";
  message?: string;
  reason?: string;
  code?: number;
}

function isKubeStatus(value: unknown): value is KubeStatus {
  return Boolean(value) && typeof value === "object" && (value as { kind?: unknown }).kind === "Status";
}

/** The message of a `Status`, or its reason and code when it has none. */
function statusMessage(status: KubeStatus): string {
  if (status.message) return status.message;
  return [status.reason, status.code ? `(${status.code})` : undefined].filter(Boolean).join(" ");
}

/**
 * Turn whatever a `KubeJsonApi` call rejects with into an `Error` with a
 * readable message. A failed request rejects with a `JsonApiErrorParsed`,
 * which is not an `Error` but whose `toString()` is the `Status` message; a
 * GET answered 403 rejects with the response body itself, the `Status` object
 * or its text; `fetch` rejects with an `Error` (a `TimeoutError` when the
 * request's signal fires, a `TypeError` with a `cause` when the connection
 * fails).
 */
export function toKubeError(error: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Error {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") {
      return new Error(`The request to the cluster timed out after ${timeoutMs / 1000} seconds.`);
    }
    const cause = error.cause instanceof Error ? error.cause.message : undefined;
    return cause && !error.message.includes(cause) ? new Error(`${error.message}: ${cause}`) : error;
  }
  if (isKubeStatus(error)) {
    const message = statusMessage(error);
    if (message) return new Error(message);
  }
  if (typeof error === "string" && error.trim()) {
    return new Error(error.trim());
  }
  const text = String(error);
  if (text && text !== "[object Object]") {
    return new Error(text);
  }
  return new Error("The request to the cluster failed.");
}

/** Options for one request: the timeout, and the content type of a patch. */
function requestInit(contentType?: string) {
  return {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    // `JsonApi` merges these into its default `content-type` header; a key in
    // another case would be sent next to it rather than replace it.
    ...(contentType ? { headers: { "content-type": contentType } } : {}),
  };
}

/** A query without its unset parameters, which would be sent as empty values. */
function compactQuery(query: Record<string, string | number | boolean | undefined>) {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** `/api/<version>` for the core group, `/apis/<group>/<version>` otherwise. */
function groupPath(apiVersion: string): string {
  return apiVersion.includes("/") ? `/apis/${apiVersion}` : `/api/${apiVersion}`;
}

/** One entry of an `APIResourceList`. */
interface ApiResource {
  name: string;
  kind: string;
  namespaced: boolean;
}

/**
 * Build the requests on a `KubeJsonApi`. `getApi` is called for every request,
 * so it can refuse a cluster that is no longer connected.
 */
export function createKubeRequests(getApi: () => KubeJsonApiLike): KubeRequests {
  const discovery = new Map<string, ApiResource[]>();

  /** Run one request and turn its rejection into an `Error`. */
  async function send<T>(run: (api: KubeJsonApiLike) => Promise<unknown>): Promise<T> {
    const api = getApi();
    try {
      return (await run(api)) as T;
    } catch (error) {
      throw toKubeError(error);
    }
  }

  async function fetchResources(apiVersion: string): Promise<ApiResource[]> {
    const api = getApi();
    let list: { resources?: ApiResource[] } | undefined;
    try {
      list = await api.get(groupPath(apiVersion), {}, requestInit());
    } catch (error) {
      throw new Error(`Failed to discover resources for "${apiVersion}": ${toKubeError(error).message}`);
    }
    const resources = Array.isArray(list?.resources) ? list.resources : [];
    discovery.set(apiVersion, resources);
    return resources;
  }

  /**
   * The resource of a kind, from the API server's discovery. The resources of
   * an apiVersion are cached; an unknown kind fetches them again, for a CRD
   * installed since.
   */
  async function resolveResource(apiVersion: string, kind: string): Promise<ApiResource> {
    // Skip subresource entries (their names contain a slash, e.g. "deployments/scale").
    const find = (resources: ApiResource[]) =>
      resources.find((resource) => resource.kind === kind && !resource.name.includes("/"));
    const resource = find(discovery.get(apiVersion) ?? []) ?? find(await fetchResources(apiVersion));
    if (!resource) {
      throw new Error(`Could not resolve a resource for kind "${kind}" in "${apiVersion}".`);
    }
    return resource;
  }

  /**
   * The path of a kind's collection: in a namespace for a namespaced kind given
   * one, across all namespaces for one given none (`requireNamespace` refuses
   * that instead), and cluster-wide for a cluster-scoped kind.
   */
  async function collectionPath(
    apiVersion: string,
    kind: string,
    namespace: string | undefined,
    requireNamespace: boolean,
  ): Promise<string> {
    const resource = await resolveResource(apiVersion, kind);
    if (resource.namespaced && !namespace && requireNamespace) {
      throw new Error(`${kind} is a namespaced kind and needs a namespace.`);
    }
    const namespacePath = resource.namespaced && namespace ? `/namespaces/${encodeURIComponent(namespace)}` : "";
    return `${groupPath(apiVersion)}${namespacePath}/${resource.name}`;
  }

  async function objectPath(ref: ResourceRef): Promise<string> {
    const collection = await collectionPath(ref.apiVersion, ref.kind, ref.namespace, true);
    return `${collection}/${encodeURIComponent(ref.name)}`;
  }

  /** The kind, name and namespace of a manifest, with a clear error for a missing one. */
  function manifestRef(manifest: KubeObjectData): ResourceRef {
    const { apiVersion, kind, metadata } = manifest;
    if (!apiVersion || !kind) throw new Error("The manifest needs apiVersion and kind.");
    if (!metadata?.name) throw new Error("The manifest needs metadata.name.");
    return { apiVersion, kind, name: metadata.name, namespace: metadata.namespace };
  }

  const podPath = (namespace: string, name: string) =>
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}`;

  return {
    async read(ref) {
      const path = await objectPath(ref);
      return send((api) => api.get(path, {}, requestInit()));
    },

    async list({ apiVersion, kind, namespace, labelSelector, fieldSelector, limit }) {
      const path = await collectionPath(apiVersion, kind, namespace, false);
      const query = compactQuery({ labelSelector, fieldSelector, limit });
      return send((api) => api.get(path, { query }, requestInit()));
    },

    async create(manifest) {
      const ref = manifestRef(manifest);
      const path = await collectionPath(ref.apiVersion, ref.kind, ref.namespace, true);
      return send((api) => api.post(path, { data: manifest }, requestInit()));
    },

    async replace(manifest) {
      const path = await objectPath(manifestRef(manifest));
      return send((api) => api.put(path, { data: manifest }, requestInit()));
    },

    async patch(ref, patch, type) {
      const objectUri = await objectPath(ref);
      const path = ref.subresource ? `${objectUri}/${encodeURIComponent(ref.subresource)}` : objectUri;
      return send((api) => api.patch(path, { data: patch }, requestInit(PATCH_CONTENT_TYPES[type])));
    },

    async delete(ref, options = {}) {
      const path = await objectPath(ref);
      const query = compactQuery({ ...options });
      return send((api) => api.del(path, { query }, requestInit()));
    },

    async evictPod(namespace, name) {
      const data = { apiVersion: "policy/v1", kind: "Eviction", metadata: { name, namespace } };
      return send((api) => api.post(`${podPath(namespace, name)}/eviction`, { data }, requestInit()));
    },

    async podLog(namespace, name, { container, tailLines, previous, timestamps }) {
      const query = compactQuery({ container, tailLines, previous, timestamps });
      // Not `get`: it would parse a log that happens to be valid JSON into an object.
      return send(async (api) => {
        const response = await api.getResponse(`${podPath(namespace, name)}/log`, { query }, requestInit());
        const text = await response.text();
        if (response.ok) return text;
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          // Not JSON: report the text itself.
        }
        throw isKubeStatus(body) ? body : text || `Reading the log failed (${response.status}).`;
      });
    },

    async version() {
      return send((api) => api.get("/version", {}, requestInit()));
    },
  };
}

const clientCache = new Map<string, KubeClient>();

/**
 * Resolve (and cache) the Kubernetes client for the given cluster id. Throws a
 * descriptive error when the cluster is unknown; callers surface that text as
 * a tool result rather than letting it crash the session.
 *
 * Every request checks that the cluster is still connected in Freelens, since
 * a session outlives a connection, and refuses one that is not: the Freelens
 * proxy would otherwise start the cluster's `freelens-k8s-proxy` on its own,
 * behind the back of the UI. The `KubeJsonApi` is created on the first
 * request, once the Freelens proxy listens, and kept for the cluster.
 */
export function getKubeClient(clusterId: string): KubeClient {
  const cached = clientCache.get(clusterId);
  if (cached) return cached;

  const cluster = Main.Catalog.getClusterById(clusterId);
  if (!cluster) {
    throw new Error(`Cluster "${clusterId}" is not registered in Freelens.`);
  }

  let api: KubeJsonApiLike | undefined;
  const getApi = (): KubeJsonApiLike => {
    const current = Main.Catalog.getClusterById(clusterId);
    if (!current) {
      throw new Error(`Cluster "${cluster.name}" is no longer registered in Freelens.`);
    }
    if (current.status !== Common.Clusters.ClusterConnectionStatus.CONNECTED) {
      throw new Error(
        `Cluster "${current.name}" is not connected in Freelens. Connect to it in Freelens and try again.`,
      );
    }
    api ??= Main.K8sApi.KubeJsonApi.forCluster(clusterId);
    return api;
  };

  const client: KubeClient = {
    clusterId,
    clusterName: cluster.name,
    kubeConfigPath: cluster.kubeConfigPath,
    contextName: cluster.contextName,
    ...createKubeRequests(getApi),
  };
  clientCache.set(clusterId, client);
  return client;
}

/** Drop a cached client (e.g. when a session is disposed). */
export function disposeKubeClient(clusterId: string): void {
  clientCache.delete(clusterId);
}
