/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BridgeConnection, BridgeStore } from "../../common/bridge-store";
import { BridgeClient } from "./bridge-client";

const okStatus = () => new Response(JSON.stringify({ ready: true, claudeCode: { found: true } }), { status: 200 });

describe("BridgeClient connection", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const requestConnection = vi.fn<() => Promise<BridgeConnection | null>>();
  let store: BridgeStore;

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(async () => okStatus());
    store = BridgeStore.getInstanceOrCreate<BridgeStore>();
    store.setPort(4242);
  });

  afterEach(() => {
    BridgeStore.resetInstance();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    requestConnection.mockReset();
  });

  it("is ready once the store has a port", () => {
    const client = new BridgeClient(requestConnection);
    expect(client.isReady).toBe(true);
    store.setPort(0);
    expect(client.isReady).toBe(false);
  });

  it("asks main for the token once per port and sends it as a bearer token", async () => {
    requestConnection.mockResolvedValue({ port: 4242, token: "secret" });
    const client = new BridgeClient(requestConnection);

    await client.getStatus();
    await client.getUsage("c1").catch(() => {});

    expect(requestConnection).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "http://127.0.0.1:4242/status", {
      headers: { Authorization: "Bearer secret" },
    });
  });

  it("keeps the request's own headers next to the token", async () => {
    requestConnection.mockResolvedValue({ port: 4242, token: "secret" });
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    const client = new BridgeClient(requestConnection);

    await client.sendMessage("c1", "hi");

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:4242/clusters/c1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
      body: JSON.stringify({ text: "hi" }),
    });
  });

  it("asks again when a new bridge announces another port", async () => {
    requestConnection
      .mockResolvedValueOnce({ port: 4242, token: "first" })
      .mockResolvedValueOnce({ port: 5353, token: "second" });
    const client = new BridgeClient(requestConnection);

    await client.getStatus();
    store.setPort(5353);
    await client.getStatus();

    expect(requestConnection).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith("http://127.0.0.1:5353/status", {
      headers: { Authorization: "Bearer second" },
    });
  });

  it("fails without a request when main refuses the frame, and asks again next time", async () => {
    requestConnection.mockResolvedValueOnce(null).mockResolvedValueOnce({ port: 4242, token: "secret" });
    const client = new BridgeClient(requestConnection);

    await expect(client.getStatus()).rejects.toThrow("refused");
    expect(fetchMock).not.toHaveBeenCalled();

    await client.getStatus();
    expect(requestConnection).toHaveBeenCalledTimes(2);
  });

  it("asks again after the IPC call fails", async () => {
    requestConnection
      .mockRejectedValueOnce(new Error("No handler registered"))
      .mockResolvedValueOnce({ port: 4242, token: "secret" });
    const client = new BridgeClient(requestConnection);

    await expect(client.getStatus()).rejects.toThrow("No handler registered");
    await client.getStatus();

    expect(requestConnection).toHaveBeenCalledTimes(2);
  });

  it("asks again after a 401", async () => {
    requestConnection
      .mockResolvedValueOnce({ port: 4242, token: "stale" })
      .mockResolvedValueOnce({ port: 4242, token: "fresh" });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const client = new BridgeClient(requestConnection);

    await expect(client.getStatus()).rejects.toThrow("401");
    await client.getStatus();

    expect(fetchMock).toHaveBeenLastCalledWith("http://127.0.0.1:4242/status", {
      headers: { Authorization: "Bearer fresh" },
    });
  });
});
