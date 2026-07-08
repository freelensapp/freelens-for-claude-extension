/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Shared request/response and SSE event types for the local HTTP bridge
// between the main process (Claude Agent SDK) and the renderer chat UI.
//
// This module must have no runtime dependencies: it is imported by both
// processes and only declares types plus a couple of tiny pure helpers for
// encoding/decoding SSE frames.

/** Result of Claude Code detection, reported by `GET /status`. */
export interface StatusResponse {
  /** Whether the bridge server itself finished starting. */
  ready: boolean;
  claudeCode: {
    found: boolean;
    path?: string;
    version?: string;
    error?: string;
  };
}

/** Body of `POST /clusters/:id/messages`. */
export interface SendMessageRequest {
  text: string;
}

/** Body of `POST /permissions/:requestId`. */
export interface ResolvePermissionRequest {
  behavior: PermissionBehavior;
}

/** Body of `POST /clusters/:id/permission-mode`. */
export interface SetPermissionModeRequest {
  mode: PermissionMode;
}

/** Body of `POST /clusters/:id/model`. `null` restores the Claude Code default. */
export interface SetModelRequest {
  model: string | null;
}

/**
 * The model aliases offered by the picker and accepted by `POST .../model`.
 * A `null`/absent selection means "Claude Code default".
 */
export const MODEL_CHOICES = ["sonnet", "opus", "haiku"] as const;

/** Whether a value is one of the known model aliases. */
export function isModelChoice(value: unknown): value is (typeof MODEL_CHOICES)[number] {
  return typeof value === "string" && (MODEL_CHOICES as readonly string[]).includes(value);
}

/** The classification attached to an `error` event. */
export type SessionErrorKind = "not_found" | "auth" | "other";

/** Session lifecycle state reflected in the status strip. */
export type SessionState = "idle" | "working";

/**
 * Per-cluster approval policy for mutating tools.
 * - `readOnly`: mutating tools are always denied.
 * - `approve`: every mutation pauses on a user approval dialog (default).
 * - `acceptAll`: mutations are auto-approved (never persisted).
 */
export type PermissionMode = "readOnly" | "approve" | "acceptAll";

/** How a permission request was resolved. */
export type PermissionBehavior = "allow" | "deny";

/**
 * SSE event payloads, keyed by event type. Each entry is serialized as one
 * `data:` line with a matching `event:` type on the wire.
 */
export interface SessionEventMap {
  status: { state: SessionState };
  user_message: { text: string };
  assistant_delta: { text: string };
  assistant_message: { text: string };
  /** `callId` is the SDK `tool_use` block id, absent for replayed M1 transcripts. */
  tool_call: { toolName: string; input: unknown; callId?: string };
  /** `callId` is the block's `tool_use_id`, absent for replayed M1 transcripts. */
  tool_result: { toolName: string; summary: string; callId?: string };
  turn_complete: Record<string, never>;
  /** Per-turn token usage from the SDK `result` message. */
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  /** Native Claude Code conversation compaction. */
  compaction: { trigger: "manual" | "auto"; preTokens: number };
  /** `canRetry` marks errors a Retry button can re-run (a user turn exists). */
  error: { message: string; kind: SessionErrorKind; canRetry?: boolean };
  /** A mutating tool is awaiting user approval. */
  permission_request: {
    requestId: string;
    toolName: string;
    /** Short human header, e.g. `UPDATE SERVICE` or `DELETE POD (evict)`. */
    actionTitle: string;
    /** The tool input, echoed for the dialog. */
    input: unknown;
    /** The tool input rendered as YAML. */
    proposedYaml: string;
    /** Pre-change YAML of the target resource (managedFields stripped), best-effort. */
    currentYaml?: string;
    /** Unified diff from `currentYaml` to the proposed manifest (updates only). */
    diff?: string;
  };
  /** A pending permission request was resolved (by the user or automatically). */
  permission_resolved: { requestId: string; behavior: PermissionBehavior; reason?: string };
  /** Session metadata pushed to a new subscriber before the transcript replay. */
  session_meta: {
    permissionMode: PermissionMode;
    resumed: boolean;
    /** Selected model alias; absent means the Claude Code default. */
    model?: string;
    /** The model id the SDK `init` message resolved to (for the Default label). */
    resolvedModel?: string;
  };
}

export type SessionEventType = keyof SessionEventMap;

/** A discriminated union over all SSE event types. */
export type SessionEvent = {
  [K in SessionEventType]: { type: K; data: SessionEventMap[K] };
}[SessionEventType];

/** Build a strongly-typed session event. */
export function sessionEvent<K extends SessionEventType>(type: K, data: SessionEventMap[K]): SessionEvent {
  return { type, data } as SessionEvent;
}

/**
 * Encode a session event as an SSE frame (`event:` + `data:` + blank line).
 * The data payload is JSON on a single line so the decoder can parse it back.
 */
export function encodeSseEvent(event: SessionEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/** An SSE heartbeat comment used to keep proxies and the socket alive. */
export const SSE_HEARTBEAT = ": heartbeat\n\n";

/**
 * Decode a single SSE frame (the text between blank-line separators) into a
 * `SessionEvent`. Returns `null` for comment-only frames (heartbeats) or
 * frames without a recognizable `event:`/`data:` pair.
 */
export function decodeSseFrame(frame: string): SessionEvent | null {
  let type: string | undefined;
  const dataLines: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0 || line.startsWith(":")) continue;
    const sep = line.indexOf(":");
    const field = sep === -1 ? line : line.slice(0, sep);
    // Per the SSE spec a single leading space after the colon is stripped.
    const value = sep === -1 ? "" : line.slice(sep + 1).replace(/^ /, "");
    if (field === "event") {
      type = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }
  if (type == null || dataLines.length === 0) return null;
  try {
    const data = JSON.parse(dataLines.join("\n"));
    return { type, data } as SessionEvent;
  } catch {
    return null;
  }
}
