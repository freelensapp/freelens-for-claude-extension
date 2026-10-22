// @vitest-environment jsdom
/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Renderer } from "@freelensapp/extensions";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeStore } from "../../common/bridge-store";
import { BridgeIpc } from "../api/bridge-ipc";
import { ChatPage } from "./chat-page";

import type { StatusResponse } from "../../common/protocol";

// The host syncs BridgeStore from main into the cluster frame, possibly after
// the page has rendered. The page observes the store and asks for the status
// once the port arrives, without a press on Retry, with the token the client
// got from main over IPC.

const notFound: StatusResponse = { ready: true, claudeCode: { found: false } };

describe("ChatPage", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let ipc: BridgeIpc;

  beforeEach(() => {
    vi.mocked(Renderer.Catalog.getActiveCluster).mockReturnValue({ id: "cluster-a" } as ReturnType<
      typeof Renderer.Catalog.getActiveCluster
    >);
    fetchMock.mockResolvedValue(new Response(JSON.stringify(notFound), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    ipc = BridgeIpc.createInstance({} as Renderer.LensExtension);
  });

  afterEach(() => {
    BridgeStore.resetInstance();
    BridgeIpc.resetInstance();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    vi.mocked(Renderer.Catalog.getActiveCluster).mockReset();
  });

  it("asks for the status once the bridge port reaches the store", async () => {
    vi.mocked(ipc.invoke).mockResolvedValue({ port: 4242, token: "secret" });
    const store = BridgeStore.getInstanceOrCreate<BridgeStore>();
    render(<ChatPage />);

    expect(screen.getByText("The Claude bridge is not ready yet.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      store.setPort(4242);
    });

    expect(await screen.findByText("Claude Code is required")).toBeTruthy();
    expect(ipc.invoke).toHaveBeenCalledWith("bridge-connection");
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:4242/status", {
      headers: { Authorization: "Bearer secret" },
    });
  });

  it("asks for the status at once when the store is already synced", async () => {
    vi.mocked(ipc.invoke).mockResolvedValue({ port: 4343, token: "secret" });
    BridgeStore.getInstanceOrCreate<BridgeStore>().setPort(4343);
    render(<ChatPage />);

    expect(await screen.findByText("Claude Code is required")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stays not ready when main refuses the frame", async () => {
    vi.mocked(ipc.invoke).mockResolvedValue(null);
    BridgeStore.getInstanceOrCreate<BridgeStore>().setPort(4444);
    render(<ChatPage />);

    expect(await screen.findByText("The Claude bridge is not ready yet.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
