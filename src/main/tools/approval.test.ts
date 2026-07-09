/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { describeApproval } from "./approval";
import {
  BUILTIN_TOOL_DESCRIPTORS,
  isKnownToolName,
  isMutatingToolName,
  MUTATING_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
} from "./mcp-server";

describe("describeApproval", () => {
  it("describes an external MCP tool with USE MCP TOOL and a server/tool subtitle", () => {
    const input = { query: "list issues" };
    const descriptor = describeApproval("mcp__github__search_issues", input);
    expect(descriptor.actionTitle).toBe("USE MCP TOOL");
    expect(descriptor.subtitle).toBe("github / search_issues");
    expect(descriptor.proposedValue).toBe(input);
  });

  it("describes freelens_kubectl with RUN KUBECTL and the shell-quoted command line", () => {
    const descriptor = describeApproval("freelens_kubectl", { args: ["get", "pods", "-o", "wide"] });
    expect(descriptor.actionTitle).toBe("RUN KUBECTL");
    expect(descriptor.proposedValue).toBe("kubectl get pods -o wide");
    expect(descriptor.target).toBeUndefined();
  });

  it("describes freelens_helm with RUN HELM and the shell-quoted command line", () => {
    const descriptor = describeApproval("freelens_helm", { args: ["list", "-A"] });
    expect(descriptor.actionTitle).toBe("RUN HELM");
    expect(descriptor.proposedValue).toBe("helm list -A");
    expect(descriptor.target).toBeUndefined();
  });

  it("builds a title from a built-in mutating tool name", () => {
    const descriptor = describeApproval("freelens_update_resource", {
      manifest: { apiVersion: "v1", kind: "Service", metadata: { name: "web", namespace: "default" } },
    });
    expect(descriptor.actionTitle).toBe("UPDATE SERVICE");
    expect(descriptor.subtitle).toBeUndefined();
  });
});

describe("tool-name gating classification", () => {
  it("classifies external mcp tools as unknown but never built-in", () => {
    expect(isKnownToolName("mcp__github__search_issues")).toBe(false);
    expect("mcp__github__search_issues".startsWith("mcp__")).toBe(true);
  });

  it("classifies unknown non-MCP tool names as neither known nor mcp", () => {
    expect(isKnownToolName("Bash")).toBe(false);
    expect("Bash".startsWith("mcp__")).toBe(false);
  });

  it("recognizes the built-in mutating tools", () => {
    expect(isKnownToolName("freelens_delete_pod")).toBe(true);
    expect(isMutatingToolName("freelens_delete_pod")).toBe(true);
    expect(isMutatingToolName("freelens_resources")).toBe(false);
  });
});

describe("BUILTIN_TOOL_DESCRIPTORS", () => {
  it("covers every read-only and mutating tool with the right flag and a non-empty description", () => {
    const byName = new Map(BUILTIN_TOOL_DESCRIPTORS.map((descriptor) => [descriptor.name, descriptor]));
    expect(BUILTIN_TOOL_DESCRIPTORS).toHaveLength(READ_ONLY_TOOL_NAMES.length + MUTATING_TOOL_NAMES.length);
    for (const name of READ_ONLY_TOOL_NAMES) {
      expect(byName.get(name)?.mutating).toBe(false);
      expect(byName.get(name)?.description.length).toBeGreaterThan(0);
    }
    for (const name of MUTATING_TOOL_NAMES) {
      expect(byName.get(name)?.mutating).toBe(true);
    }
  });

  it("uses only the first sentence of each description", () => {
    const resources = BUILTIN_TOOL_DESCRIPTORS.find((descriptor) => descriptor.name === "freelens_resources");
    expect(resources?.description).toBe("List or get Kubernetes resources of any kind (built-in or CRD).");
  });
});
