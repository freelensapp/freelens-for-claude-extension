/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { PatchStrategy } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type ClusterVersionClient, runClusterVersion } from "./cluster-version";
import { type CreateResourceClient, runCreateResource } from "./create-resource";
import { type DeletePodClient, deletePodSchema, runDeletePod } from "./delete-pod";
import { type DeleteResourceClient, runDeleteResource } from "./delete-resource";
import { LOG_BYTE_CAP, selectFields, stripManagedFields, truncateBytes } from "./kube-format";
import { type PatchResourceClient, runPatchResource } from "./patch-resource";
import { type PodLogsClient, runPodLogs } from "./pod-logs";
import { type ResourcesClient, runResources } from "./resources";
import { type RolloutRestartClient, rolloutRestartSchema, runRolloutRestart } from "./rollout-restart";
import { runUpdateResource, type UpdateResourceClient } from "./update-resource";
import { runWarningEvents, type WarningEventsClient } from "./warning-events";

const resourcesClient = (objects: { read: unknown; list: unknown }): ResourcesClient =>
  ({ objects }) as unknown as ResourcesClient;
const podLogsClient = (core: { readNamespacedPodLog: unknown }): PodLogsClient =>
  ({ core }) as unknown as PodLogsClient;
const warningEventsClient = (core: {
  listEventForAllNamespaces: unknown;
  listNamespacedEvent: unknown;
}): WarningEventsClient => ({ core }) as unknown as WarningEventsClient;
const clusterVersionClient = (version: { getCode: unknown }): ClusterVersionClient =>
  ({ version }) as unknown as ClusterVersionClient;
const createResourceClient = (create: unknown): CreateResourceClient =>
  ({ objects: { create } }) as unknown as CreateResourceClient;
const updateResourceClient = (objects: { read: unknown; replace: unknown }): UpdateResourceClient =>
  ({ objects }) as unknown as UpdateResourceClient;
const patchResourceClient = (objects: { patch: unknown }, patchSubresource: unknown): PatchResourceClient =>
  ({ objects, patchSubresource }) as unknown as PatchResourceClient;
const deleteResourceClient = (objects: { delete: unknown; patch: unknown }): DeleteResourceClient =>
  ({ objects }) as unknown as DeleteResourceClient;
const deletePodClient = (core: {
  createNamespacedPodEviction: unknown;
  deleteNamespacedPod: unknown;
  patchNamespacedPod: unknown;
}): DeletePodClient => ({ core }) as unknown as DeletePodClient;
const rolloutRestartClient = (objects: { patch: unknown }): RolloutRestartClient =>
  ({ objects }) as unknown as RolloutRestartClient;

describe("kube-format", () => {
  it("strips metadata.managedFields from a single resource", () => {
    const stripped = stripManagedFields({
      metadata: { name: "x", managedFields: [{ manager: "kubectl" }] },
    });
    expect(stripped.metadata).not.toHaveProperty("managedFields");
    expect(stripped.metadata.name).toBe("x");
  });

  it("strips managedFields from every item of a list", () => {
    const stripped = stripManagedFields([
      { metadata: { name: "a", managedFields: [1] } },
      { metadata: { name: "b", managedFields: [2] } },
    ]);
    expect(stripped.every((item) => !("managedFields" in item.metadata))).toBe(true);
  });

  it("adds a note when truncating past the byte cap", () => {
    const text = "x".repeat(100);
    const out = truncateBytes(text, 10);
    expect(out).toContain("truncated");
    expect(out.length).toBeGreaterThan(10);
  });

  it("leaves short text untouched", () => {
    expect(truncateBytes("short", 100)).toBe("short");
  });
});

describe("selectFields", () => {
  const object = {
    metadata: {
      name: "web",
      namespace: "default",
      labels: { "app.kubernetes.io/name": "nginx" },
    },
    spec: {
      containers: [
        { name: "c1", image: "nginx:1" },
        { name: "c2", image: "nginx:2" },
      ],
    },
    status: { conditions: [{ type: "Initialized" }, { type: "Ready" }] },
  };

  it("selects a dot path and drops siblings", () => {
    expect(selectFields(object, ["metadata.name"])).toEqual({ metadata: { name: "web" } });
  });

  it("merges multiple selectors", () => {
    expect(selectFields(object, ["metadata.name", "metadata.namespace"])).toEqual({
      metadata: { name: "web", namespace: "default" },
    });
  });

  it("supports the [*] array wildcard", () => {
    expect(selectFields(object, ["spec.containers[*].image"])).toEqual({
      spec: { containers: [{ image: "nginx:1" }, { image: "nginx:2" }] },
    });
  });

  it("supports numeric and negative indexes", () => {
    expect(selectFields(object, ["spec.containers[0].name"])).toEqual({ spec: { containers: [{ name: "c1" }] } });
    expect(selectFields(object, ["status.conditions[-1].type"])).toEqual({
      status: { conditions: [{ type: "Ready" }] },
    });
  });

  it("supports bracketed quoted keys for dotted labels", () => {
    expect(selectFields(object, ["metadata.labels['app.kubernetes.io/name']"])).toEqual({
      metadata: { labels: { "app.kubernetes.io/name": "nginx" } },
    });
  });

  it("tolerates a leading $. and a {...} wrapper", () => {
    expect(selectFields(object, ["$.metadata.name"])).toEqual({ metadata: { name: "web" } });
    expect(selectFields(object, ["{.metadata.name}"])).toEqual({ metadata: { name: "web" } });
  });

  it("throws a readable error on a malformed selector", () => {
    expect(() => selectFields(object, ["metadata[oops"])).toThrow(/Invalid field selector "metadata\[oops"/);
  });
});

describe("runResources", () => {
  it("reads a single named resource as YAML with managedFields stripped", async () => {
    const read = vi.fn(async () => ({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "web", managedFields: [{ manager: "kubelet" }] },
    }));
    const yaml = await runResources(resourcesClient({ read, list: vi.fn() }), {
      apiVersion: "v1",
      kind: "Pod",
      name: "web",
    });
    expect(read).toHaveBeenCalled();
    expect(yaml).toContain("name: web");
    expect(yaml).not.toContain("managedFields");
  });

  it("truncates lists to the limit and notes more exist", async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ metadata: { name: `p${i}` } }));
    const list = vi.fn(async () => ({ items }));
    const out = await runResources(resourcesClient({ read: vi.fn(), list }), {
      apiVersion: "v1",
      kind: "Pod",
      limit: 2,
    });
    // limit+1 requested to detect overflow
    expect(list).toHaveBeenCalledWith("v1", "Pod", undefined, undefined, undefined, undefined, undefined, undefined, 3);
    expect(out).toContain("truncated to 2 items");
  });

  it("reports when no resources are found", async () => {
    const out = await runResources(resourcesClient({ read: vi.fn(), list: vi.fn(async () => ({ items: [] })) }), {
      apiVersion: "v1",
      kind: "Pod",
    });
    expect(out).toContain("No Pod resources found");
  });

  it("projects a single resource to the requested fields", async () => {
    const read = vi.fn(async () => ({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "web", namespace: "default", labels: { app: "nginx" } },
      spec: { nodeName: "node-1" },
    }));
    const out = await runResources(resourcesClient({ read, list: vi.fn() }), {
      apiVersion: "v1",
      kind: "Pod",
      name: "web",
      fields: ["metadata.name"],
    });
    expect(out).toContain("name: web");
    expect(out).not.toContain("nodeName");
    expect(out).not.toContain("namespace");
  });

  it("keeps managedFields when includeManagedFields is set", async () => {
    const read = vi.fn(async () => ({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "web", managedFields: [{ manager: "kubelet" }] },
    }));
    const out = await runResources(resourcesClient({ read, list: vi.fn() }), {
      apiVersion: "v1",
      kind: "Pod",
      name: "web",
      includeManagedFields: true,
    });
    expect(out).toContain("managedFields");
  });
});

describe("runCreateResource", () => {
  it("strips managedFields and creates the resource", async () => {
    const create = vi.fn(async (spec: Record<string, unknown>) => spec);
    const out = await runCreateResource(createResourceClient(create), {
      manifest: {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: "cfg", namespace: "default", managedFields: [{ manager: "kubectl" }] },
      },
    });
    const created = create.mock.calls[0][0] as { metadata: Record<string, unknown> };
    expect(created.metadata).not.toHaveProperty("managedFields");
    expect(out).toContain('Created ConfigMap "cfg"');
  });

  it("rejects a manifest missing required fields", async () => {
    await expect(runCreateResource(createResourceClient(vi.fn()), { manifest: { kind: "ConfigMap" } })).rejects.toThrow(
      /apiVersion is required/,
    );
  });
});

describe("runUpdateResource", () => {
  it("carries over resourceVersion from the live object when omitted", async () => {
    const read = vi.fn(async () => ({ metadata: { resourceVersion: "99" } }));
    const replace = vi.fn(async (spec: Record<string, unknown>) => spec);
    await runUpdateResource(updateResourceClient({ read, replace }), {
      manifest: { apiVersion: "v1", kind: "Service", metadata: { name: "web", namespace: "default" } },
    });
    expect(read).toHaveBeenCalled();
    const replaced = replace.mock.calls[0][0] as { metadata: Record<string, unknown> };
    expect(replaced.metadata.resourceVersion).toBe("99");
  });

  it("does not re-read when the manifest already has a resourceVersion", async () => {
    const read = vi.fn();
    const replace = vi.fn(async (spec: Record<string, unknown>) => spec);
    await runUpdateResource(updateResourceClient({ read, replace }), {
      manifest: { apiVersion: "v1", kind: "Service", metadata: { name: "web", resourceVersion: "5" } },
    });
    expect(read).not.toHaveBeenCalled();
  });
});

describe("runPatchResource", () => {
  it("uses a JSON merge patch for the resource itself", async () => {
    const patch = vi.fn(async (spec: Record<string, unknown>) => spec);
    const patchSubresource = vi.fn(async () => {});
    await runPatchResource(patchResourceClient({ patch }, patchSubresource), {
      apiVersion: "apps/v1",
      kind: "Deployment",
      namespace: "default",
      name: "nginx",
      patch: { spec: { replicas: 2 } },
    });
    expect(patchSubresource).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({ apiVersion: "apps/v1", kind: "Deployment" }),
      undefined,
      undefined,
      undefined,
      undefined,
      PatchStrategy.MergePatch,
    );
  });

  it("routes to a strategic-merge subresource patch for scale", async () => {
    const patch = vi.fn(async (spec: Record<string, unknown>) => spec);
    const patchSubresource = vi.fn(async () => {});
    await runPatchResource(patchResourceClient({ patch }, patchSubresource), {
      apiVersion: "apps/v1",
      kind: "Deployment",
      namespace: "default",
      name: "nginx",
      patch: { spec: { replicas: 3 } },
      subresource: "Scale",
    });
    expect(patch).not.toHaveBeenCalled();
    expect(patchSubresource).toHaveBeenCalledWith(
      expect.objectContaining({ subresource: "scale", name: "nginx", patch: { spec: { replicas: 3 } } }),
    );
  });
});

describe("runDeleteResource", () => {
  it("does a normal delete by default", async () => {
    const del = vi.fn(async (..._args: unknown[]) => ({}));
    const patch = vi.fn();
    await runDeleteResource(deleteResourceClient({ delete: del, patch }), {
      apiVersion: "v1",
      kind: "ConfigMap",
      namespace: "default",
      name: "cfg",
    });
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0][1]).toBeUndefined();
  });

  it("force-deletes with grace period 0 and background propagation", async () => {
    const del = vi.fn(async (..._args: unknown[]) => ({}));
    await runDeleteResource(deleteResourceClient({ delete: del, patch: vi.fn() }), {
      apiVersion: "v1",
      kind: "Pod",
      namespace: "default",
      name: "web",
      mode: "force_delete",
    });
    expect(del).toHaveBeenCalledWith(expect.anything(), undefined, undefined, 0, undefined, "Background");
  });

  it("force-finalizes by clearing finalizers with a merge patch", async () => {
    const patch = vi.fn(async (..._args: unknown[]) => ({}));
    await runDeleteResource(deleteResourceClient({ delete: vi.fn(), patch }), {
      apiVersion: "v1",
      kind: "PersistentVolume",
      name: "pv",
      mode: "force_finalize",
    });
    const spec = patch.mock.calls[0][0] as { metadata: { finalizers: unknown[] } };
    expect(spec.metadata.finalizers).toEqual([]);
    expect(patch.mock.calls[0][5]).toBe(PatchStrategy.MergePatch);
  });
});

describe("runDeletePod", () => {
  it("requires a mode", () => {
    expect(z.object(deletePodSchema).safeParse({ namespace: "default", name: "web" }).success).toBe(false);
  });

  it("creates an Eviction for evict mode", async () => {
    const createNamespacedPodEviction = vi.fn(async (..._args: unknown[]) => ({}));
    await runDeletePod(
      deletePodClient({
        createNamespacedPodEviction,
        deleteNamespacedPod: vi.fn(),
        patchNamespacedPod: vi.fn(),
      }),
      { namespace: "default", name: "web", mode: "evict" },
    );
    const arg = createNamespacedPodEviction.mock.calls[0][0] as { body: { kind: string } };
    expect(arg.body.kind).toBe("Eviction");
  });

  it("clears finalizers then deletes for delete_with_finalizers", async () => {
    const patchNamespacedPod = vi.fn(async () => ({}));
    const deleteNamespacedPod = vi.fn(async () => ({}));
    await runDeletePod(
      deletePodClient({ createNamespacedPodEviction: vi.fn(), deleteNamespacedPod, patchNamespacedPod }),
      { namespace: "default", name: "web", mode: "delete_with_finalizers" },
    );
    expect(patchNamespacedPod).toHaveBeenCalled();
    expect(deleteNamespacedPod).toHaveBeenCalled();
  });
});

describe("runRolloutRestart", () => {
  it("rejects a non-restartable kind", () => {
    expect(z.object(rolloutRestartSchema).safeParse({ kind: "Job", namespace: "default", name: "x" }).success).toBe(
      false,
    );
  });

  it("stamps the restartedAt annotation with a strategic-merge patch", async () => {
    const patch = vi.fn(async (..._args: unknown[]) => ({}));
    await runRolloutRestart(
      rolloutRestartClient({ patch }),
      { kind: "Deployment", namespace: "default", name: "nginx" },
      () => "2026-01-01T00:00:00Z",
    );
    const spec = patch.mock.calls[0][0] as {
      spec: { template: { metadata: { annotations: Record<string, string> } } };
    };
    expect(spec.spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]).toBe("2026-01-01T00:00:00Z");
    expect(patch.mock.calls[0][5]).toBe(PatchStrategy.StrategicMergePatch);
  });
});

describe("runClusterVersion", () => {
  it("summarizes the API server version", async () => {
    const getCode = vi.fn(async () => ({
      major: "1",
      minor: "30",
      gitVersion: "v1.30.2",
      platform: "linux/amd64",
      buildDate: "2024-06-11T00:00:00Z",
    }));
    const out = await runClusterVersion(clusterVersionClient({ getCode }));
    expect(getCode).toHaveBeenCalled();
    expect(out).toContain("v1.30.2");
    expect(out).toContain("major/minor: 1.30");
    expect(out).toContain("linux/amd64");
  });
});

describe("runPodLogs", () => {
  it("filters lines by the grep pattern", async () => {
    const readNamespacedPodLog = vi.fn(async () => "info: ok\nerror: boom\ninfo: fine\n");
    const out = await runPodLogs(podLogsClient({ readNamespacedPodLog }), {
      namespace: "default",
      name: "web",
      grep: "error",
    });
    expect(out).toBe("error: boom");
  });

  it("caps oversized log output", async () => {
    const readNamespacedPodLog = vi.fn(async () => "y".repeat(LOG_BYTE_CAP + 5000));
    const out = await runPodLogs(podLogsClient({ readNamespacedPodLog }), { namespace: "default", name: "web" });
    expect(out).toContain("truncated");
  });

  it("reports an invalid grep pattern", async () => {
    const out = await runPodLogs(podLogsClient({ readNamespacedPodLog: vi.fn(async () => "x") }), {
      namespace: "default",
      name: "web",
      grep: "(",
    });
    expect(out).toContain("Invalid grep pattern");
  });

  it("forwards previous and timestamps to the API", async () => {
    const readNamespacedPodLog = vi.fn(async () => "line");
    await runPodLogs(podLogsClient({ readNamespacedPodLog }), {
      namespace: "default",
      name: "web",
      previous: true,
      timestamps: true,
    });
    expect(readNamespacedPodLog).toHaveBeenCalledWith(expect.objectContaining({ previous: true, timestamps: true }));
  });

  it("uses the configurable default tail lines when the model does not request an amount", async () => {
    const readNamespacedPodLog = vi.fn(async () => "line");
    await runPodLogs(podLogsClient({ readNamespacedPodLog }), { namespace: "default", name: "web" }, 500);
    expect(readNamespacedPodLog).toHaveBeenCalledWith(expect.objectContaining({ tailLines: 500 }));
  });

  it("prefers an explicit tailLines argument over the configured default", async () => {
    const readNamespacedPodLog = vi.fn(async () => "line");
    await runPodLogs(
      podLogsClient({ readNamespacedPodLog }),
      { namespace: "default", name: "web", tailLines: 42 },
      500,
    );
    expect(readNamespacedPodLog).toHaveBeenCalledWith(expect.objectContaining({ tailLines: 42 }));
  });

  it("returns a friendly message when there is no previous container instance", async () => {
    const readNamespacedPodLog = vi.fn(async () => {
      throw new Error('previous terminated container "web" in pod "web" not found');
    });
    const out = await runPodLogs(podLogsClient({ readNamespacedPodLog }), {
      namespace: "default",
      name: "web",
      previous: true,
    });
    expect(out).toContain("No previous (terminated) container instance");
  });
});

describe("runWarningEvents", () => {
  it("sorts warning events most-recent-first and scopes all namespaces", async () => {
    const listEventForAllNamespaces = vi.fn(async () => ({
      items: [
        {
          metadata: { namespace: "a" },
          involvedObject: { kind: "Pod", name: "old" },
          reason: "BackOff",
          message: "older",
          lastTimestamp: "2020-01-01T00:00:00Z",
        },
        {
          metadata: { namespace: "b" },
          involvedObject: { kind: "Pod", name: "new" },
          reason: "Failed",
          message: "newer",
          lastTimestamp: "2020-01-02T00:00:00Z",
        },
      ],
    }));
    const out = await runWarningEvents(
      warningEventsClient({ listEventForAllNamespaces, listNamespacedEvent: vi.fn() }),
      {},
    );
    expect(listEventForAllNamespaces).toHaveBeenCalledWith({ fieldSelector: "type=Warning" });
    expect(out.indexOf("new")).toBeLessThan(out.indexOf("old"));
  });

  it("scopes to a namespace when provided", async () => {
    const listNamespacedEvent = vi.fn(async () => ({ items: [] }));
    const out = await runWarningEvents(
      warningEventsClient({ listEventForAllNamespaces: vi.fn(), listNamespacedEvent }),
      { namespace: "kube-system" },
    );
    expect(listNamespacedEvent).toHaveBeenCalledWith({ namespace: "kube-system", fieldSelector: "type=Warning" });
    expect(out).toContain("No warning events");
  });
});
