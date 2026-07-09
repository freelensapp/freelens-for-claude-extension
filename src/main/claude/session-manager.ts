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
  type ClusterToolsResponse,
  type PermissionBehavior,
  type PermissionMode,
  type SessionErrorKind,
  type SessionEvent,
  sessionEvent,
} from "../../common/protocol";
import { ProcessRegistry } from "../tools/cli-exec";
import { disposeKubeClient, getKubeClient, type KubeClient } from "../tools/kube-client";
import { stripManagedFields, toYaml } from "../tools/kube-format";
import {
  ALLOWED_TOOL_NAMES,
  BUILTIN_TOOL_DESCRIPTORS,
  createKubeMcpServer,
  isKnownToolName,
  isMutatingToolName,
  MCP_SERVER_NAME,
  unqualifyToolName,
} from "../tools/mcp-server";
import { parseUserMcpConfig } from "./mcp-config";
import { PermissionBroker, type ResolveResult } from "./permission-broker";
import { buildAgents } from "./subagents";

import type { McpServerConfig, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { PreferencesState } from "../../common/preferences-store";
import type { ChatSessionState } from "../../common/session-store";
import type { ApprovalTarget } from "../tools/approval";

/** The read tool that may be gated behind an approval preference. */
const POD_LOGS_TOOL = "freelens_pod_logs";

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
  "usage",
  "compaction",
  "error",
  "permission_request",
  "permission_resolved",
  "local_command_output",
]);

/** Read-only tools that the SDK may run without hitting `canUseTool`; pod logs are gated separately. */
const AUTO_ALLOWED_TOOL_NAMES = ALLOWED_TOOL_NAMES.filter((name) => unqualifyToolName(name) !== POD_LOGS_TOOL);

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

/** The token counters carried on the SDK `result` message. */
interface UsageTotals {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
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
  /** In-flight kubectl/helm children, killed on interrupt, new chat, and dispose. */
  private readonly cliRegistry = new ProcessRegistry();
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
  /** The selected model alias; `undefined` means the Claude Code default. */
  private selectedModel?: string;
  /** The model id the SDK `init` message reported (for the Default label). */
  private resolvedModel?: string;
  /** External MCP servers (never the built-in one) reported by the SDK `init` message. */
  private externalMcpServers?: { name: string; status: string }[];
  /** Slash commands offered by Claude Code, reported by the SDK `init` message. */
  private slashCommands?: string[];
  /** The last user prompt, kept so a failed turn can be retried without re-adding the bubble. */
  private lastUserText?: string;

  constructor(
    private readonly clusterId: string,
    private readonly resolveClaudeCodePath: () => string | undefined,
    baseDir: string,
    private readonly store: ChatSessionState,
    private readonly preferences: PreferencesState,
  ) {
    this.dir = clusterDir(baseDir, clusterId);
    this.transcriptFile = transcriptPath(baseDir, clusterId);
    this.broker = new PermissionBroker(
      (event) => this.emit(event),
      (target) => this.captureBackup(target),
      () => randomUUID(),
      () => this.resumed,
      () => ({ model: this.selectedModel, resolvedModel: this.resolvedModel }),
    );
    // Restore the persisted permission mode (mutating setMode directly, without
    // re-persisting) and the transcript so a reconnecting page replays history.
    const persisted = this.store.read(clusterId);
    if (persisted?.permissionMode) this.broker.setMode(persisted.permissionMode);
    // Initialize the model from the stored per-cluster choice, or the default
    // preference when the cluster has never picked one.
    this.selectedModel = persisted?.model ?? (this.preferences.defaultModel.trim() || undefined);
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
    listener(this.sessionMetaEvent());
    for (const event of this.transcript) listener(event);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  /** Build a `session_meta` event carrying the current mode, resume flag, and model. */
  private sessionMetaEvent(): SessionEvent {
    return sessionEvent("session_meta", {
      permissionMode: this.broker.getMode(),
      resumed: this.resumed,
      model: this.selectedModel,
      resolvedModel: this.resolvedModel,
      ...(this.slashCommands ? { slashCommands: this.slashCommands } : {}),
      ...(this.externalMcpServers ? { mcpServers: this.externalMcpServers } : {}),
    });
  }

  getPermissionMode(): PermissionMode {
    return this.broker.getMode();
  }

  /**
   * Live external MCP servers (never the built-in one) with their status and
   * discovered tools, for the Available Tools panel. Returns `[]` when no query
   * is live or the SDK cannot report status.
   */
  async getMcpServers(): Promise<ClusterToolsResponse["mcp"]> {
    if (!this.queryHandle) return [];
    try {
      const statuses = await this.queryHandle.mcpServerStatus();
      return statuses
        .filter((server) => server.name !== MCP_SERVER_NAME)
        .map((server) => ({
          name: server.name,
          status: server.status,
          tools: (server.tools ?? []).map((entry) => ({
            name: entry.name,
            ...(entry.description ? { description: entry.description } : {}),
          })),
        }));
    } catch {
      return [];
    }
  }

  setPermissionMode(mode: PermissionMode): void {
    this.broker.setMode(mode);
    // `acceptAll` is intentionally not persisted (the store ignores it).
    this.store.writePermissionMode(this.clusterId, mode);
  }

  /**
   * Switch the model used for subsequent turns. Persists the choice, updates a
   * live query best-effort (never restarting the conversation), and echoes the
   * new selection through `session_meta`.
   */
  setModel(model: string | undefined): void {
    this.selectedModel = model;
    this.store.writeModel(this.clusterId, model);
    if (this.queryHandle) {
      try {
        void this.queryHandle.setModel(model);
      } catch (error) {
        this.emit(
          sessionEvent("error", {
            message: `Could not switch the model on the live session: ${error instanceof Error ? error.message : String(error)}`,
            kind: "other",
          }),
        );
      }
    }
    this.emit(this.sessionMetaEvent());
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
    this.lastUserText = text;
    this.emit(sessionEvent("user_message", { text }));
    await this.pushUserTurn(text);
  }

  /**
   * Re-run the last user turn after a failure. Refuses (so the bridge answers
   * 409) when a turn is in flight or there is nothing to retry. Deliberately
   * does not re-emit a `user_message`: the original prompt is already in the
   * transcript.
   */
  async retry(): Promise<"accepted" | "nothing_to_retry"> {
    if (this.working || this.lastUserText == null) return "nothing_to_retry";
    await this.pushUserTurn(this.lastUserText);
    return "accepted";
  }

  /** Ensure a live query exists and enqueue one user turn; emits no user_message. */
  private async pushUserTurn(text: string): Promise<void> {
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
      this.emit(this.sessionMetaEvent());
    }

    void this.consume();
  }

  /** Build (or rebuild) the SDK query; `resume` continues a stored session. */
  private startQuery(resume?: string): void {
    const client = this.client;
    if (!client || !this.claudeCodePath) return;
    // With the subagent enabled, delegation itself is safe (every tool the
    // subagent calls is still individually gated), so `Task`/`Agent` are let
    // through; with it off both stay disallowed exactly as before.
    const subagentsEnabled = this.preferences.subagentsEnabled;
    const disallowedTools = subagentsEnabled
      ? DISALLOWED_BUILTIN_TOOLS.filter((name) => name !== "Task")
      : DISALLOWED_BUILTIN_TOOLS;
    const allowedTools = subagentsEnabled ? [...AUTO_ALLOWED_TOOL_NAMES, "Agent"] : AUTO_ALLOWED_TOOL_NAMES;
    this.queryHandle = query({
      prompt: this.input,
      options: {
        abortController: this.abort,
        pathToClaudeCodeExecutable: this.claudeCodePath,
        cwd: this.dir,
        mcpServers: this.buildMcpServers(client),
        // Only the `mcpServers` option counts; ignore any MCP config from
        // settings files, plugins, or agent frontmatter.
        strictMcpConfig: true,
        // Pod logs are omitted so `canUseTool` fires for them and the approval
        // preference can be enforced live.
        allowedTools,
        disallowedTools,
        ...(subagentsEnabled ? { agents: buildAgents() } : {}),
        settingSources: [],
        includePartialMessages: true,
        canUseTool: (toolName, input, extra) => this.canUseTool(toolName, input, extra),
        ...(resume ? { resume } : {}),
        ...(this.selectedModel ? { model: this.selectedModel } : {}),
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: this.buildSystemPromptAppend(client.clusterName),
        },
      },
    });
  }

  /**
   * The MCP servers for this session: always the built-in `freelens-kube`
   * server, plus any user-configured servers when the preference is enabled.
   * Parse errors are reported once as a non-fatal error event; a bad entry is
   * simply skipped. Config changes apply from the next session start.
   */
  private buildMcpServers(client: KubeClient): Record<string, McpServerConfig> {
    const servers: Record<string, McpServerConfig> = {
      [MCP_SERVER_NAME]: createKubeMcpServer(client, () => this.preferences.podLogsTailLines, this.cliRegistry),
    };
    if (!this.preferences.mcpEnabled) return servers;

    const { servers: userServers, errors } = parseUserMcpConfig(this.preferences.mcpConfiguration);
    for (const [name, config] of Object.entries(userServers)) {
      servers[name] = config;
    }
    if (errors.length > 0) {
      this.emit(
        sessionEvent("error", {
          message: `MCP configuration ignored: ${errors.join("; ")}`,
          kind: "other",
        }),
      );
    }
    return servers;
  }

  /** Base guidance plus any user-configured custom rules appended for this session. */
  private buildSystemPromptAppend(clusterName: string): string {
    const base =
      `You are operating on the Kubernetes cluster "${clusterName}" through freelens_ tools. ` +
      "Read-only tools (list/get resources, pod logs, warning events, cluster version) run freely. " +
      "Mutating tools (create, update, patch/scale, delete, delete pod, rollout restart) exist, but every " +
      "mutation requires explicit user approval, and all mutations are denied while the chat is in read-only " +
      "mode. Prefer reads to discover current state before proposing any mutation, and never retry a denied " +
      "action unless the user asks you to. The freelens_kubectl and freelens_helm escape-hatch tools can run " +
      "kubectl or helm directly for anything the dedicated tools do not cover, but always prefer the dedicated " +
      "freelens_ tools; they are the fallback and need the same approval as any mutation.";
    const rules = this.preferences.customAgentRules.trim();
    return rules ? `${base}\n\nAdditional user rules:\n${rules}` : base;
  }

  /** SDK approval callback. Read-only tools are pre-allowed; only mutating tools reach the broker. */
  private async canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    extra: { signal?: AbortSignal },
  ): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }> {
    if (!isKnownToolName(toolName)) {
      // External MCP tools (from a user-configured server) cannot be classified,
      // so they are treated as mutating: denied in read-only, approved per call.
      if (toolName.startsWith("mcp__")) {
        const decision = await this.broker.decideMutating(toolName, input, extra.signal);
        return decision.behavior === "allow"
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: decision.message ?? "The user denied the action." };
      }
      return { behavior: "deny", message: `Tool "${toolName}" is not permitted in this cluster chat.` };
    }
    const shortName = unqualifyToolName(toolName);

    // Pod logs are a read, but may be gated behind an approval preference.
    if (shortName === POD_LOGS_TOOL) {
      if (!this.preferences.podLogsRequireApproval) {
        return { behavior: "allow", updatedInput: input };
      }
      const decision = await this.broker.decideReadWithConsent(shortName, input, extra.signal);
      return decision.behavior === "allow"
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: decision.message ?? "The user denied the action." };
    }

    // Other read-only tools are in allowedTools and normally never reach here; allow, echoing input.
    if (!isMutatingToolName(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }

    const decision = await this.broker.decideMutating(shortName, input, extra.signal);
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
        this.emit(this.sessionMetaEvent());
        this.startQuery(undefined);
        await this.consume();
        return;
      } else {
        this.emit(
          sessionEvent("error", {
            message: error instanceof Error ? error.message : String(error),
            kind: "other",
            canRetry: this.lastUserText != null,
          }),
        );
      }
    } finally {
      this.broker.denyAllPending("the session ended");
      this.setWorking(false);
    }
  }

  /** Emit a per-turn `usage` event from the SDK `result` message; missing usage emits nothing. */
  private emitUsage(usage: UsageTotals | undefined): void {
    if (!usage) return;
    this.emit(
      sessionEvent("usage", {
        inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        cachedInputTokens: usage.cache_read_input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
      }),
    );
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
        const system = message as {
          subtype?: string;
          session_id?: string;
          model?: string;
          mcp_servers?: { name?: string; status?: string }[];
          slash_commands?: string[];
          content?: string;
          compact_metadata?: { trigger?: "manual" | "auto"; pre_tokens?: number };
        };
        if (system.subtype === "init") {
          if (system.session_id) this.captureSessionId(system.session_id);
          let metaChanged = false;
          if (system.model && system.model !== this.resolvedModel) {
            this.resolvedModel = system.model;
            metaChanged = true;
          }
          // Capture the native slash commands so the input autocomplete can list them.
          if (Array.isArray(system.slash_commands) && system.slash_commands.length > 0) {
            this.slashCommands = system.slash_commands.map(String);
            metaChanged = true;
          }
          // Keep only external servers (never the built-in one) for the panel and
          // flag any that failed to connect.
          const external = (Array.isArray(system.mcp_servers) ? system.mcp_servers : [])
            .filter((server) => server.name && server.name !== MCP_SERVER_NAME)
            .map((server) => ({ name: String(server.name), status: String(server.status ?? "unknown") }));
          this.externalMcpServers = external;
          if (external.length > 0) metaChanged = true;
          if (metaChanged) this.emit(this.sessionMetaEvent());
          for (const server of external) {
            if (server.status !== "connected") {
              this.emit(
                sessionEvent("error", {
                  message: `MCP server "${server.name}" is ${server.status}.`,
                  kind: "other",
                }),
              );
            }
          }
        } else if (system.subtype === "local_command_output") {
          // Printable output of a native slash command (e.g. `/compact`).
          this.emit(sessionEvent("local_command_output", { content: String(system.content ?? "") }));
        } else if (system.subtype === "compact_boundary") {
          this.emit(
            sessionEvent("compaction", {
              trigger: system.compact_metadata?.trigger ?? "auto",
              preTokens: system.compact_metadata?.pre_tokens ?? 0,
            }),
          );
        }
        break;
      }
      case "conversation_reset": {
        // Fallback for `/clear` typed in a way the renderer did not intercept; the
        // renderer's own New chat action resets the transcript and session id.
        this.emit(sessionEvent("local_command_output", { content: "Conversation cleared by /clear" }));
        break;
      }
      case "stream_event": {
        const event = message.event as {
          type?: string;
          delta?: { type?: string; text?: string; thinking?: string };
        };
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          this.emit(sessionEvent("assistant_delta", { text: event.delta.text }));
        } else if (
          event.type === "content_block_delta" &&
          event.delta?.type === "thinking_delta" &&
          event.delta.thinking
        ) {
          // Live-only reasoning; deliberately not persisted, so it is absent on replay.
          this.emit(sessionEvent("assistant_thinking", { delta: event.delta.thinking }));
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
        // A non-null parent means this is subagent activity; its tool calls are
        // rendered indented under the `Agent` delegation card, and its prose is
        // deliberately not forwarded (the SDK default).
        const parentCallId = message.parent_tool_use_id ?? undefined;
        const blocks = (message.message?.content ?? []) as ContentBlock[];
        for (const block of blocks) {
          if (block.type === "text" && block.text) {
            if (parentCallId) continue;
            this.emit(sessionEvent("assistant_message", { text: block.text }));
          } else if (block.type === "tool_use") {
            if (block.id && block.name) this.toolNames.set(block.id, block.name);
            this.emit(
              sessionEvent("tool_call", {
                toolName: unqualifyToolName(block.name ?? "tool"),
                input: block.input,
                callId: block.id,
                ...(parentCallId ? { parentCallId } : {}),
              }),
            );
          }
        }
        break;
      }
      case "user": {
        const parentCallId = message.parent_tool_use_id ?? undefined;
        const blocks = (message.message?.content ?? []) as ContentBlock[];
        if (!Array.isArray(blocks)) break;
        for (const block of blocks) {
          if (block.type === "tool_result") {
            const toolName = (block.tool_use_id && this.toolNames.get(block.tool_use_id)) || "tool";
            this.emit(
              sessionEvent("tool_result", {
                toolName: unqualifyToolName(toolName),
                summary: summarizeToolResult(block.content).slice(0, 2000),
                callId: block.tool_use_id,
                ...(parentCallId ? { parentCallId } : {}),
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
              canRetry: this.lastUserText != null,
            }),
          );
        }
        this.emitUsage((message as { usage?: UsageTotals }).usage);
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
    this.cliRegistry.killAll();
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
    this.cliRegistry.killAll();
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
    private readonly preferences: PreferencesState,
  ) {}

  private getOrCreate(clusterId: string): ClusterSession {
    let session = this.sessions.get(clusterId);
    if (!session) {
      session = new ClusterSession(clusterId, this.resolveClaudeCodePath, this.baseDir, this.store, this.preferences);
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

  /** Set the per-cluster model, creating the session state if needed. */
  setModel(clusterId: string, model: string | undefined): void {
    this.getOrCreate(clusterId).setModel(model);
  }

  /** Re-run the last user turn after a failure; reports whether it was accepted. */
  async retry(clusterId: string): Promise<"accepted" | "nothing_to_retry"> {
    return this.getOrCreate(clusterId).retry();
  }

  /**
   * Available Tools panel data: the static built-in descriptors plus, when a
   * query is live for the cluster, the external MCP servers and their tools.
   */
  async getClusterTools(clusterId: string): Promise<ClusterToolsResponse> {
    const builtin = BUILTIN_TOOL_DESCRIPTORS.map((descriptor) => ({ ...descriptor }));
    const session = this.sessions.get(clusterId);
    const mcp = session ? await session.getMcpServers() : [];
    return { builtin, mcp };
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
