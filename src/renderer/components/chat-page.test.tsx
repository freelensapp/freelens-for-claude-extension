// @vitest-environment jsdom
/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Renderer } from "@freelensapp/extensions";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeStore } from "../../common/bridge-store";
import { ChatPage } from "./chat-page";

import type { StatusResponse } from "../../common/protocol";

// The host syncs BridgeStore from main into the cluster frame, possibly after
// the page has rendered. The page observes the store and asks for the status
// once the port and token arrive, without a press on Retry.

const notFound: StatusResponse = { ready: true, claudeCode: { found: false } };

describe("ChatPage", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.mocked(Renderer.Catalog.getActiveCluster).mockReturnValue({ id: "cluster-a" } as ReturnType<
      typeof Renderer.Catalog.getActiveCluster
    >);
    fetchMock.mockResolvedValue(new Response(JSON.stringify(notFound), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    BridgeStore.resetInstance();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    vi.mocked(Renderer.Catalog.getActiveCluster).mockReset();
  });

  it("asks for the status once the bridge port and token reach the store", async () => {
    const store = BridgeStore.getInstanceOrCreate<BridgeStore>();
    render(<ChatPage />);

    expect(screen.getByText("The Claude bridge is not ready yet.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      store.set({ port: 4242, token: "secret" });
    });

    expect(await screen.findByText("Claude Code is required")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:4242/status", {
      headers: { Authorization: "Bearer secret" },
    });
  });

  it("asks for the status at once when the store is already synced", async () => {
    BridgeStore.getInstanceOrCreate<BridgeStore>().set({ port: 4242, token: "secret" });
    render(<ChatPage />);

    expect(await screen.findByText("Claude Code is required")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
