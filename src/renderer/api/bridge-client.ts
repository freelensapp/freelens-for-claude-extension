/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { BridgeStore } from "../../common/bridge-store";
import {
  decodeSseFrame,
  type PermissionBehavior,
  type PermissionMode,
  type SessionEvent,
  type StatusResponse,
} from "../../common/protocol";

/** Handlers for a live SSE subscription. */
export interface StreamHandlers {
  onEvent: (event: SessionEvent) => void;
  onError?: (error: unknown) => void;
  onOpen?: () => void;
}

/**
 * Thin fetch wrapper around the main-process HTTP bridge. Reads the ephemeral
 * port and bearer token from the synced {@link BridgeStore}. SSE uses a
 * `fetch()` + `ReadableStream` reader (not `EventSource`, which cannot send the
 * `Authorization` header).
 */
export class BridgeClient {
  private get store(): BridgeStore {
    return BridgeStore.getInstanceOrCreate<BridgeStore>();
  }

  private get baseUrl(): string {
    return `http://127.0.0.1:${this.store.port}`;
  }

  private get authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.store.token}` };
  }

  get isReady(): boolean {
    return this.store.port > 0 && this.store.token.length > 0;
  }

  async getStatus(refresh = false): Promise<StatusResponse> {
    const response = await fetch(`${this.baseUrl}/status${refresh ? "?refresh=1" : ""}`, {
      headers: this.authHeader,
    });
    if (!response.ok) throw new Error(`status request failed: ${response.status}`);
    return (await response.json()) as StatusResponse;
  }

  async sendMessage(clusterId: string, text: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/clusters/${encodeURIComponent(clusterId)}/messages`, {
      method: "POST",
      headers: { ...this.authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) throw new Error(`send failed: ${response.status}`);
  }

  async interrupt(clusterId: string): Promise<void> {
    await fetch(`${this.baseUrl}/clusters/${encodeURIComponent(clusterId)}/interrupt`, {
      method: "POST",
      headers: this.authHeader,
    });
  }

  async disposeSession(clusterId: string): Promise<void> {
    await fetch(`${this.baseUrl}/clusters/${encodeURIComponent(clusterId)}/session`, {
      method: "DELETE",
      headers: this.authHeader,
    });
  }

  /** Approve or deny a pending mutating-tool request. */
  async resolvePermission(requestId: string, behavior: PermissionBehavior): Promise<void> {
    const response = await fetch(`${this.baseUrl}/permissions/${encodeURIComponent(requestId)}`, {
      method: "POST",
      headers: { ...this.authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ behavior }),
    });
    if (!response.ok) throw new Error(`resolve permission failed: ${response.status}`);
  }

  /** Switch the per-cluster permission mode. */
  async setPermissionMode(clusterId: string, mode: PermissionMode): Promise<void> {
    const response = await fetch(`${this.baseUrl}/clusters/${encodeURIComponent(clusterId)}/permission-mode`, {
      method: "POST",
      headers: { ...this.authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    if (!response.ok) throw new Error(`set permission mode failed: ${response.status}`);
  }

  /**
   * Open an SSE stream for a cluster's session events. Returns a function that
   * closes the stream. Reconnects with capped exponential backoff when the
   * stream drops, until closed by the caller.
   */
  streamEvents(clusterId: string, handlers: StreamHandlers): () => void {
    const controller = new AbortController();
    let closed = false;
    let backoff = 500;

    const run = async () => {
      while (!closed) {
        try {
          const response = await fetch(`${this.baseUrl}/clusters/${encodeURIComponent(clusterId)}/events`, {
            headers: this.authHeader,
            signal: controller.signal,
          });
          if (!response.ok || !response.body) throw new Error(`events request failed: ${response.status}`);

          handlers.onOpen?.();
          backoff = 500;

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (!closed) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let separator = buffer.indexOf("\n\n");
            while (separator !== -1) {
              const frame = buffer.slice(0, separator);
              buffer = buffer.slice(separator + 2);
              const event = decodeSseFrame(frame);
              if (event) handlers.onEvent(event);
              separator = buffer.indexOf("\n\n");
            }
          }
        } catch (error) {
          if (closed || controller.signal.aborted) return;
          handlers.onError?.(error);
        }

        if (closed) return;
        await new Promise((resolve) => setTimeout(resolve, backoff));
        backoff = Math.min(backoff * 2, 10_000);
      }
    };

    void run();

    return () => {
      closed = true;
      controller.abort();
    };
  }
}

let sharedClient: BridgeClient | undefined;

/** A process-wide shared bridge client. */
export function bridgeClient(): BridgeClient {
  if (!sharedClient) sharedClient = new BridgeClient();
  return sharedClient;
}
