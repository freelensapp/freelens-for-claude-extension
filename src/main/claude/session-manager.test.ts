/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PreferencesState } from "../../common/preferences-store";
import type { SessionEvent } from "../../common/protocol";
import type { ChatSessionState } from "../../common/session-store";

// A controllable stand-in for the SDK `Query`: an async iterable the test feeds
// messages to, plus the no-op control methods the session manager calls. Held in
// a `vi.hoisted` block so the `vi.mock` factory can reach it.
const sdk = vi.hoisted(() => {
  // The test double captures loosely-typed SDK frames, so `any` is used freely
  // (biome's noExplicitAny is off for this repo).
  class FakeQuery {
    options: any;
    private readonly buffer: any[] = [];
    private waiter?: () => void;
    private done = false;

    constructor(options: any) {
      this.options = options;
    }

    emit(message: any): void {
      this.buffer.push(message);
      this.waiter?.();
      this.waiter = undefined;
    }

    finish(): void {
      this.done = true;
      this.waiter?.();
      this.waiter = undefined;
    }

    async *[Symbol.asyncIterator](): AsyncIterator<any> {
      while (true) {
        if (this.buffer.length > 0) {
          yield this.buffer.shift();
          continue;
        }
        if (this.done) return;
        await new Promise<void>((resolve) => {
          this.waiter = resolve;
        });
      }
    }

    async interrupt(): Promise<void> {}
    async return(): Promise<void> {}
    setModel(): void {}
    async mcpServerStatus(): Promise<unknown[]> {
      return [];
    }
  }

  const queries: FakeQuery[] = [];
  return { queries, FakeQuery };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { options: unknown }) => {
    const q = new sdk.FakeQuery(args.options);
    sdk.queries.push(q);
    return q;
  },
  createSdkMcpServer: (config: { name: string }) => ({ type: "sdk", name: config.name, instance: {} }),
  tool: (name: string) => ({ name }),
}));

vi.mock("../tools/kube-client", () => ({
  getKubeClient: () => ({ clusterName: "test-cluster", objects: { read: async () => ({}) } }),
  disposeKubeClient: () => {},
}));

// Imported after the mocks are registered.
const { SessionManager } = await import("./session-manager");

let baseDir: string;

function makeManager(prefs: Partial<PreferencesState> = {}) {
  const preferences: PreferencesState = {
    podLogsRequireApproval: false,
    podLogsTailLines: 1000,
    customAgentRules: "",
    claudeCodePath: "",
    defaultModel: "",
    mcpEnabled: false,
    mcpConfiguration: '{ "mcpServers": {} }',
    subagentsEnabled: true,
    promptShortcuts: "[]",
    ...prefs,
  };
  const store: ChatSessionState = {
    read: () => undefined,
    writeSessionId: () => {},
    writePermissionMode: () => {},
    writeModel: () => {},
  };
  return new SessionManager(() => "/usr/bin/claude", baseDir, store, preferences);
}

/** Let the background consume loop drain any buffered messages. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "for-claude-test-"));
  sdk.queries.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("subagent wiring", () => {
  it("passes the cluster-analyzer agent and lets Agent/Task through when enabled", async () => {
    const manager = makeManager({ subagentsEnabled: true });
    await manager.sendMessage("c1", "hello");
    const options = sdk.queries.at(-1)?.options;
    expect(Object.keys(options.agents)).toContain("cluster-analyzer");
    expect(options.disallowedTools).not.toContain("Task");
    expect(options.allowedTools).toContain("Agent");
  });

  it("omits the agent and keeps Task disallowed when disabled", async () => {
    const manager = makeManager({ subagentsEnabled: false });
    await manager.sendMessage("c2", "hello");
    const options = sdk.queries.at(-1)?.options;
    expect(options.agents).toBeUndefined();
    expect(options.disallowedTools).toContain("Task");
    expect(options.allowedTools).not.toContain("Agent");
  });

  it("tags subagent tool calls and results with the parent Agent call id", async () => {
    const manager = makeManager();
    const events: SessionEvent[] = [];
    manager.subscribe("c3", (event) => events.push(event));
    await manager.sendMessage("c3", "investigate");
    const q = sdk.queries.at(-1);
    q?.emit({
      type: "assistant",
      parent_tool_use_id: "agent-1",
      message: {
        content: [
          { type: "tool_use", id: "call-9", name: "mcp__freelens-kube__freelens_resources", input: { kind: "Pod" } },
        ],
      },
    });
    q?.emit({
      type: "user",
      parent_tool_use_id: "agent-1",
      message: { content: [{ type: "tool_result", tool_use_id: "call-9", content: "ok" }] },
    });
    await flush();

    const call = events.find((event) => event.type === "tool_call" && event.data.callId === "call-9");
    const result = events.find((event) => event.type === "tool_result" && event.data.callId === "call-9");
    expect(call?.type === "tool_call" && call.data.parentCallId).toBe("agent-1");
    expect(result?.type === "tool_result" && result.data.parentCallId).toBe("agent-1");
  });

  it("does not forward subagent prose as assistant messages", async () => {
    const manager = makeManager();
    const events: SessionEvent[] = [];
    manager.subscribe("c4", (event) => events.push(event));
    await manager.sendMessage("c4", "investigate");
    const q = sdk.queries.at(-1);
    q?.emit({
      type: "assistant",
      parent_tool_use_id: "agent-1",
      message: { content: [{ type: "text", text: "subagent thoughts" }] },
    });
    await flush();
    expect(events.some((event) => event.type === "assistant_message")).toBe(false);
  });
});

describe("slash commands", () => {
  it("captures init slash_commands into session_meta", async () => {
    const manager = makeManager();
    const events: SessionEvent[] = [];
    manager.subscribe("s1", (event) => events.push(event));
    await manager.sendMessage("s1", "hello");
    const q = sdk.queries.at(-1);
    q?.emit({
      type: "system",
      subtype: "init",
      session_id: "sess-1",
      model: "claude-x",
      mcp_servers: [],
      slash_commands: ["clear", "compact", "help"],
    });
    await flush();
    const meta = events.filter((event) => event.type === "session_meta").at(-1);
    expect(meta?.type === "session_meta" && meta.data.slashCommands).toEqual(["clear", "compact", "help"]);
  });

  it("emits and persists local_command_output for replay", async () => {
    const manager = makeManager();
    manager.subscribe("s2", () => {});
    await manager.sendMessage("s2", "hello");
    const q = sdk.queries.at(-1);
    q?.emit({ type: "system", subtype: "local_command_output", content: "compacted 3 messages" });
    await flush();

    // A late subscriber replays the persisted transcript, proving the event is
    // on the persisted-events allowlist.
    const replay: SessionEvent[] = [];
    manager.subscribe("s2", (event) => replay.push(event));
    const output = replay.find((event) => event.type === "local_command_output");
    expect(output?.type === "local_command_output" && output.data.content).toBe("compacted 3 messages");
  });

  it("emits a local_command_output fallback on conversation_reset", async () => {
    const manager = makeManager();
    const events: SessionEvent[] = [];
    manager.subscribe("s3", (event) => events.push(event));
    await manager.sendMessage("s3", "hello");
    const q = sdk.queries.at(-1);
    q?.emit({ type: "conversation_reset", new_conversation_id: "n1", uuid: "u1", session_id: "sess-1" });
    await flush();
    const output = events.find((event) => event.type === "local_command_output");
    expect(output?.type === "local_command_output" && output.data.content).toBe("Conversation cleared by /clear");
  });
});
