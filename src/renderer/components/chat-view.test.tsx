// @vitest-environment jsdom
/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreferencesStore } from "../../common/preferences-store";
import { ChatView } from "./chat-view";

import type { SessionEvent } from "../../common/protocol";
import type { BridgeClient } from "../api/bridge-client";

// The quick-prompt chips read the "Prompt shortcuts" preference. The host syncs
// PreferencesStore between the preferences page and the cluster frame, and the
// chat view observes it, so a change shows without another render of its own.

function fakeClient(): BridgeClient {
  return {
    streamEvents: vi.fn(() => () => {}),
    getModels: vi.fn(async () => ({ models: [] })),
  } as unknown as BridgeClient;
}

describe("ChatView", () => {
  beforeEach(() => {
    // jsdom lays nothing out and has no element scrolling; the transcript
    // scrolls to its end after every render.
    Element.prototype.scrollTo = vi.fn();
  });

  afterEach(() => {
    PreferencesStore.resetInstance();
    Reflect.deleteProperty(Element.prototype, "scrollTo");
  });

  it("shows a user-defined shortcut chip once the preference changes", async () => {
    const preferences = PreferencesStore.getInstanceOrCreate<PreferencesStore>();
    render(<ChatView clusterId="cluster-a" client={fakeClient()} />);

    expect(screen.queryByText("Check rollout")).toBeNull();

    await act(async () => {
      preferences.promptShortcuts = JSON.stringify([{ title: "Check rollout", prompt: "Is the rollout done?" }]);
    });

    expect(screen.getByText("Check rollout")).toBeTruthy();
  });

  it("shows the preparation of a kubectl call in its card until the call returns, and keeps a problem", async () => {
    let onEvent: ((event: SessionEvent) => void) | undefined;
    const client = {
      ...fakeClient(),
      streamEvents: vi.fn((_clusterId: string, handlers: { onEvent: (event: SessionEvent) => void }) => {
        onEvent = handlers.onEvent;
        return () => {};
      }),
    } as unknown as BridgeClient;
    render(<ChatView clusterId="cluster-a" client={client} />);
    const send = (event: SessionEvent) => act(async () => onEvent?.(event));

    await send({
      type: "tool_call",
      data: { toolName: "freelens_kubectl", input: { args: ["version"] }, callId: "k1" },
    });
    await send({ type: "tool_call", data: { toolName: "freelens_kubectl", input: { args: ["get"] }, callId: "k2" } });
    await send({
      type: "tool_progress",
      data: { callId: "k1", state: "preparing", transferred: 1024 * 1024, total: 4 * 1024 * 1024 },
    });
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("25% 1.0MiB / 4.0MiB");

    await send({ type: "tool_progress", data: { callId: "k1", state: "preparing", phase: "Verifying kubectl ..." } });
    expect(screen.queryByRole("progressbar")).toBeNull();
    const statuses = () => screen.getAllByRole("status").map((status) => status.textContent);
    expect(statuses()).toEqual(["Verifying kubectl ...", ""]);

    await send({ type: "tool_progress", data: { callId: "k1", state: "done" } });
    expect(statuses()).toEqual(["", ""]);

    // A call whose result arrives while main still shows it preparing drops the line.
    await send({ type: "tool_progress", data: { callId: "k2", state: "preparing", phase: "Waiting ..." } });
    await send({ type: "tool_result", data: { toolName: "freelens_kubectl", summary: "ok", callId: "k2" } });
    expect(statuses()).toEqual(["", ""]);

    await send({ type: "tool_progress", data: { callId: "k1", state: "done", problems: ["no checksum"] } });
    await send({ type: "tool_result", data: { toolName: "freelens_kubectl", summary: "ok", callId: "k1" } });
    expect(statuses()).toEqual(["Problem preparing kubectl: no checksum", ""]);
  });
});
