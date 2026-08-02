/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import styles from "./context-donut.module.scss";

interface ContextDonutProps {
  /** Percentage of the context window in use, 0-100. */
  percentage: number;
  /** Native tooltip text (the session token counts). */
  title: string;
  onClick: () => void;
}

const SIZE = 22;
const STROKE = 3;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Amber past 70% of the window, red past 90%; primary color otherwise. */
function fillClass(pct: number): string {
  if (pct >= 90) return styles.high;
  if (pct >= 70) return styles.medium;
  return styles.low;
}

/**
 * A small context-usage ring for the composer status strip. The arc length
 * tracks the percentage of the context window in use; clicking opens the
 * detailed breakdown modal. The token counts ride along as the native tooltip.
 */
export function ContextDonut({ percentage, title, onClick }: ContextDonutProps) {
  const pct = Math.max(0, Math.min(100, percentage));
  const filled = (pct / 100) * CIRCUMFERENCE;
  const rounded = Math.round(pct);
  return (
    <button
      type="button"
      className={styles.donut}
      onClick={onClick}
      title={title}
      aria-label={`Context ${rounded}% used. Open context details.`}
    >
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        <circle className={styles.track} cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" strokeWidth={STROKE} />
        <circle
          className={fillClass(pct)}
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${CIRCUMFERENCE - filled}`}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </svg>
      <span className={styles.label}>{rounded}%</span>
    </button>
  );
}
