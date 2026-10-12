/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Main } from "@freelensapp/extensions";
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
  createSdkMcpServer: (config: { name: string; tools?: unknown[] }) => ({
    type: "sdk",
    name: config.name,
    instance: {},
    tools: config.tools,
  }),
  tool: (name: string, _description: string, _schema: unknown, handler: unknown) => ({ name, handler }),
}));

vi.mock("../tools/kube-client", () => ({
  getKubeClient: (clusterId: string) => ({
    clusterId,
    clusterName: "test-cluster",
    ensureConnected: () => {},
    read: async () => ({}),
  }),
  disposeKubeClient: () => {},
}));

// Imported after the mocks are registered.
const { SessionManager } = await import("./session-manager");

let baseDir: string;
/** The Claude Code configuration directory the sessions read, empty unless a test writes to it. */
let configDir: string;

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
    writeEffort: () => {},
  };
  return new SessionManager(() => "/usr/bin/claude", baseDir, store, preferences);
}

/** Let the background consume loop drain any buffered messages. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "for-claude-test-"));
  configDir = mkdtempSync(join(tmpdir(), "for-claude-config-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
  sdk.queries.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("query options", () => {
  it("asks for the default permission mode so every gated call reaches canUseTool", async () => {
    const manager = makeManager();
    await manager.sendMessage("c0", "hello");
    expect(sdk.queries.at(-1)?.options.permissionMode).toBe("default");
  });
});

describe("user settings of Claude Code", () => {
  it("loads no settings file and passes no settings without one", async () => {
    const manager = makeManager();
    await manager.sendMessage("u0", "hello");
    const options = sdk.queries.at(-1)?.options;
    expect(options.settingSources).toEqual([]);
    expect(options.settings).toBeUndefined();
  });

  it("passes only the provider and authentication keys, still loading no settings file", async () => {
    writeFileSync(
      join(configDir, "settings.json"),
      JSON.stringify({
        env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "eu-central-1" },
        awsAuthRefresh: "aws sso login",
        permissions: { allow: ["mcp__freelens-kube__*"] },
        hooks: { PreToolUse: [] },
        mcpServers: { other: { command: "other" } },
      }),
    );
    const manager = makeManager();
    await manager.sendMessage("u1", "hello");
    const options = sdk.queries.at(-1)?.options;
    expect(options.settingSources).toEqual([]);
    expect(options.settings).toEqual({
      env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "eu-central-1" },
      awsAuthRefresh: "aws sso login",
    });
    expect(Object.keys(options.mcpServers)).toEqual(["freelens-kube"]);
  });

  it("starts the session without the file when it is not valid JSON", async () => {
    writeFileSync(join(configDir, "settings.json"), "{ not json");
    const manager = makeManager();
    await manager.sendMessage("u2", "hello");
    const options = sdk.queries.at(-1)?.options;
    expect(options.settingSources).toEqual([]);
    expect(options.settings).toBeUndefined();
  });

  it("reads the file again at the next session start", async () => {
    const manager = makeManager();
    await manager.sendMessage("u3", "hello");
    expect(sdk.queries.at(-1)?.options.settings).toBeUndefined();

    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_USE_VERTEX: "1" } }));
    await manager.sendMessage("u4", "hello");
    expect(sdk.queries.at(-1)?.options.settings).toEqual({ env: { CLAUDE_CODE_USE_VERTEX: "1" } });
  });
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

describe("kubectl preparation", () => {
  /** The handler the session's built-in MCP server registered for a tool. */
  function toolHandler(name: string): (args: unknown, extra: unknown) => Promise<unknown> {
    const server = sdk.queries.at(-1)?.options.mcpServers["freelens-kube"];
    return server.tools.find((entry: { name: string }) => entry.name === name).handler;
  }

  it("sends it as tool_progress for the call, replays it to a late subscriber, and stops it on interrupt", async () => {
    // The host never finishes preparing kubectl.
    vi.mocked(Main.Shell.getKubectlPath).mockImplementationOnce((_clusterId, options) => {
      (options as Main.Shell.KubectlDownloadOptions).onPhase?.("Verifying kubectl v1.37.0 ...");
      return new Promise<string>(() => {});
    });
    vi.mocked(Main.Shell.getEnvironment).mockImplementationOnce(() => new Promise(() => {}));
    const manager = makeManager();
    const events: SessionEvent[] = [];
    manager.subscribe("p1", (event) => events.push(event));
    await manager.sendMessage("p1", "which kubectl?");
    void toolHandler("freelens_kubectl")({ args: ["version"] }, { _meta: { "claudecode/toolUseId": "toolu_9" } });
    await flush();

    const preparing = { callId: "toolu_9", state: "preparing", phase: "Verifying kubectl v1.37.0 ..." };
    expect(events.filter((event) => event.type === "tool_progress").map((event) => event.data)).toEqual([preparing]);

    const reopened: SessionEvent[] = [];
    manager.subscribe("p1", (event) => reopened.push(event));
    expect(reopened.filter((event) => event.type === "tool_progress").map((event) => event.data)).toEqual([preparing]);

    await manager.interrupt("p1");
    expect(events.filter((event) => event.type === "tool_progress").at(-1)?.data).toEqual({
      callId: "toolu_9",
      state: "stopped",
    });

    // The stop is in the transcript; the preparation is not running any more.
    const replay: SessionEvent[] = [];
    manager.subscribe("p1", (event) => replay.push(event));
    expect(replay.filter((event) => event.type === "tool_progress").map((event) => event.data)).toEqual([
      { callId: "toolu_9", state: "stopped" },
    ]);
  });
});

describe("tool result outcome", () => {
  const RESOURCES = "mcp__freelens-kube__freelens_resources";
  const DELETE_POD = "mcp__freelens-kube__freelens_delete_pod";

  /** A started session on `clusterId`, its events, and helpers that feed the fake query. */
  async function startSession(clusterId: string) {
    const manager = makeManager();
    const events: SessionEvent[] = [];
    manager.subscribe(clusterId, (event) => events.push(event));
    await manager.sendMessage(clusterId, "go");
    const q = sdk.queries.at(-1);
    return {
      manager,
      events,
      call: (id: string, name: string, parentCallId: string | null = null) =>
        q?.emit({
          type: "assistant",
          parent_tool_use_id: parentCallId,
          message: { content: [{ type: "tool_use", id, name, input: {} }] },
        }),
      result: (id: string, isError?: boolean, parentCallId: string | null = null) =>
        q?.emit({
          type: "user",
          parent_tool_use_id: parentCallId,
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: id,
                content: "text",
                ...(isError === undefined ? {} : { is_error: isError }),
              },
            ],
          },
        }),
      canUseTool: (name: string, toolUseID: string, signal = new AbortController().signal) =>
        q?.options.canUseTool(name, {}, { signal, toolUseID }),
      emit: (message: unknown) => q?.emit(message),
      outcome: (id: string) => {
        const event = events.find((entry) => entry.type === "tool_result" && entry.data.callId === id);
        return event?.type === "tool_result" ? event.data.outcome : undefined;
      },
    };
  }

  it("is success for a result without is_error, and error for one with it", async () => {
    const session = await startSession("o1");
    session.call("ok", RESOURCES);
    session.result("ok");
    session.call("failed", RESOURCES);
    session.result("failed", true);
    await flush();
    expect(session.outcome("ok")).toBe("success");
    expect(session.outcome("failed")).toBe("error");
  });

  it("is denied for a call that canUseTool refused, Read only mode included", async () => {
    const session = await startSession("o2");
    session.manager.setPermissionMode("o2", "readOnly");
    session.call("read-only", DELETE_POD);
    await expect(session.canUseTool(DELETE_POD, "read-only")).resolves.toMatchObject({ behavior: "deny" });
    session.call("not-permitted", "Bash");
    await expect(session.canUseTool("Bash", "not-permitted")).resolves.toMatchObject({ behavior: "deny" });
    session.result("read-only", true);
    session.result("not-permitted", true);
    await flush();
    expect(session.outcome("read-only")).toBe("denied");
    expect(session.outcome("not-permitted")).toBe("denied");
  });

  it("is denied for a call that Deny on its approval card refused, also inside a subagent", async () => {
    const session = await startSession("o3");
    session.call("agent-1", "Agent");
    session.call("nested", DELETE_POD, "agent-1");
    const decision = session.canUseTool(DELETE_POD, "nested");
    await flush();
    const request = session.events.find((event) => event.type === "permission_request");
    expect(request?.type).toBe("permission_request");
    session.manager.resolvePermission(request?.type === "permission_request" ? request.data.requestId : "", "deny");
    await expect(decision).resolves.toMatchObject({ behavior: "deny" });
    session.result("nested", true, "agent-1");
    session.result("agent-1");
    await flush();
    expect(session.outcome("nested")).toBe("denied");
    expect(session.outcome("agent-1")).toBe("success");
  });

  it("is denied for a call that Claude Code denied without asking canUseTool", async () => {
    const session = await startSession("o4");
    session.call("ruled-out", RESOURCES);
    session.emit({
      type: "system",
      subtype: "permission_denied",
      tool_name: RESOURCES,
      tool_use_id: "ruled-out",
      message: "denied by rule",
    });
    session.result("ruled-out", true);
    await flush();
    expect(session.outcome("ruled-out")).toBe("denied");
  });

  it("is interrupted for a call open when the turn was stopped, with or without is_error", async () => {
    const session = await startSession("o5");
    session.call("done", RESOURCES);
    session.result("done");
    session.call("running", RESOURCES);
    session.call("killed", "mcp__freelens-kube__freelens_kubectl");
    await flush();
    await session.manager.interrupt("o5");
    session.result("running", true);
    session.result("killed");
    // A call of the next turn is not affected by the earlier stop.
    session.call("later", RESOURCES);
    session.result("later", true);
    await flush();
    expect(session.outcome("done")).toBe("success");
    expect(session.outcome("running")).toBe("interrupted");
    expect(session.outcome("killed")).toBe("interrupted");
    expect(session.outcome("later")).toBe("error");
  });

  it("is interrupted, not denied, for a call whose approval the stop denied", async () => {
    const session = await startSession("o6");
    session.call("pending", DELETE_POD);
    const controller = new AbortController();
    const decision = session.canUseTool(DELETE_POD, "pending", controller.signal);
    await flush();
    await session.manager.interrupt("o6");
    await expect(decision).resolves.toMatchObject({ behavior: "deny" });
    session.result("pending", true);
    await flush();
    expect(session.outcome("pending")).toBe("interrupted");
    // Its approval card shows it stopped too, not denied.
    const resolved = session.events.find((event) => event.type === "permission_resolved");
    expect(resolved?.type === "permission_resolved" && resolved.data.stopped).toBe(true);
  });

  it("is not denied for a call whose approval the abort signal ended", async () => {
    const session = await startSession("o7");
    session.call("aborted", DELETE_POD);
    const controller = new AbortController();
    const decision = session.canUseTool(DELETE_POD, "aborted", controller.signal);
    await flush();
    controller.abort();
    await expect(decision).resolves.toMatchObject({ behavior: "deny" });
    session.result("aborted", true);
    await flush();
    // Nobody decided against the call; its result goes by its flag.
    expect(session.outcome("aborted")).toBe("error");
  });

  it("ends a stopped turn with turn_stopped, persisted, instead of a retryable error", async () => {
    const session = await startSession("o9");
    session.call("watching", "mcp__freelens-kube__freelens_kubectl");
    await flush();
    await session.manager.interrupt("o9");
    session.result("watching", true);
    session.emit({ type: "result", subtype: "error_during_execution" });
    await flush();
    const types = (events: SessionEvent[]) => events.map((event) => event.type);
    expect(types(session.events)).toContain("turn_stopped");
    expect(types(session.events)).not.toContain("error");
    const replay: SessionEvent[] = [];
    session.manager.subscribe("o9", (event) => replay.push(event));
    expect(types(replay)).toContain("turn_stopped");
  });

  it("keeps the retryable error for a turn that fails without a stop, also after a stopped one", async () => {
    const session = await startSession("o10");
    await session.manager.interrupt("o10");
    session.emit({ type: "result", subtype: "error_during_execution" });
    await session.manager.sendMessage("o10", "again");
    session.emit({ type: "result", subtype: "error_during_execution" });
    await flush();
    const ends = session.events.filter((event) => event.type === "turn_stopped" || event.type === "error");
    expect(ends.map((event) => event.type)).toEqual(["turn_stopped", "error"]);
    expect(ends[1]?.type === "error" && ends[1].data.canRetry).toBe(true);
  });

  it("persists the outcome with the result, so it replays after a remount", async () => {
    const session = await startSession("o8");
    session.call("failed", RESOURCES);
    session.result("failed", true);
    await flush();
    const replay: SessionEvent[] = [];
    session.manager.subscribe("o8", (event) => replay.push(event));
    const result = replay.find((event) => event.type === "tool_result" && event.data.callId === "failed");
    expect(result?.type === "tool_result" && result.data.outcome).toBe("error");
  });
});

describe("reasoning fold", () => {
  it("emits assistant_thinking on a thinking_delta stream event", async () => {
    const manager = makeManager();
    const events: SessionEvent[] = [];
    manager.subscribe("t1", (event) => events.push(event));
    await manager.sendMessage("t1", "hello");
    const q = sdk.queries.at(-1);
    q?.emit({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "let me think" } },
    });
    await flush();
    const thinking = events.find((event) => event.type === "assistant_thinking");
    expect(thinking?.type === "assistant_thinking" && thinking.data.delta).toBe("let me think");
  });

  it("attaches accumulated reasoning to the next assistant message and resets after it", async () => {
    const manager = makeManager();
    const events: SessionEvent[] = [];
    manager.subscribe("t3", (event) => events.push(event));
    await manager.sendMessage("t3", "hello");
    const q = sdk.queries.at(-1);
    q?.emit({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "step 1 " } },
    });
    q?.emit({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "step 2" } },
    });
    q?.emit({ type: "assistant", message: { content: [{ type: "text", text: "the answer" }] } });
    await flush();

    const message = events.find((event) => event.type === "assistant_message");
    expect(message?.type === "assistant_message" && message.data.text).toBe("the answer");
    expect(message?.type === "assistant_message" && message.data.reasoning).toBe("step 1 step 2");

    // A later text block in the same turn carries no leftover reasoning.
    q?.emit({ type: "assistant", message: { content: [{ type: "text", text: "second" }] } });
    await flush();
    const second = events.filter((event) => event.type === "assistant_message").at(-1);
    expect(second?.type === "assistant_message" && second.data.reasoning).toBeUndefined();
  });

  it("persists reasoning with the assistant message so it replays after a remount", async () => {
    const manager = makeManager();
    manager.subscribe("t5", () => {});
    await manager.sendMessage("t5", "hello");
    const q = sdk.queries.at(-1);
    q?.emit({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "durable" } },
    });
    q?.emit({ type: "assistant", message: { content: [{ type: "text", text: "answer" }] } });
    await flush();

    const replay: SessionEvent[] = [];
    manager.subscribe("t5", (event) => replay.push(event));
    const message = replay.find((event) => event.type === "assistant_message");
    expect(message?.type === "assistant_message" && message.data.reasoning).toBe("durable");
  });

  it("does not persist assistant_thinking for replay", async () => {
    const manager = makeManager();
    manager.subscribe("t2", () => {});
    await manager.sendMessage("t2", "hello");
    const q = sdk.queries.at(-1);
    q?.emit({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "ephemeral" } },
    });
    await flush();

    // A late subscriber replays the persisted transcript; live-only thinking
    // must not appear there.
    const replay: SessionEvent[] = [];
    manager.subscribe("t2", (event) => replay.push(event));
    expect(replay.some((event) => event.type === "assistant_thinking")).toBe(false);
  });
});
