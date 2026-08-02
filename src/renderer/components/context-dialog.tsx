/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Renderer } from "@freelensapp/extensions";
import { useEffect, useState } from "react";
import { categoryColor } from "./context-colors";
import styles from "./context-dialog.module.scss";

import type { ClusterContextResponse } from "../../common/protocol";
import type { BridgeClient } from "../api/bridge-client";

const { Icon } = Renderer.Component;

interface ContextDialogProps {
  clusterId: string;
  client: BridgeClient;
  onClose: () => void;
}

/** "3.9k", "453.2k", "1.0M" - compact token counts like Claude Code's `/context`. */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(Math.round(tokens));
}

/** Share of the whole context window, one decimal (e.g. "45.3%"). */
function formatShare(tokens: number, maxTokens: number): string {
  if (maxTokens <= 0) return "—";
  return `${((tokens / maxTokens) * 100).toFixed(1)}%`;
}

/** A single category (or the free-space remainder) row in the breakdown table. */
function CategoryRow({
  name,
  tokens,
  maxTokens,
  color,
}: {
  name: string;
  tokens: number;
  maxTokens: number;
  color?: string;
}) {
  return (
    <div className={styles.row}>
      <span className={styles.category}>
        <span className={styles.swatch} style={color ? { background: color } : undefined} />
        {name}
      </span>
      <span className={styles.tokens}>{formatTokens(tokens)}</span>
      <span className={styles.share}>{formatShare(tokens, maxTokens)}</span>
    </div>
  );
}

/**
 * The "Context usage" modal opened from the composer donut: the model, the
 * current occupancy versus the window, a segmented bar, and a per-category
 * breakdown mirroring the Claude Code `/context` command.
 */
export function ContextDialog({ clusterId, client, onClose }: ContextDialogProps) {
  const [data, setData] = useState<ClusterContextResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .getContext(clusterId)
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
  const freeTokens = data ? Math.max(0, data.maxTokens - data.totalTokens) : 0;

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.dialog} role="dialog" aria-label="Context usage" onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2 className={styles.title}>Context usage</h2>
          <Icon material="close" small interactive tooltip="Close" onClick={onClose} />
        </div>

        {!data && !fetchError ? <div className={styles.empty}>Loading...</div> : null}
        {fetchError ? <div className={styles.error}>{fetchError}</div> : null}

        {data && !fetchError ? (
          <>
            {data.model ? <div className={styles.model}>{data.model}</div> : null}
            <div className={styles.summary}>
              {formatTokens(data.totalTokens)} / {formatTokens(data.maxTokens)} tokens ({Math.round(data.percentage)}%)
            </div>

            <div className={styles.bar}>
              {data.categories.map((category, index) => (
                <div
                  key={category.name}
                  className={styles.segment}
                  style={{
                    width: `${data.maxTokens > 0 ? (category.tokens / data.maxTokens) * 100 : 0}%`,
                    background: categoryColor(category.name, category.color, index),
                  }}
                  title={`${category.name}: ${formatTokens(category.tokens)}`}
                />
              ))}
            </div>

            <div className={styles.table}>
              <div className={`${styles.row} ${styles.headRow}`}>
                <span className={styles.category}>Category</span>
                <span className={styles.tokens}>Tokens</span>
                <span className={styles.share}>Usage</span>
              </div>
              {data.categories.map((category, index) => (
                <CategoryRow
                  key={category.name}
                  name={category.name}
                  tokens={category.tokens}
                  maxTokens={data.maxTokens}
                  color={categoryColor(category.name, category.color, index)}
                />
              ))}
              <CategoryRow name="Free space" tokens={freeTokens} maxTokens={data.maxTokens} />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
