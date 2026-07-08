/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Common } from "@freelensapp/extensions";
import { type SessionErrorKind, type SessionEvent, sessionEvent } from "../../common/protocol";
import { disposeKubeClient, getKubeClient } from "../tools/kube-client";
import { ALLOWED_TOOL_NAMES, createKubeMcpServer, MCP_SERVER_NAME } from "../tools/mcp-server";

import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/** Claude Code built-in tools that must never run against a cluster chat. */
const DISALLOWED_BUILTIN_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "Task",
  "TodoWrite",
];

/** Event types kept for transcript replay when a page remounts. */
const PERSISTED_EVENTS = new Set<SessionEvent["type"]>([
  "user_message",
  "assistant_message",
  "tool_call",
  "tool_result",
  "error",
]);

type SessionListener = (event: SessionEvent) => void;

/** A minimal push-based async iterable used as the SDK streaming input. */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly buffer: SDKUserMessage[] = [];
  private resolve?: () => void;
  private closed = false;

  push(message: SDKUserMessage): void {
    this.buffer.push(message);
    this.resolve?.();
    this.resolve = undefined;
  }

  close(): void {
    this.closed = true;
    this.resolve?.();
    this.resolve = undefined;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift() as SDKUserMessage;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.resolve = resolve;
      });
    }
  }
}

/** Loosely-typed view of an assistant/user message content block. */
interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function classifyError(reason: string | undefined): SessionErrorKind {
  if (reason === "authentication_failed" || reason === "oauth_org_not_allowed") return "auth";
  return "other";
}

function summarizeToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as ContentBlock).text) : ""))
      .join("");
  }
  return "";
}

/** One live Claude Code conversation, bound to a single cluster. */
class ClusterSession {
  private readonly transcript: SessionEvent[] = [];
  private readonly subscribers = new Set<SessionListener>();
  private readonly input = new MessageQueue();
  private readonly abort = new AbortController();
  private readonly toolNames = new Map<string, string>();
  private queryHandle?: Query;
  private working = false;
  private started = false;

  constructor(
    private readonly clusterId: string,
    private readonly resolveClaudeCodePath: () => string | undefined,
    private readonly baseDir: string,
  ) {}

  subscribe(listener: SessionListener): () => void {
    this.subscribers.add(listener);
    listener(sessionEvent("status", { state: this.working ? "working" : "idle" }));
    for (const event of this.transcript) listener(event);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  private emit(event: SessionEvent): void {
    if (PERSISTED_EVENTS.has(event.type)) this.transcript.push(event);
    for (const listener of this.subscribers) listener(event);
  }

  private setWorking(working: boolean): void {
    this.working = working;
    this.emit(sessionEvent("status", { state: working ? "working" : "idle" }));
  }

  async sendMessage(text: string): Promise<void> {
    this.emit(sessionEvent("user_message", { text }));
    this.setWorking(true);
    if (!this.started) {
      await this.start();
    }
    if (!this.queryHandle) {
      // start() failed (e.g. Claude Code missing); the error was already emitted.
      return;
    }
    this.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: this.clusterId,
    } as SDKUserMessage);
  }

  private async start(): Promise<void> {
    this.started = true;

    const claudeCodePath = this.resolveClaudeCodePath();
    if (!claudeCodePath) {
      this.emit(
        sessionEvent("error", {
          message: 'Claude Code was not found. Install it and run "claude" once to log in, then try again.',
          kind: "not_found",
        }),
      );
      this.setWorking(false);
      this.started = false;
      return;
    }

    const cwd = join(this.baseDir, "clusters", this.clusterId);
    try {
      await mkdir(cwd, { recursive: true });
    } catch {
      // Fall back to the base dir; a missing scratch dir is not fatal.
    }

    const client = getKubeClient(this.clusterId);

    this.queryHandle = query({
      prompt: this.input,
      options: {
        abortController: this.abort,
        pathToClaudeCodeExecutable: claudeCodePath,
        cwd,
        mcpServers: { [MCP_SERVER_NAME]: createKubeMcpServer(client) },
        allowedTools: ALLOWED_TOOL_NAMES,
        disallowedTools: DISALLOWED_BUILTIN_TOOLS,
        settingSources: [],
        includePartialMessages: true,
        canUseTool: async (toolName) =>
          ALLOWED_TOOL_NAMES.includes(toolName)
            ? { behavior: "allow", updatedInput: {} }
            : { behavior: "deny", message: `Tool "${toolName}" is not permitted in this read-only cluster chat.` },
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: `You are operating on the Kubernetes cluster "${client.clusterName}" through read-only tools. You cannot modify the cluster; only inspect it. Prefer the kube_ tools to answer questions about cluster state.`,
        },
      },
    });

    void this.consume();
  }

  private async consume(): Promise<void> {
    if (!this.queryHandle) return;
    try {
      for await (const message of this.queryHandle) {
        this.handleMessage(message);
      }
    } catch (error) {
      if (!this.abort.signal.aborted) {
        this.emit(
          sessionEvent("error", {
            message: error instanceof Error ? error.message : String(error),
            kind: "other",
          }),
        );
      }
    } finally {
      this.setWorking(false);
    }
  }

  private handleMessage(message: SDKMessage): void {
    switch (message.type) {
      case "stream_event": {
        const event = message.event as { type?: string; delta?: { type?: string; text?: string } };
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          this.emit(sessionEvent("assistant_delta", { text: event.delta.text }));
        }
        break;
      }
      case "assistant": {
        if (message.error) {
          this.emit(
            sessionEvent("error", {
              message: `Claude Code reported an error (${message.error}). If this is an authentication problem, run "claude" in a terminal to log in.`,
              kind: classifyError(message.error),
            }),
          );
        }
        const blocks = (message.message?.content ?? []) as ContentBlock[];
        for (const block of blocks) {
          if (block.type === "text" && block.text) {
            this.emit(sessionEvent("assistant_message", { text: block.text }));
          } else if (block.type === "tool_use") {
            if (block.id && block.name) this.toolNames.set(block.id, block.name);
            this.emit(sessionEvent("tool_call", { toolName: block.name ?? "tool", input: block.input }));
          }
        }
        break;
      }
      case "user": {
        const blocks = (message.message?.content ?? []) as ContentBlock[];
        if (!Array.isArray(blocks)) break;
        for (const block of blocks) {
          if (block.type === "tool_result") {
            const toolName = (block.tool_use_id && this.toolNames.get(block.tool_use_id)) || "tool";
            this.emit(
              sessionEvent("tool_result", {
                toolName,
                summary: summarizeToolResult(block.content).slice(0, 2000),
              }),
            );
          }
        }
        break;
      }
      case "result": {
        if (message.subtype !== "success") {
          this.emit(
            sessionEvent("error", {
              message: `The turn ended without completing (${message.subtype}).`,
              kind: "other",
            }),
          );
        }
        this.setWorking(false);
        this.emit(sessionEvent("turn_complete", {}));
        break;
      }
      default:
        break;
    }
  }

  async interrupt(): Promise<void> {
    try {
      await this.queryHandle?.interrupt();
    } catch {
      // Interrupt is best-effort; ignore if the query is not streaming.
    }
    this.setWorking(false);
  }

  async dispose(): Promise<void> {
    this.input.close();
    this.abort.abort();
    try {
      await this.queryHandle?.return(undefined);
    } catch {
      // ignore
    }
    disposeKubeClient(this.clusterId);
    this.subscribers.clear();
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, ClusterSession>();

  constructor(
    private readonly resolveClaudeCodePath: () => string | undefined,
    private readonly baseDir: string,
  ) {}

  private getOrCreate(clusterId: string): ClusterSession {
    let session = this.sessions.get(clusterId);
    if (!session) {
      session = new ClusterSession(clusterId, this.resolveClaudeCodePath, this.baseDir);
      this.sessions.set(clusterId, session);
    }
    return session;
  }

  subscribe(clusterId: string, listener: SessionListener): () => void {
    return this.getOrCreate(clusterId).subscribe(listener);
  }

  async sendMessage(clusterId: string, text: string): Promise<void> {
    try {
      await this.getOrCreate(clusterId).sendMessage(text);
    } catch (error) {
      Common.logger.error(`[for-claude] failed to send message: ${error}`);
      throw error;
    }
  }

  async interrupt(clusterId: string): Promise<void> {
    await this.sessions.get(clusterId)?.interrupt();
  }

  async dispose(clusterId: string): Promise<void> {
    const session = this.sessions.get(clusterId);
    if (!session) return;
    this.sessions.delete(clusterId);
    await session.dispose();
  }

  async disposeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((session) => session.dispose()));
  }
}
