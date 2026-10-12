/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { sessionEvent } from "../../common/protocol";

import type { Main } from "@freelensapp/extensions";

import type { SessionEvent, SessionEventMap } from "../../common/protocol";
import type { PreparationReport, PreparationReports } from "../tools/cli-exec";

// Turns the host's reports on the preparation of a tool call's kubectl into
// `tool_progress` events of the session, tied to the call's `tool_use` id. The
// tool card shows them under its header. A call whose preparation reports
// nothing (kubectl is ready) sends no event at all, so its card shows no line.

/** Least interval between two download progress events of one call. */
export const PROGRESS_EVENT_INTERVAL_MS = 250;

type ToolProgress = SessionEventMap["tool_progress"];

/** What is known of one call's preparation so far. */
interface Preparation {
  phase?: string;
  transferred?: number;
  total?: number;
  problems: string[];
  /** Whether a `preparing` event was sent, so the card shows the line. */
  shown: boolean;
  /** When the last `preparing` event was sent. */
  sentAt: number;
  /** The pending trailing progress event. */
  timer?: ReturnType<typeof setTimeout>;
}

/** The preparations of a session's tool calls, by `tool_use` id. */
export class PreparationProgress implements PreparationReports {
  private readonly preparations = new Map<string, Preparation>();

  constructor(private readonly emit: (event: SessionEvent) => void) {}

  begin(callId: string): PreparationReport {
    const preparation: Preparation = { problems: [], shown: false, sentAt: 0 };
    this.preparations.set(callId, preparation);
    // Nothing is reported once the preparation has ended or was stopped.
    const active = () => this.preparations.get(callId) === preparation;
    return {
      phase: (message) => {
        // kubectl and its environment wait for the same preparation and both
        // report each phase.
        if (!active() || message === preparation.phase) return;
        preparation.phase = message;
        preparation.transferred = undefined;
        preparation.total = undefined;
        this.send(callId, preparation);
      },
      progress: (progress) => this.progress(callId, preparation, active(), progress),
      problem: (message) => {
        if (!active() || preparation.problems.includes(message)) return;
        preparation.problems.push(message);
        this.send(callId, preparation);
      },
      done: () => {
        if (!active()) return;
        const visible = preparation.shown || preparation.problems.length > 0;
        this.end(callId, preparation, visible ? { state: "done" } : undefined);
      },
      failed: (message) => {
        if (!active()) return;
        this.end(callId, preparation, { state: "failed", error: message });
      },
    };
  }

  /**
   * The turn was interrupted: every call still preparing ends as `stopped`,
   * and what the host reports for it afterwards is dropped. The host's
   * preparation itself goes on.
   */
  stopAll(): void {
    for (const [callId, preparation] of [...this.preparations]) {
      const visible = preparation.shown || preparation.problems.length > 0;
      this.end(callId, preparation, visible ? { state: "stopped" } : undefined);
    }
  }

  /** Drop every preparation without an event, when the session goes away. */
  clear(): void {
    for (const preparation of this.preparations.values()) clearTimeout(preparation.timer);
    this.preparations.clear();
  }

  /** The latest event of every call still preparing that shows a line, for a new subscriber. */
  current(): SessionEvent[] {
    return [...this.preparations]
      .filter(([, preparation]) => preparation.shown)
      .map(([callId, preparation]) => this.preparingEvent(callId, preparation));
  }

  /**
   * A download's progress, sent at most every {@link PROGRESS_EVENT_INTERVAL_MS}
   * with the latest value last, and at once when the download is complete.
   */
  private progress(
    callId: string,
    preparation: Preparation,
    active: boolean,
    { transferred, total }: Main.Shell.KubectlDownloadProgress,
  ): void {
    if (!active) return;
    // Both callers of the one download report every chunk.
    if (preparation.transferred !== undefined && transferred <= preparation.transferred) return;
    preparation.phase = undefined;
    preparation.transferred = transferred;
    preparation.total = total;
    const elapsed = Date.now() - preparation.sentAt;
    const complete = total !== undefined && transferred >= total;
    if (complete || elapsed >= PROGRESS_EVENT_INTERVAL_MS) {
      this.send(callId, preparation);
    } else {
      preparation.timer ??= setTimeout(() => {
        preparation.timer = undefined;
        if (this.preparations.get(callId) === preparation) this.send(callId, preparation);
      }, PROGRESS_EVENT_INTERVAL_MS - elapsed);
    }
  }

  private send(callId: string, preparation: Preparation): void {
    clearTimeout(preparation.timer);
    preparation.timer = undefined;
    preparation.shown = true;
    preparation.sentAt = Date.now();
    this.emit(this.preparingEvent(callId, preparation));
  }

  private preparingEvent(callId: string, preparation: Preparation): SessionEvent {
    return sessionEvent("tool_progress", {
      callId,
      state: "preparing",
      ...(preparation.phase !== undefined ? { phase: preparation.phase } : {}),
      ...(preparation.transferred !== undefined ? { transferred: preparation.transferred } : {}),
      ...(preparation.total !== undefined ? { total: preparation.total } : {}),
      ...(preparation.problems.length > 0 ? { problems: [...preparation.problems] } : {}),
    });
  }

  /** End a preparation, with its last event when it showed or has something to show. */
  private end(callId: string, preparation: Preparation, last: Pick<ToolProgress, "state" | "error"> | undefined): void {
    clearTimeout(preparation.timer);
    this.preparations.delete(callId);
    if (!last) return;
    this.emit(
      sessionEvent("tool_progress", {
        callId,
        ...last,
        ...(preparation.problems.length > 0 ? { problems: [...preparation.problems] } : {}),
      }),
    );
  }
}

/**
 * Whether a `tool_progress` event goes into the transcript: one that ends a
 * preparation with something the card keeps showing.
 */
export function isPersistedToolProgress(progress: ToolProgress): boolean {
  if (progress.state === "preparing") return false;
  return progress.state !== "done" || (progress.problems?.length ?? 0) > 0;
}
