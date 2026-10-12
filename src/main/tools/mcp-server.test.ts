/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Main } from "@freelensapp/extensions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessRegistry } from "./cli-exec";
import { createKubeMcpServer, toolUseIdOf } from "./mcp-server";

import type { PreparationReports } from "./cli-exec";
import type { KubeClient } from "./kube-client";

describe("toolUseIdOf", () => {
  it("takes the tool_use id from the claudecode/toolUseId key of _meta", () => {
    expect(toolUseIdOf({ _meta: { "claudecode/toolUseId": "toolu_1" } })).toBe("toolu_1");
  });

  it("is undefined without a string id", () => {
    expect(toolUseIdOf(undefined)).toBeUndefined();
    expect(toolUseIdOf({})).toBeUndefined();
    expect(toolUseIdOf({ _meta: {} })).toBeUndefined();
    expect(toolUseIdOf({ _meta: { "claudecode/toolUseId": 1 } })).toBeUndefined();
    expect(toolUseIdOf({ _meta: { "claudecode/toolUseId": "" } })).toBeUndefined();
  });
});

describe("createKubeMcpServer", () => {
  afterEach(() => {
    vi.mocked(Main.Shell.getKubectlPath).mockReset();
    vi.mocked(Main.Shell.getEnvironment).mockReset();
  });

  // The SDK's own MCP server, sent a request as Claude Code sends it: the
  // handler of a tool gets the request's `_meta` in `extra`.
  it("reports the preparation of a kubectl call under the tool_use id of the request's _meta", async () => {
    vi.mocked(Main.Shell.getKubectlPath).mockRejectedValue(new Error("not connected"));
    vi.mocked(Main.Shell.getEnvironment).mockRejectedValue(new Error("not connected"));
    const begun: string[] = [];
    const failed: string[] = [];
    const preparations: PreparationReports = {
      begin: (callId) => {
        begun.push(callId);
        return {
          phase: () => {},
          progress: () => {},
          problem: () => {},
          done: () => {},
          failed: (message) => failed.push(message),
        };
      },
    };
    const client = { clusterId: "c1", ensureConnected: () => {} } as unknown as KubeClient;
    const server = createKubeMcpServer(client, undefined, new ProcessRegistry(), preparations);

    const sent: { id?: number; result?: { content?: { text: string }[] } }[] = [];
    let deliver: ((message: unknown) => void) | undefined;
    const transport = {
      start: async () => {},
      close: async () => {},
      send: async (message: (typeof sent)[number]) => {
        sent.push(message);
      },
      set onmessage(handler: (message: unknown) => void) {
        deliver = handler;
      },
    };
    await server.instance.connect(transport as unknown as Parameters<typeof server.instance.connect>[0]);
    deliver?.({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    await vi.waitFor(() => expect(sent.some((message) => message.id === 1)).toBe(true));
    deliver?.({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "freelens_kubectl",
        arguments: { args: ["version"] },
        _meta: { "claudecode/toolUseId": "toolu_1" },
      },
    });
    await vi.waitFor(() => expect(sent.some((message) => message.id === 2)).toBe(true));

    expect(begun).toEqual(["toolu_1"]);
    expect(failed).toEqual(["not connected"]);
    expect(sent.find((message) => message.id === 2)?.result?.content?.[0]?.text).toBe("Tool error: not connected");
  });
});
