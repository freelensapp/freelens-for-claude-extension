/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { type BridgeConnection, BridgeStore } from "../../common/bridge-store";
import {
  type ClusterContextResponse,
  type ClusterModelsResponse,
  type ClusterUsageResponse,
  decodeSseFrame,
  type EffortLevel,
  type PermissionBehavior,
  type PermissionMode,
  type SessionEvent,
  type StatusResponse,
} from "../../common/protocol";
import { BridgeIpc } from "./bridge-ipc";

/** Handlers for a live SSE subscription. */
export interface StreamHandlers {
  onEvent: (event: SessionEvent) => void;
  onError?: (error: unknown) => void;
  onOpen?: () => void;
}

/** Asks main for the bridge's port and token; `null` when main refuses this frame. */
export type RequestConnection = () => Promise<BridgeConnection | null>;

const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * Thin fetch wrapper around the main-process HTTP bridge. Watches the port in
 * the synced {@link BridgeStore} and asks main over IPC for the port and the
 * bearer token of that bridge, once per port, keeping them in this object
 * only. SSE uses a `fetch()` + `ReadableStream` reader (not `EventSource`,
 * which cannot send the `Authorization` header).
 */
export class BridgeClient {
  private connection?: Promise<BridgeConnection>;
  private connectionPort = 0;

  constructor(
    private readonly requestConnection: RequestConnection = async () => BridgeIpc.getInstance().requestConnection(),
  ) {}

  private get store(): BridgeStore {
    return BridgeStore.getInstanceOrCreate<BridgeStore>();
  }

  /** Whether main has announced a listening bridge. */
  get isReady(): boolean {
    return this.store.port > 0;
  }

  /**
   * The connection to the bridge the store names. Asked for again when the
   * port changes, after a failed request for it, and after a 401.
   */
  private connect(): Promise<BridgeConnection> {
    const port = this.store.port;
    if (!this.connection || this.connectionPort !== port) {
      this.connectionPort = port;
      const pending = this.requestConnection().then((connection) => {
        if (!connection?.token) throw new Error("the bridge refused this frame");
        return connection;
      });
      pending.catch(() => this.forget(pending));
      this.connection = pending;
    }
    return this.connection;
  }

  private forget(connection: Promise<BridgeConnection>): void {
    if (this.connection === connection) this.connection = undefined;
  }

  /** `fetch` a bridge path with the bearer token. */
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const connection = this.connect();
    const { port, token } = await connection;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
    });
    if (response.status === 401) this.forget(connection);
    return response;
  }

  async getStatus(refresh = false): Promise<StatusResponse> {
    const response = await this.request(`/status${refresh ? "?refresh=1" : ""}`);
    if (!response.ok) throw new Error(`status request failed: ${response.status}`);
    return (await response.json()) as StatusResponse;
  }

  async sendMessage(clusterId: string, text: string): Promise<void> {
    const response = await this.request(`/clusters/${encodeURIComponent(clusterId)}/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ text }),
    });
    if (!response.ok) throw new Error(`send failed: ${response.status}`);
  }

  /** Fetch the `/usage` data: account, plan rate-limit windows, contributing breakdown. */
  async getUsage(clusterId: string): Promise<ClusterUsageResponse> {
    const response = await this.request(`/clusters/${encodeURIComponent(clusterId)}/usage`);
    if (!response.ok) throw new Error(`usage request failed: ${response.status}`);
    return (await response.json()) as ClusterUsageResponse;
  }

  /** Fetch the `/context` breakdown: current context-window occupancy by category. */
  async getContext(clusterId: string): Promise<ClusterContextResponse> {
    const response = await this.request(`/clusters/${encodeURIComponent(clusterId)}/context`);
    if (!response.ok) throw new Error(`context request failed: ${response.status}`);
    return (await response.json()) as ClusterContextResponse;
  }

  /** Fetch the live model picker catalog from the installed Claude Code build. */
  async getModels(clusterId: string): Promise<ClusterModelsResponse> {
    const response = await this.request(`/clusters/${encodeURIComponent(clusterId)}/models`);
    if (!response.ok) throw new Error(`models request failed: ${response.status}`);
    return (await response.json()) as ClusterModelsResponse;
  }

  async interrupt(clusterId: string): Promise<void> {
    await this.request(`/clusters/${encodeURIComponent(clusterId)}/interrupt`, { method: "POST" });
  }

  async disposeSession(clusterId: string): Promise<void> {
    await this.request(`/clusters/${encodeURIComponent(clusterId)}/session`, { method: "DELETE" });
  }

  /** Approve or deny a pending mutating-tool request. */
  async resolvePermission(requestId: string, behavior: PermissionBehavior): Promise<void> {
    const response = await this.request(`/permissions/${encodeURIComponent(requestId)}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ behavior }),
    });
    if (!response.ok) throw new Error(`resolve permission failed: ${response.status}`);
  }

  /** Switch the per-cluster permission mode. */
  async setPermissionMode(clusterId: string, mode: PermissionMode): Promise<void> {
    const response = await this.request(`/clusters/${encodeURIComponent(clusterId)}/permission-mode`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ mode }),
    });
    if (!response.ok) throw new Error(`set permission mode failed: ${response.status}`);
  }

  /** Switch the per-cluster model; `null` restores the Claude Code default. */
  async setModel(clusterId: string, model: string | null): Promise<void> {
    const response = await this.request(`/clusters/${encodeURIComponent(clusterId)}/model`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ model }),
    });
    if (!response.ok) throw new Error(`set model failed: ${response.status}`);
  }

  /** Switch the per-cluster reasoning-effort level; `null` restores the Claude Code default ("high"). */
  async setEffort(clusterId: string, effort: EffortLevel | null): Promise<void> {
    const response = await this.request(`/clusters/${encodeURIComponent(clusterId)}/effort`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ effort }),
    });
    if (!response.ok) throw new Error(`set effort failed: ${response.status}`);
  }

  /** Re-run the last failed turn. Resolves for a 202, rejects for a 409/other. */
  async retry(clusterId: string): Promise<void> {
    const response = await this.request(`/clusters/${encodeURIComponent(clusterId)}/retry`, { method: "POST" });
    if (!response.ok) throw new Error(`retry failed: ${response.status}`);
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
          const response = await this.request(`/clusters/${encodeURIComponent(clusterId)}/events`, {
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
