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

/** The classification attached to an `error` event. */
export type SessionErrorKind = "not_found" | "auth" | "other";

/** Session lifecycle state reflected in the status strip. */
export type SessionState = "idle" | "working";

/**
 * SSE event payloads, keyed by event type. Each entry is serialized as one
 * `data:` line with a matching `event:` type on the wire.
 */
export interface SessionEventMap {
  status: { state: SessionState };
  user_message: { text: string };
  assistant_delta: { text: string };
  assistant_message: { text: string };
  tool_call: { toolName: string; input: unknown };
  tool_result: { toolName: string; summary: string };
  turn_complete: Record<string, never>;
  error: { message: string; kind: SessionErrorKind };
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
