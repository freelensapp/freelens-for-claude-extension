/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { PermissionBroker } from "./permission-broker";

import type { SessionEvent } from "../../common/protocol";

/** Build a broker plus a recorder of the events it emits and a deterministic id sequence. */
function makeBroker(captureBackup: () => Promise<string | undefined> = async () => undefined) {
  const events: SessionEvent[] = [];
  let counter = 0;
  const broker = new PermissionBroker(
    (event) => events.push(event),
    captureBackup,
    () => `req-${++counter}`,
  );
  return { broker, events };
}

const patchInput = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  namespace: "default",
  name: "nginx",
  patch: { spec: { replicas: 3 } },
  subresource: "scale",
};

describe("PermissionBroker", () => {
  it("approve mode: allow resolves the request and reports the requestId", async () => {
    const { broker, events } = makeBroker();
    const decision = broker.decideMutating("freelens_patch_resource", patchInput);
    // The request is emitted synchronously before the await settles.
    await Promise.resolve();
    const request = events.find((e) => e.type === "permission_request");
    expect(request).toBeDefined();
    const requestId = (request as Extract<SessionEvent, { type: "permission_request" }>).data.requestId;

    expect(broker.resolve(requestId, "allow")).toBe("ok");
    expect(await decision).toEqual({ behavior: "allow" });
    expect(events.some((e) => e.type === "permission_resolved")).toBe(true);
  });

  it("approve mode: deny returns the exact denial message", async () => {
    const { broker, events } = makeBroker();
    const decision = broker.decideMutating("freelens_delete_pod", { namespace: "default", name: "web", mode: "evict" });
    await Promise.resolve();
    const requestId = (
      events.find((e) => e.type === "permission_request") as Extract<SessionEvent, { type: "permission_request" }>
    ).data.requestId;

    broker.resolve(requestId, "deny");
    expect(await decision).toEqual({ behavior: "deny", message: "The user denied the action." });
  });

  it("readOnly mode denies without emitting a request", async () => {
    const { broker, events } = makeBroker();
    broker.setMode("readOnly");
    const decision = await broker.decideMutating("freelens_patch_resource", patchInput);
    expect(decision.behavior).toBe("deny");
    expect(events.some((e) => e.type === "permission_request")).toBe(false);
  });

  it("acceptAll mode emits a request+resolved pair and auto-allows", async () => {
    const { broker, events } = makeBroker();
    broker.setMode("acceptAll");
    const decision = await broker.decideMutating("freelens_rollout_restart", {
      kind: "Deployment",
      namespace: "default",
      name: "nginx",
    });
    expect(decision).toEqual({ behavior: "allow" });
    expect(events.filter((e) => e.type === "permission_request")).toHaveLength(1);
    const resolved = events.find((e) => e.type === "permission_resolved") as Extract<
      SessionEvent,
      { type: "permission_resolved" }
    >;
    expect(resolved.data.behavior).toBe("allow");
  });

  it("captures a backup and computes a diff only for updates", async () => {
    const { broker, events } = makeBroker(async () => "kind: Service\nspec: {}\n");
    void broker.decideMutating("freelens_update_resource", {
      manifest: { apiVersion: "v1", kind: "Service", metadata: { name: "web", namespace: "default" } },
    });
    await Promise.resolve();
    const request = events.find((e) => e.type === "permission_request") as Extract<
      SessionEvent,
      { type: "permission_request" }
    >;
    expect(request.data.currentYaml).toContain("kind: Service");
    expect(request.data.diff).toContain("proposed");
  });

  it("denies all pending requests when the turn is interrupted", async () => {
    const { broker, events } = makeBroker();
    const decision = broker.decideMutating("freelens_delete_resource", {
      apiVersion: "v1",
      kind: "ConfigMap",
      namespace: "default",
      name: "cfg",
    });
    await Promise.resolve();
    broker.denyAllPending("the turn was interrupted");
    expect(await decision).toEqual({ behavior: "deny", message: "The user denied the action." });
    const resolved = events.find((e) => e.type === "permission_resolved") as Extract<
      SessionEvent,
      { type: "permission_resolved" }
    >;
    expect(resolved.data.reason).toBe("the turn was interrupted");
  });

  it("rejects double resolution of the same request", async () => {
    const { broker, events } = makeBroker();
    const decision = broker.decideMutating("freelens_delete_pod", { namespace: "default", name: "web", mode: "evict" });
    await Promise.resolve();
    const requestId = (
      events.find((e) => e.type === "permission_request") as Extract<SessionEvent, { type: "permission_request" }>
    ).data.requestId;

    expect(broker.resolve(requestId, "allow")).toBe("ok");
    await decision;
    expect(broker.resolve(requestId, "allow")).toBe("already_resolved");
    expect(broker.resolve("nope", "allow")).toBe("not_found");
  });

  it("setMode emits session_meta with the new mode", () => {
    const { broker, events } = makeBroker();
    broker.setMode("readOnly");
    const meta = events.find((e) => e.type === "session_meta") as Extract<SessionEvent, { type: "session_meta" }>;
    expect(meta.data.permissionMode).toBe("readOnly");
  });

  const podLogsInput = { namespace: "default", name: "web" };

  it("consent-required read tool prompts in readOnly mode instead of being denied", async () => {
    const { broker, events } = makeBroker();
    broker.setMode("readOnly");
    const decision = broker.decideReadWithConsent("freelens_pod_logs", podLogsInput);
    await Promise.resolve();
    const request = events.find((e) => e.type === "permission_request") as Extract<
      SessionEvent,
      { type: "permission_request" }
    >;
    expect(request).toBeDefined();
    broker.resolve(request.data.requestId, "allow");
    expect(await decision).toEqual({ behavior: "allow" });
  });

  it("acceptAll auto-approves a consent-required read tool", async () => {
    const { broker, events } = makeBroker();
    broker.setMode("acceptAll");
    const decision = await broker.decideReadWithConsent("freelens_pod_logs", podLogsInput);
    expect(decision).toEqual({ behavior: "allow" });
    expect(events.filter((e) => e.type === "permission_request")).toHaveLength(1);
  });

  const mcpTool = "mcp__github__search_issues";
  const mcpInput = { query: "is:open" };

  it("external mcp tools prompt in approve mode with a USE MCP TOOL title", async () => {
    const { broker, events } = makeBroker();
    const decision = broker.decideMutating(mcpTool, mcpInput);
    await Promise.resolve();
    const request = events.find((e) => e.type === "permission_request") as Extract<
      SessionEvent,
      { type: "permission_request" }
    >;
    expect(request).toBeDefined();
    expect(request.data.actionTitle).toContain("USE MCP TOOL");
    expect(request.data.actionTitle).toContain("github / search_issues");
    broker.resolve(request.data.requestId, "allow");
    expect(await decision).toEqual({ behavior: "allow" });
  });

  it("external mcp tools are denied in readOnly mode", async () => {
    const { broker, events } = makeBroker();
    broker.setMode("readOnly");
    const decision = await broker.decideMutating(mcpTool, mcpInput);
    expect(decision.behavior).toBe("deny");
    expect(events.some((e) => e.type === "permission_request")).toBe(false);
  });

  it("external mcp tools are auto-approved in acceptAll mode", async () => {
    const { broker, events } = makeBroker();
    broker.setMode("acceptAll");
    const decision = await broker.decideMutating(mcpTool, mcpInput);
    expect(decision).toEqual({ behavior: "allow" });
    expect(events.filter((e) => e.type === "permission_request")).toHaveLength(1);
  });
});
