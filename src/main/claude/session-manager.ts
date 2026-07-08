/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Common } from "@freelensapp/extensions";
import {
  type PermissionBehavior,
  type PermissionMode,
  type SessionErrorKind,
  type SessionEvent,
  sessionEvent,
} from "../../common/protocol";
import { disposeKubeClient, getKubeClient, type KubeClient } from "../tools/kube-client";
import { stripManagedFields, toYaml } from "../tools/kube-format";
import {
  ALLOWED_TOOL_NAMES,
  createKubeMcpServer,
  isKnownToolName,
  isMutatingToolName,
  MCP_SERVER_NAME,
  unqualifyToolName,
} from "../tools/mcp-server";
import { PermissionBroker, type ResolveResult } from "./permission-broker";

import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ChatSessionState } from "../../common/session-store";
import type { ApprovalTarget } from "../tools/approval";

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
  "permission_request",
  "permission_resolved",
]);

/** Delay after the last persisted event before the transcript is flushed to disk. */
const TRANSCRIPT_DEBOUNCE_MS = 500;

/** Per-cluster scratch directory holding the resumable transcript. */
function clusterDir(baseDir: string, clusterId: string): string {
  return join(baseDir, "clusters", clusterId);
}

/** Path of the persisted transcript for a cluster. */
function transcriptPath(baseDir: string, clusterId: string): string {
  return join(clusterDir(baseDir, clusterId), "transcript.json");
}

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
  private readonly broker: PermissionBroker;
  private readonly dir: string;
  private readonly transcriptFile: string;
  private client?: KubeClient;
  private claudeCodePath?: string;
  private resumed = false;
  private resumeRetried = false;
  private sessionId?: string;
  private queryHandle?: Query;
  private working = false;
  private started = false;
  private writeTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly clusterId: string,
    private readonly resolveClaudeCodePath: () => string | undefined,
    baseDir: string,
    private readonly store: ChatSessionState,
  ) {
    this.dir = clusterDir(baseDir, clusterId);
    this.transcriptFile = transcriptPath(baseDir, clusterId);
    this.broker = new PermissionBroker(
      (event) => this.emit(event),
      (target) => this.captureBackup(target),
      () => randomUUID(),
      () => this.resumed,
    );
    // Restore the persisted permission mode (mutating setMode directly, without
    // re-persisting) and the transcript so a reconnecting page replays history.
    const persisted = this.store.read(clusterId);
    if (persisted?.permissionMode) this.broker.setMode(persisted.permissionMode);
    this.loadTranscript();
  }

  /** Load the persisted transcript synchronously so the first subscriber replays it. */
  private loadTranscript(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.transcriptFile, "utf8"));
      if (Array.isArray(parsed)) this.transcript.push(...(parsed as SessionEvent[]));
    } catch {
      // No transcript yet (or unreadable); start with an empty history.
    }
  }

  subscribe(listener: SessionListener): () => void {
    this.subscribers.add(listener);
    listener(sessionEvent("status", { state: this.working ? "working" : "idle" }));
    listener(sessionEvent("session_meta", { permissionMode: this.broker.getMode(), resumed: this.resumed }));
    for (const event of this.transcript) listener(event);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  getPermissionMode(): PermissionMode {
    return this.broker.getMode();
  }

  setPermissionMode(mode: PermissionMode): void {
    this.broker.setMode(mode);
    // `acceptAll` is intentionally not persisted (the store ignores it).
    this.store.writePermissionMode(this.clusterId, mode);
  }

  /** Resolve a pending approval; reports whether it was found or already settled. */
  resolvePermission(requestId: string, behavior: PermissionBehavior): ResolveResult {
    return this.broker.resolve(requestId, behavior);
  }

  private emit(event: SessionEvent): void {
    if (PERSISTED_EVENTS.has(event.type)) {
      this.transcript.push(event);
      this.scheduleTranscriptWrite();
    }
    for (const listener of this.subscribers) listener(event);
  }

  /** Debounce a transcript flush so a burst of events writes disk only once. */
  private scheduleTranscriptWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      void this.flushTranscript();
    }, TRANSCRIPT_DEBOUNCE_MS);
  }

  /** Write the in-memory transcript to disk; best-effort, never throws. */
  private async flushTranscript(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.transcriptFile, JSON.stringify(this.transcript));
    } catch {
      // A failed transcript write must not break the live chat.
    }
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

    try {
      await mkdir(this.dir, { recursive: true });
    } catch {
      // Fall back to the base dir; a missing scratch dir is not fatal.
    }

    this.client = getKubeClient(this.clusterId);
    this.claudeCodePath = claudeCodePath;

    // Resume the stored Claude Code session on the first turn after a restart.
    const resumeId = this.store.read(this.clusterId)?.sessionId;
    this.startQuery(resumeId);
    if (resumeId) {
      this.resumed = true;
      this.emit(sessionEvent("session_meta", { permissionMode: this.broker.getMode(), resumed: true }));
    }

    void this.consume();
  }

  /** Build (or rebuild) the SDK query; `resume` continues a stored session. */
  private startQuery(resume?: string): void {
    const client = this.client;
    if (!client || !this.claudeCodePath) return;
    this.queryHandle = query({
      prompt: this.input,
      options: {
        abortController: this.abort,
        pathToClaudeCodeExecutable: this.claudeCodePath,
        cwd: this.dir,
        mcpServers: { [MCP_SERVER_NAME]: createKubeMcpServer(client) },
        allowedTools: ALLOWED_TOOL_NAMES,
        disallowedTools: DISALLOWED_BUILTIN_TOOLS,
        settingSources: [],
        includePartialMessages: true,
        canUseTool: (toolName, input, extra) => this.canUseTool(toolName, input, extra),
        ...(resume ? { resume } : {}),
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append:
            `You are operating on the Kubernetes cluster "${client.clusterName}" through kube_ tools. ` +
            "Read-only tools (list/get resources, pod logs, warning events, cluster version) run freely. " +
            "Mutating tools (create, update, patch/scale, delete, delete pod, rollout restart) exist, but every " +
            "mutation requires explicit user approval, and all mutations are denied while the chat is in read-only " +
            "mode. Prefer reads to discover current state before proposing any mutation, and never retry a denied " +
            "action unless the user asks you to.",
        },
      },
    });
  }

  /** SDK approval callback. Read-only tools are pre-allowed; only mutating tools reach the broker. */
  private async canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    extra: { signal?: AbortSignal },
  ): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }> {
    if (!isKnownToolName(toolName)) {
      return { behavior: "deny", message: `Tool "${toolName}" is not permitted in this cluster chat.` };
    }
    // Read-only tools are in allowedTools and normally never reach here; allow, echoing input.
    if (!isMutatingToolName(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }

    const decision = await this.broker.decideMutating(unqualifyToolName(toolName), input, extra.signal);
    return decision.behavior === "allow"
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: decision.message ?? "The user denied the action." };
  }

  /** Best-effort read of the target resource for the approval backup; never throws. */
  private async captureBackup(target: ApprovalTarget): Promise<string | undefined> {
    if (!this.client) return undefined;
    try {
      const current = await this.client.objects.read({
        apiVersion: target.apiVersion,
        kind: target.kind,
        metadata: { name: target.name, namespace: target.namespace },
      });
      return toYaml(stripManagedFields(current));
    } catch {
      return undefined;
    }
  }

  private async consume(): Promise<void> {
    if (!this.queryHandle) return;
    try {
      for await (const message of this.queryHandle) {
        this.handleMessage(message);
      }
    } catch (error) {
      if (this.abort.signal.aborted) {
        // Shutting down; the error is expected and swallowed.
      } else if (this.resumed && !this.resumeRetried) {
        // The stored session is gone: drop it and restart fresh, transparently.
        this.resumeRetried = true;
        this.resumed = false;
        this.sessionId = undefined;
        this.store.writeSessionId(this.clusterId, undefined);
        this.emit(sessionEvent("session_meta", { permissionMode: this.broker.getMode(), resumed: false }));
        this.startQuery(undefined);
        await this.consume();
        return;
      } else {
        this.emit(
          sessionEvent("error", {
            message: error instanceof Error ? error.message : String(error),
            kind: "other",
          }),
        );
      }
    } finally {
      this.broker.denyAllPending("the session ended");
      this.setWorking(false);
    }
  }

  /** Persist the Claude Code session id reported by the SDK for later resume. */
  private captureSessionId(sessionId: string): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.store.writeSessionId(this.clusterId, sessionId);
  }

  private handleMessage(message: SDKMessage): void {
    switch (message.type) {
      case "system": {
        const system = message as { subtype?: string; session_id?: string };
        if (system.subtype === "init" && system.session_id) {
          this.captureSessionId(system.session_id);
        }
        break;
      }
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
    this.broker.denyAllPending("the turn was interrupted");
    try {
      await this.queryHandle?.interrupt();
    } catch {
      // Interrupt is best-effort; ignore if the query is not streaming.
    }
    this.setWorking(false);
  }

  /**
   * Tear the session down. `persistTranscript` keeps the transcript on disk
   * (graceful shutdown / deactivate); when `false` the transcript file is
   * removed instead (a new chat starts clean).
   */
  async dispose(persistTranscript: boolean): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    if (persistTranscript) {
      await this.flushTranscript();
    } else {
      try {
        await rm(this.transcriptFile, { force: true });
      } catch {
        // Best-effort; a leftover transcript is harmless.
      }
    }
    this.broker.denyAllPending("the session was disposed");
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
    private readonly store: ChatSessionState,
  ) {}

  private getOrCreate(clusterId: string): ClusterSession {
    let session = this.sessions.get(clusterId);
    if (!session) {
      session = new ClusterSession(clusterId, this.resolveClaudeCodePath, this.baseDir, this.store);
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

  /** Set the per-cluster permission mode, creating the session state if needed. */
  setPermissionMode(clusterId: string, mode: PermissionMode): void {
    this.getOrCreate(clusterId).setPermissionMode(mode);
  }

  /** Resolve a pending approval identified only by its request id. */
  resolvePermission(requestId: string, behavior: PermissionBehavior): ResolveResult {
    let sawResolved = false;
    for (const session of this.sessions.values()) {
      const result = session.resolvePermission(requestId, behavior);
      if (result === "ok") return "ok";
      if (result === "already_resolved") sawResolved = true;
    }
    return sawResolved ? "already_resolved" : "not_found";
  }

  /**
   * Start a fresh chat for a cluster: clear the stored session id, drop the live
   * session, and delete its transcript. The persisted permission mode is kept.
   */
  async dispose(clusterId: string): Promise<void> {
    this.store.writeSessionId(clusterId, undefined);
    const session = this.sessions.get(clusterId);
    if (session) {
      this.sessions.delete(clusterId);
      await session.dispose(false);
      return;
    }
    // No live session, but a transcript may still be on disk from a past run.
    try {
      await rm(transcriptPath(this.baseDir, clusterId), { force: true });
    } catch {
      // Best-effort.
    }
  }

  /** Tear all sessions down on deactivate, preserving transcripts for resume. */
  async disposeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((session) => session.dispose(true)));
  }
}
