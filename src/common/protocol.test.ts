/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import {
  decodeSseFrame,
  encodeSseEvent,
  isModelChoice,
  MODEL_CHOICES,
  type SessionEvent,
  sessionEvent,
} from "./protocol";

/** Strip the trailing blank-line separator so we can feed one frame to the decoder. */
function frameOf(encoded: string): string {
  return encoded.replace(/\n\n$/, "");
}

describe("protocol SSE round-trip", () => {
  const cases: SessionEvent[] = [
    sessionEvent("status", { state: "working" }),
    sessionEvent("user_message", { text: "what pods are failing?" }),
    sessionEvent("assistant_delta", { text: "partial " }),
    sessionEvent("assistant_message", { text: "Here is the answer.\nWith a newline." }),
    sessionEvent("tool_call", { toolName: "kube_resources", input: { kind: "Pod" } }),
    sessionEvent("tool_call", { toolName: "kube_resources", input: { kind: "Pod" }, callId: "toolu_1" }),
    sessionEvent("tool_result", { toolName: "kube_resources", summary: "3 pods" }),
    sessionEvent("tool_result", { toolName: "kube_resources", summary: "3 pods", callId: "toolu_1" }),
    sessionEvent("usage", { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 345 }),
    sessionEvent("compaction", { trigger: "auto", preTokens: 120000 }),
    sessionEvent("turn_complete", {}),
    sessionEvent("error", { message: "boom", kind: "auth" }),
    sessionEvent("error", { message: "flaky", kind: "other", canRetry: true }),
    sessionEvent("permission_request", {
      requestId: "req-1",
      toolName: "kube_update_resource",
      actionTitle: "UPDATE SERVICE",
      input: { manifest: { kind: "Service" } },
      proposedYaml: "kind: Service\n",
      currentYaml: "kind: Service\nspec: {}\n",
      diff: "--- current\n+++ proposed\n",
    }),
    sessionEvent("permission_resolved", { requestId: "req-1", behavior: "deny", reason: "interrupted" }),
    sessionEvent("session_meta", { permissionMode: "approve", resumed: true }),
    sessionEvent("session_meta", {
      permissionMode: "approve",
      resumed: false,
      model: "haiku",
      resolvedModel: "claude-haiku-4-5",
    }),
  ];

  for (const event of cases) {
    it(`encodes and decodes "${event.type}"`, () => {
      const decoded = decodeSseFrame(frameOf(encodeSseEvent(event)));
      expect(decoded).toEqual(event);
    });
  }

  it("returns null for heartbeat/comment frames", () => {
    expect(decodeSseFrame(": heartbeat")).toBeNull();
  });

  it("returns null for frames without data", () => {
    expect(decodeSseFrame("event: status")).toBeNull();
  });
});

describe("model choices", () => {
  it("recognizes the known aliases and rejects anything else", () => {
    for (const model of MODEL_CHOICES) expect(isModelChoice(model)).toBe(true);
    expect(isModelChoice("gpt")).toBe(false);
    expect(isModelChoice(null)).toBe(false);
    expect(isModelChoice(undefined)).toBe(false);
  });
});
