// @vitest-environment jsdom
/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreferencesStore } from "../../common/preferences-store";
import { ChatView } from "./chat-view";

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
});
