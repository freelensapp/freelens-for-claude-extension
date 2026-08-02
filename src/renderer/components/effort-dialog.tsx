/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Renderer } from "@freelensapp/extensions";
import { useEffect } from "react";
import { EFFORT_LEVELS } from "../../common/protocol";
import styles from "./effort-dialog.module.scss";

import type { EffortLevel } from "../../common/protocol";

const { Icon } = Renderer.Component;

/** Title-case label for each effort level, e.g. in the row and the command menu. */
export const EFFORT_TITLES: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

const EFFORT_DESCRIPTIONS: Record<EffortLevel, string> = {
  low: "Minimal thinking, fastest responses",
  medium: "Moderate thinking",
  high: "Deep reasoning",
  xhigh: "Deeper than high",
  max: "Maximum effort",
};

interface EffortDialogProps {
  /** The currently selected explicit effort level, if any; unset means "Default" ("high"). */
  current?: EffortLevel;
  /** Chosen an effort level; `null` restores the Claude Code default ("high"). */
  onSelect: (value: EffortLevel | null) => void;
  onClose: () => void;
}

interface EffortRowProps {
  label: string;
  description: string;
  active: boolean;
  onClick: () => void;
}

function EffortRow({ label, description, active, onClick }: EffortRowProps) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={active ? `${styles.row} ${styles.rowActive}` : styles.row}
      onClick={onClick}
    >
      <Icon
        material="check"
        small
        className={active ? `${styles.check} ${styles.checkVisible}` : styles.check}
        aria-hidden
      />
      <span className={styles.rowText}>
        <span className={styles.rowName}>{label}</span>
        <span className={styles.rowDescription}>{description}</span>
      </span>
    </button>
  );
}

/**
 * The "Effort" modal opened from the command menu ("/" widget). Lists the
 * "Default" choice ("high") plus every reasoning-effort level, with the
 * active selection checked. Picking a row applies it and closes the dialog.
 */
export function EffortDialog({ current, onSelect, onClose }: EffortDialogProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const choose = (value: EffortLevel | null) => {
    onSelect(value);
    onClose();
  };

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.dialog} role="dialog" aria-label="Effort" onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2 className={styles.title}>Effort</h2>
          <Icon material="close" small interactive tooltip="Close" onClick={onClose} />
        </div>
        <div className={styles.list} role="listbox" aria-label="Effort levels">
          <EffortRow
            label={`Default (${EFFORT_TITLES.high})`}
            description={EFFORT_DESCRIPTIONS.high}
            active={!current}
            onClick={() => choose(null)}
          />
          {EFFORT_LEVELS.map((level) => (
            <EffortRow
              key={level}
              label={EFFORT_TITLES[level]}
              description={EFFORT_DESCRIPTIONS[level]}
              active={current === level}
              onClick={() => choose(level)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
