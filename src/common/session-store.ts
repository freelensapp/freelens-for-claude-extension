/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Common } from "@freelensapp/extensions";
import { makeObservable, observable } from "mobx";

import type { PermissionMode } from "./protocol";

// Per-cluster chat session state persisted by the main process and synced to the
// renderer like the BridgeStore. It records the Claude Code session id (for
// `resume` across app restarts) and the permission mode, so a cluster chat comes
// back in the same mode after Freelens is restarted.
//
// Only the two safe modes are ever persisted: `acceptAll` mirrors the original
// extension's non-persistent `bypassApprovals` and always falls back to
// `approve` on restart.

/** The permission modes that may be persisted (`acceptAll` is never stored). */
export type PersistedPermissionMode = "readOnly" | "approve";

/** One cluster's persisted chat session entry. */
export interface ChatSessionEntry {
  /** Claude Code session id used to resume the conversation after a restart. */
  sessionId?: string;
  /** The last persisted permission mode for this cluster. */
  permissionMode: PersistedPermissionMode;
  /** ISO timestamp of the last write. */
  updatedAt: string;
}

export interface ChatSessionStoreModel {
  sessions: Record<string, ChatSessionEntry>;
}

/**
 * The narrow view of the session store the main-process session manager depends
 * on. Declaring it here keeps `session-manager.ts` free of the host-only
 * `ExtensionStore` base class and lets tests substitute a plain object.
 */
export interface ChatSessionState {
  /** Read the persisted entry for a cluster, if any. */
  read(clusterId: string): ChatSessionEntry | undefined;
  /** Persist the Claude Code session id; `undefined` clears it (new chat). */
  writeSessionId(clusterId: string, sessionId: string | undefined): void;
  /** Persist the permission mode; `acceptAll` is ignored (never persisted). */
  writePermissionMode(clusterId: string, mode: PermissionMode): void;
}

export class ChatSessionStore extends Common.Store.ExtensionStore<ChatSessionStoreModel> implements ChatSessionState {
  sessions: Record<string, ChatSessionEntry> = {};

  constructor() {
    super({
      configName: "chat-session-store",
      defaults: { sessions: {} },
    });
    makeObservable(this, {
      sessions: observable,
    });
  }

  read(clusterId: string): ChatSessionEntry | undefined {
    return this.sessions[clusterId];
  }

  writeSessionId(clusterId: string, sessionId: string | undefined): void {
    const existing = this.sessions[clusterId];
    // Nothing to clear for a cluster we have never seen.
    if (!existing && sessionId == null) return;
    const base: ChatSessionEntry = existing ?? { permissionMode: "approve", updatedAt: this.now() };
    this.sessions = {
      ...this.sessions,
      [clusterId]: { ...base, sessionId, updatedAt: this.now() },
    };
  }

  writePermissionMode(clusterId: string, mode: PermissionMode): void {
    // `acceptAll` is deliberately never persisted; it falls back to `approve`.
    if (mode === "acceptAll") return;
    const existing = this.sessions[clusterId];
    const base: ChatSessionEntry = existing ?? { permissionMode: mode, updatedAt: this.now() };
    this.sessions = {
      ...this.sessions,
      [clusterId]: { ...base, permissionMode: mode, updatedAt: this.now() },
    };
  }

  private now(): string {
    return new Date().toISOString();
  }

  fromStore({ sessions }: Partial<ChatSessionStoreModel>): void {
    this.sessions = sessions ?? {};
  }

  toJSON(): ChatSessionStoreModel {
    return { sessions: this.sessions };
  }
}
