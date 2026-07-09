/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { createTwoFilesPatch } from "diff";
import { type PermissionBehavior, type PermissionMode, type SessionEvent, sessionEvent } from "../../common/protocol";
import { type ApprovalTarget, describeApproval } from "../tools/approval";
import { toYaml } from "../tools/kube-format";

/** Result of a `resolve` attempt, mapped to an HTTP status by the bridge. */
export type ResolveResult = "ok" | "not_found" | "already_resolved";

/** Outcome of evaluating a mutating tool call against the current mode. */
export interface PermissionDecision {
  behavior: PermissionBehavior;
  /** Denial message for the model; unset when allowed. */
  message?: string;
}

/** The exact denial string the original extension returns to the model. */
const DENIAL_MESSAGE = "The user denied the action.";

/** Denial message when the chat is in read-only mode. */
const READ_ONLY_MESSAGE =
  "This chat is in read-only mode, so mutating actions are disabled. Ask the user to switch modes.";

/** A mutating tool call parked while it awaits user approval. */
interface PendingPermission {
  resolve: (behavior: PermissionBehavior) => void;
}

/**
 * Owns the per-session permission mode and the set of mutating tool calls that
 * are awaiting user approval. Deliberately SDK-free so it can be unit-tested in
 * isolation; the session manager wires it to the SDK `canUseTool` callback.
 */
export class PermissionBroker {
  private mode: PermissionMode = "approve";
  private readonly pending = new Map<string, PendingPermission>();
  private readonly resolvedIds = new Set<string>();

  constructor(
    private readonly emit: (event: SessionEvent) => void,
    private readonly captureBackup: (target: ApprovalTarget) => Promise<string | undefined>,
    private readonly newId: () => string,
    private readonly getResumed: () => boolean = () => false,
    private readonly getModelMeta: () => { model?: string; resolvedModel?: string } = () => ({}),
  ) {}

  getMode(): PermissionMode {
    return this.mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
    this.emit(
      sessionEvent("session_meta", { permissionMode: mode, resumed: this.getResumed(), ...this.getModelMeta() }),
    );
  }

  /**
   * Decide whether a mutating tool call may proceed. In `approve` mode this
   * blocks until the user resolves the request (or a lifecycle event denies it).
   */
  async decideMutating(
    shortName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PermissionDecision> {
    return this.decide(shortName, input, signal, false);
  }

  /**
   * Decide whether a consent-required read tool (e.g. pod logs) may proceed.
   * Reading is permitted in `readOnly` mode; it still needs the user's consent,
   * so this shares the request/approval machinery with mutations but never
   * short-circuits to a read-only denial.
   */
  async decideReadWithConsent(
    shortName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PermissionDecision> {
    return this.decide(shortName, input, signal, true);
  }

  private async decide(
    shortName: string,
    input: Record<string, unknown>,
    signal: AbortSignal | undefined,
    requiresConsentOnly: boolean,
  ): Promise<PermissionDecision> {
    // Mutations are blocked in read-only mode; consent-required reads are not.
    if (this.mode === "readOnly" && !requiresConsentOnly) {
      return { behavior: "deny", message: READ_ONLY_MESSAGE };
    }

    const descriptor = describeApproval(shortName, input);
    const requestId = this.newId();
    const proposedYaml = this.safeYaml(descriptor.proposedValue);
    const currentYaml = descriptor.target ? await this.captureBackup(descriptor.target) : undefined;
    const diff =
      descriptor.wantsDiff && currentYaml != null
        ? createTwoFilesPatch("current", "proposed", currentYaml, proposedYaml, "", "")
        : undefined;

    this.emit(
      sessionEvent("permission_request", {
        requestId,
        toolName: shortName,
        actionTitle: descriptor.actionTitle,
        input,
        proposedYaml,
        currentYaml,
        diff,
      }),
    );

    if (this.mode === "acceptAll") {
      // Record what auto-approval did: request immediately followed by an allow.
      this.resolvedIds.add(requestId);
      this.emit(sessionEvent("permission_resolved", { requestId, behavior: "allow" }));
      return { behavior: "allow" };
    }

    const behavior = await new Promise<PermissionBehavior>((resolve) => {
      this.pending.set(requestId, { resolve });
      if (signal) {
        if (signal.aborted) {
          this.settle(requestId, "deny", "aborted");
        } else {
          signal.addEventListener("abort", () => this.settle(requestId, "deny", "aborted"), { once: true });
        }
      }
    });

    return behavior === "allow" ? { behavior: "allow" } : { behavior: "deny", message: DENIAL_MESSAGE };
  }

  /** Resolve a pending approval identified by its request id. */
  resolve(requestId: string, behavior: PermissionBehavior): ResolveResult {
    const result = this.settle(requestId, behavior);
    if (result === "settled") return "ok";
    if (result === "already") return "already_resolved";
    return "not_found";
  }

  /** Deny every pending request (turn interrupted, session disposed, etc.). */
  denyAllPending(reason: string): void {
    for (const requestId of [...this.pending.keys()]) {
      this.settle(requestId, "deny", reason);
    }
  }

  private settle(requestId: string, behavior: PermissionBehavior, reason?: string): "settled" | "already" | "unknown" {
    const pending = this.pending.get(requestId);
    if (pending) {
      this.pending.delete(requestId);
      this.resolvedIds.add(requestId);
      this.emit(sessionEvent("permission_resolved", { requestId, behavior, reason }));
      pending.resolve(behavior);
      return "settled";
    }
    return this.resolvedIds.has(requestId) ? "already" : "unknown";
  }

  private safeYaml(value: unknown): string {
    try {
      return toYaml(value);
    } catch {
      return String(value);
    }
  }
}
