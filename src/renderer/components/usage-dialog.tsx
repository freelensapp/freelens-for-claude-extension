/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Renderer } from "@freelensapp/extensions";
import { useEffect, useState } from "react";
import styles from "./usage-dialog.module.scss";

import type { ClusterUsageResponse, UsageBehavior } from "../../common/protocol";
import type { BridgeClient } from "../api/bridge-client";

const { Icon } = Renderer.Component;

interface UsageDialogProps {
  clusterId: string;
  client: BridgeClient;
  onClose: () => void;
}

/** Per-behavior sentence and tip, mirroring the Claude Code `/usage` dialog. */
const BEHAVIOR_COPY: Record<UsageBehavior["key"], { title: (pct: number) => string; description: string }> = {
  long_context: {
    title: (pct) => `${pct}% of your usage was at >150k context`,
    description:
      "Longer sessions are more expensive even when cached. /compact mid-task, /clear when switching to new tasks.",
  },
  subagent_heavy: {
    title: (pct) => `${pct}% of your usage came from subagent-heavy sessions`,
    description:
      "Each subagent runs its own requests. Be deliberate about spawning them — and consider configuring a cheaper model for simpler subagents.",
  },
  cache_miss: {
    title: (pct) => `${pct}% of your usage missed the prompt cache`,
    description:
      "Cache misses re-send context at full price. Keep sessions focused and avoid editing earlier messages.",
  },
  high_parallel: {
    title: (pct) => `${pct}% of your usage ran highly parallel`,
    description: "Many concurrent requests spend limits quickly. Pace parallel work when you are close to a limit.",
  },
  cron: {
    title: (pct) => `${pct}% of your usage came from scheduled runs`,
    description: "Scheduled runs add up in the background. Review how often they run and which model they use.",
  },
};

/** "Resets in 6d" / "Resets in 1h" / "Resets in 12m" from an ISO timestamp. */
function formatResets(resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  const target = Date.parse(resetsAt);
  if (Number.isNaN(target)) return null;
  const ms = target - Date.now();
  if (ms <= 0) return "Resets now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes >= 1440) return `Resets in ${Math.floor(minutes / 1440)}d`;
  if (minutes >= 60) return `Resets in ${Math.floor(minutes / 60)}h`;
  return `Resets in ${Math.max(minutes, 1)}m`;
}

function formatPercent(utilization: number | null): string {
  return utilization == null ? "—" : `${Math.round(utilization)}%`;
}

function AccountRow({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowValue}>{value}</span>
    </div>
  );
}

export function UsageDialog({ clusterId, client, onClose }: UsageDialogProps) {
  const [data, setData] = useState<ClusterUsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [window, setWindow] = useState<"day" | "week">("day");

  useEffect(() => {
    let cancelled = false;
    client
      .getUsage(clusterId)
      .then((response) => {
        if (!cancelled) setData(response);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [clusterId, client]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const fetchError = error ?? data?.error;
  const contributing = data?.contributing ? data.contributing[window] : null;

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.dialog} role="dialog" aria-label="Account and usage" onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2 className={styles.title}>Account &amp; Usage</h2>
          <Icon material="close" small interactive tooltip="Close" onClick={onClose} />
        </div>

        {!data && !fetchError ? <div className={styles.empty}>Loading...</div> : null}
        {fetchError ? <div className={styles.error}>{fetchError}</div> : null}

        {data && !fetchError ? (
          <>
            <div className={styles.section}>
              <div className={styles.sectionLabel}>Account</div>
              <AccountRow label="Auth method" value={data.account.authMethod} />
              <AccountRow label="Email" value={data.account.email} />
              <AccountRow label="Organization" value={data.account.organization} />
              <AccountRow label="Plan" value={data.account.plan} />
            </div>

            <div className={styles.section}>
              <div className={styles.sectionLabel}>Usage</div>
              {data.rateLimitsAvailable && data.windows.length > 0 ? (
                data.windows.map((usageWindow) => (
                  <div key={usageWindow.label} className={styles.meter}>
                    <div className={styles.meterHead}>
                      <span>{usageWindow.label}</span>
                      <span className={styles.meterPercent}>{formatPercent(usageWindow.utilization)}</span>
                    </div>
                    <div className={styles.track}>
                      <div
                        className={styles.fill}
                        style={{ width: `${Math.min(usageWindow.utilization ?? 0, 100)}%` }}
                      />
                    </div>
                    {formatResets(usageWindow.resetsAt) ? (
                      <div className={styles.resets}>{formatResets(usageWindow.resetsAt)}</div>
                    ) : null}
                  </div>
                ))
              ) : (
                <div className={styles.note}>Plan rate limits do not apply to this session.</div>
              )}
              <a className={styles.link} href="https://claude.ai/settings/usage" target="_blank" rel="noreferrer">
                Manage usage on claude.ai
              </a>
            </div>

            {data.contributing ? (
              <div className={styles.section}>
                <div className={styles.sectionLabel}>What&apos;s contributing to your limits usage?</div>
                <div className={styles.toggle}>
                  <button
                    type="button"
                    className={window === "day" ? `${styles.toggleButton} ${styles.toggleActive}` : styles.toggleButton}
                    onClick={() => setWindow("day")}
                  >
                    Day
                  </button>
                  <button
                    type="button"
                    className={
                      window === "week" ? `${styles.toggleButton} ${styles.toggleActive}` : styles.toggleButton
                    }
                    onClick={() => setWindow("week")}
                  >
                    Week
                  </button>
                </div>
                <div className={styles.note}>
                  Approximate, based on local sessions on this machine — does not include other devices or claude.ai.
                  These are independent characteristics of your usage, not a breakdown.
                </div>
                {contributing && contributing.behaviors.length > 0 ? (
                  contributing.behaviors.map((behavior) => {
                    const copy = BEHAVIOR_COPY[behavior.key];
                    const pct = Math.round(behavior.pct);
                    return (
                      <div key={behavior.key} className={styles.behavior}>
                        <div className={styles.behaviorTitle}>{copy ? copy.title(pct) : `${pct}% ${behavior.key}`}</div>
                        {copy ? <div className={styles.behaviorDescription}>{copy.description}</div> : null}
                      </div>
                    );
                  })
                ) : (
                  <div className={styles.note}>No notable contributors in this window.</div>
                )}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
