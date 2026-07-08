/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { decodeSseFrame, encodeSseEvent, type SessionEvent, sessionEvent } from "./protocol";

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
    sessionEvent("tool_result", { toolName: "kube_resources", summary: "3 pods" }),
    sessionEvent("turn_complete", {}),
    sessionEvent("error", { message: "boom", kind: "auth" }),
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
