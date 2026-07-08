/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it, vi } from "vitest";
import { LOG_BYTE_CAP, stripManagedFields, truncateBytes } from "./kube-format";
import { type PodLogsClient, runPodLogs } from "./pod-logs";
import { type ResourcesClient, runResources } from "./resources";
import { runWarningEvents, type WarningEventsClient } from "./warning-events";

const resourcesClient = (objects: { read: unknown; list: unknown }): ResourcesClient =>
  ({ objects }) as unknown as ResourcesClient;
const podLogsClient = (core: { readNamespacedPodLog: unknown }): PodLogsClient =>
  ({ core }) as unknown as PodLogsClient;
const warningEventsClient = (core: {
  listEventForAllNamespaces: unknown;
  listNamespacedEvent: unknown;
}): WarningEventsClient => ({ core }) as unknown as WarningEventsClient;

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
