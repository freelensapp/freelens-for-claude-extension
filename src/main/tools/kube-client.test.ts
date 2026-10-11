/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Main } from "@freelensapp/extensions";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createKubeRequests,
  disposeKubeClient,
  getKubeClient,
  type KubeJsonApiLike,
  REQUEST_TIMEOUT_MS,
  toKubeError,
} from "./kube-client";

const DISCOVERY: Record<string, unknown> = {
  "/api/v1": {
    resources: [
      { name: "pods", kind: "Pod", namespaced: true },
      { name: "pods/log", kind: "Pod", namespaced: true },
      { name: "nodes", kind: "Node", namespaced: false },
      { name: "events", kind: "Event", namespaced: true },
    ],
  },
  "/apis/apps/v1": {
    resources: [
      { name: "deployments/scale", kind: "Scale", namespaced: true },
      { name: "deployments", kind: "Deployment", namespaced: true },
    ],
  },
};

/** A stand-in for the host's `KubeJsonApi`: discovery from {@link DISCOVERY}, `{}` for everything else. */
function fakeApi() {
  const answer = vi.fn(async (path: string, ..._rest: unknown[]) => DISCOVERY[path] ?? {});
  return {
    get: answer,
    post: vi.fn(async (..._args: unknown[]) => ({ metadata: { namespace: "default" } })),
    put: vi.fn(async (..._args: unknown[]) => ({})),
    patch: vi.fn(async (..._args: unknown[]) => ({})),
    del: vi.fn(async (..._args: unknown[]) => ({})),
    getResponse: vi.fn(async (..._args: unknown[]) => new Response("line 1\nline 2", { status: 200 })),
  };
}

function requestsOn(api: ReturnType<typeof fakeApi>) {
  return createKubeRequests(() => api as unknown as KubeJsonApiLike);
}

/** The paths of the GET requests, discovery included. */
const getPaths = (api: ReturnType<typeof fakeApi>) => api.get.mock.calls.map((call) => call[0]);

describe("createKubeRequests", () => {
  it("reads a namespaced object, with a timeout signal, and caches discovery", async () => {
    const api = fakeApi();
    const requests = requestsOn(api);
    await requests.read({ apiVersion: "v1", kind: "Pod", namespace: "default", name: "web" });
    await requests.read({ apiVersion: "v1", kind: "Pod", namespace: "kube-system", name: "dns" });
    expect(getPaths(api)).toEqual([
      "/api/v1",
      "/api/v1/namespaces/default/pods/web",
      "/api/v1/namespaces/kube-system/pods/dns",
    ]);
    const init = api.get.mock.calls[1][2] as { signal: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses a namespaced kind without a namespace", async () => {
    const api = fakeApi();
    await expect(requestsOn(api).read({ apiVersion: "apps/v1", kind: "Deployment", name: "web" })).rejects.toThrow(
      "Deployment is a namespaced kind and needs a namespace.",
    );
    await expect(
      requestsOn(api).patch({ apiVersion: "apps/v1", kind: "Deployment", name: "web" }, {}, "merge"),
    ).rejects.toThrow(/needs a namespace/);
    await expect(requestsOn(api).delete({ apiVersion: "v1", kind: "Pod", name: "web" })).rejects.toThrow(
      /needs a namespace/,
    );
    await expect(requestsOn(api).replace({ apiVersion: "v1", kind: "Pod", metadata: { name: "web" } })).rejects.toThrow(
      /needs a namespace/,
    );
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.del).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
  });

  it("lists across all namespaces when none is given, without unset query parameters", async () => {
    const api = fakeApi();
    await requestsOn(api).list({ apiVersion: "v1", kind: "Pod", labelSelector: "app=web", limit: 51 });
    expect(api.get).toHaveBeenLastCalledWith(
      "/api/v1/pods",
      { query: { labelSelector: "app=web", limit: 51 } },
      expect.anything(),
    );
  });

  it("lists in a namespace", async () => {
    const api = fakeApi();
    await requestsOn(api).list({
      apiVersion: "v1",
      kind: "Event",
      namespace: "default",
      fieldSelector: "type=Warning",
    });
    expect(api.get).toHaveBeenLastCalledWith(
      "/api/v1/namespaces/default/events",
      { query: { fieldSelector: "type=Warning" } },
      expect.anything(),
    );
  });

  it("ignores a namespace for a cluster-scoped kind", async () => {
    const api = fakeApi();
    await requestsOn(api).read({ apiVersion: "v1", kind: "Node", namespace: "default", name: "node-1" });
    expect(getPaths(api)).toContain("/api/v1/nodes/node-1");
  });

  it("fetches discovery again for an unknown kind, then reports it", async () => {
    const api = fakeApi();
    const requests = requestsOn(api);
    await requests.read({ apiVersion: "v1", kind: "Pod", namespace: "default", name: "web" });
    await expect(requests.read({ apiVersion: "v1", kind: "Widget", name: "w" })).rejects.toThrow(
      'Could not resolve a resource for kind "Widget" in "v1".',
    );
    expect(getPaths(api).filter((path) => path === "/api/v1")).toHaveLength(2);
  });

  it("reports a failed discovery with the Status message", async () => {
    const api = fakeApi();
    api.get.mockRejectedValueOnce({ kind: "Status", message: "the server could not find the requested resource" });
    await expect(requestsOn(api).read({ apiVersion: "x.io/v9", kind: "X", name: "x" })).rejects.toThrow(
      'Failed to discover resources for "x.io/v9": the server could not find the requested resource',
    );
  });

  it("creates in the manifest's namespace", async () => {
    const api = fakeApi();
    const manifest = { apiVersion: "v1", kind: "Pod", metadata: { name: "web", namespace: "default" } };
    await requestsOn(api).create(manifest);
    expect(api.post).toHaveBeenCalledWith("/api/v1/namespaces/default/pods", { data: manifest }, expect.anything());
  });

  it("replaces an object with PUT", async () => {
    const api = fakeApi();
    const manifest = { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web", namespace: "default" } };
    await requestsOn(api).replace(manifest);
    expect(api.put).toHaveBeenCalledWith(
      "/apis/apps/v1/namespaces/default/deployments/web",
      { data: manifest },
      expect.anything(),
    );
  });

  it("sends a merge patch with a lowercase content-type", async () => {
    const api = fakeApi();
    const ref = { apiVersion: "apps/v1", kind: "Deployment", namespace: "default", name: "web" };
    await requestsOn(api).patch(ref, { spec: { replicas: 2 } }, "merge");
    const [path, params, init] = api.patch.mock.calls[0] as [string, unknown, { headers: Record<string, string> }];
    expect(path).toBe("/apis/apps/v1/namespaces/default/deployments/web");
    expect(params).toEqual({ data: { spec: { replicas: 2 } } });
    expect(init.headers).toEqual({ "content-type": "application/merge-patch+json" });
  });

  it("sends a strategic merge patch to a subresource", async () => {
    const api = fakeApi();
    const ref = { apiVersion: "apps/v1", kind: "Deployment", namespace: "default", name: "web", subresource: "scale" };
    await requestsOn(api).patch(ref, { spec: { replicas: 3 } }, "strategic");
    const [path, , init] = api.patch.mock.calls[0] as [string, unknown, { headers: Record<string, string> }];
    expect(path).toBe("/apis/apps/v1/namespaces/default/deployments/web/scale");
    expect(init.headers).toEqual({ "content-type": "application/strategic-merge-patch+json" });
  });

  it("deletes with the delete options as query parameters", async () => {
    const api = fakeApi();
    const ref = { apiVersion: "v1", kind: "Pod", namespace: "default", name: "web" };
    await requestsOn(api).delete(ref, { gracePeriodSeconds: 0, propagationPolicy: "Background" });
    expect(api.del).toHaveBeenCalledWith(
      "/api/v1/namespaces/default/pods/web",
      { query: { gracePeriodSeconds: 0, propagationPolicy: "Background" } },
      expect.anything(),
    );
  });

  it("evicts a pod with a policy/v1 Eviction", async () => {
    const api = fakeApi();
    await requestsOn(api).evictPod("default", "web");
    expect(api.post).toHaveBeenCalledWith(
      "/api/v1/namespaces/default/pods/web/eviction",
      { data: { apiVersion: "policy/v1", kind: "Eviction", metadata: { name: "web", namespace: "default" } } },
      expect.anything(),
    );
  });

  it("reads a pod log as text, even when it is valid JSON", async () => {
    const api = fakeApi();
    api.getResponse.mockResolvedValueOnce(new Response('{"level":"info"}', { status: 200 }));
    const log = await requestsOn(api).podLog("default", "web", { container: "app", tailLines: 10, previous: true });
    expect(log).toBe('{"level":"info"}');
    expect(api.getResponse).toHaveBeenCalledWith(
      "/api/v1/namespaces/default/pods/web/log",
      { query: { container: "app", tailLines: 10, previous: true } },
      expect.anything(),
    );
  });

  it("turns a failed log read into an error with the Status message", async () => {
    const api = fakeApi();
    const status = { kind: "Status", message: 'previous terminated container "web" in pod "web" not found' };
    api.getResponse.mockResolvedValueOnce(new Response(JSON.stringify(status), { status: 400 }));
    await expect(requestsOn(api).podLog("default", "web", { previous: true })).rejects.toThrow(
      'previous terminated container "web" in pod "web" not found',
    );
  });

  it("reads the API server version", async () => {
    const api = fakeApi();
    api.get.mockResolvedValueOnce({ gitVersion: "v1.30.2" });
    await expect(requestsOn(api).version()).resolves.toEqual({ gitVersion: "v1.30.2" });
    expect(api.get).toHaveBeenCalledWith("/version", {}, expect.anything());
  });

  it("rejects with an Error, never with what KubeJsonApi threw", async () => {
    const api = fakeApi();
    const parsed = { toString: () => 'pods "web" not found' };
    api.get.mockImplementation(async (path: string) => {
      if (DISCOVERY[path]) return DISCOVERY[path];
      throw parsed;
    });
    const read = requestsOn(api).read({ apiVersion: "v1", kind: "Pod", namespace: "default", name: "web" });
    await expect(read).rejects.toBeInstanceOf(Error);
    await expect(read).rejects.toThrow('pods "web" not found');
  });
});

describe("toKubeError", () => {
  it("takes the message of a JsonApiErrorParsed from its toString()", () => {
    expect(toKubeError({ toString: () => 'deployments.apps "web" already exists' }).message).toBe(
      'deployments.apps "web" already exists',
    );
  });

  it("takes the message of the raw Status a GET answered 403 rejects with", () => {
    const status = { kind: "Status", code: 403, reason: "Forbidden", message: 'pods is forbidden: User "x"' };
    expect(toKubeError(status).message).toBe('pods is forbidden: User "x"');
  });

  it("falls back to the reason and code of a Status without a message", () => {
    expect(toKubeError({ kind: "Status", code: 403, reason: "Forbidden" }).message).toBe("Forbidden (403)");
  });

  it("never shows [object Object]", () => {
    expect(toKubeError({ some: "thing" }).message).toBe("The request to the cluster failed.");
  });

  it("reports a timeout with its length", () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(toKubeError(timeout).message).toBe(
      `The request to the cluster timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`,
    );
  });

  it("adds the cause of a failed fetch", () => {
    const error = new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:1234") });
    expect(toKubeError(error).message).toBe("fetch failed: connect ECONNREFUSED 127.0.0.1:1234");
  });
});

describe("getKubeClient", () => {
  const getClusterById = vi.mocked(Main.Catalog.getClusterById);
  const forCluster = vi.mocked(Main.K8sApi.KubeJsonApi.forCluster);
  const cluster = (status: string) => ({
    id: "c1",
    name: "kind-kind",
    kubeConfigPath: "/kube/config",
    contextName: "kind-kind",
    status,
  });

  afterEach(() => {
    disposeKubeClient("c1");
    getClusterById.mockReset();
    forCluster.mockReset();
  });

  it("throws for a cluster that is not registered", () => {
    expect(() => getKubeClient("c1")).toThrow('Cluster "c1" is not registered in Freelens.');
  });

  it("refuses a cluster that is not connected, without creating its KubeJsonApi", async () => {
    getClusterById.mockReturnValue(cluster("disconnected") as never);
    const client = getKubeClient("c1");
    expect(client.kubeConfigPath).toBe("/kube/config");
    await expect(client.version()).rejects.toThrow('Cluster "kind-kind" is not connected in Freelens.');
    expect(forCluster).not.toHaveBeenCalled();
  });

  it("creates the KubeJsonApi of a connected cluster once, on the first request", async () => {
    getClusterById.mockReturnValue(cluster("connected") as never);
    const api = fakeApi();
    forCluster.mockReturnValue(api as never);
    const client = getKubeClient("c1");
    expect(forCluster).not.toHaveBeenCalled();
    await client.version();
    await client.read({ apiVersion: "v1", kind: "Pod", namespace: "default", name: "web" });
    expect(forCluster).toHaveBeenCalledTimes(1);
    expect(forCluster).toHaveBeenCalledWith("c1");
  });

  it("refuses a request once the cluster has disconnected", async () => {
    getClusterById.mockReturnValue(cluster("connected") as never);
    forCluster.mockReturnValue(fakeApi() as never);
    const client = getKubeClient("c1");
    await client.version();
    getClusterById.mockReturnValue(cluster("disconnected") as never);
    await expect(client.version()).rejects.toThrow(/is not connected in Freelens/);
  });
});
