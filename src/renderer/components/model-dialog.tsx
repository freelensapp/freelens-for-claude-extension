/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Renderer } from "@freelensapp/extensions";
import { useEffect } from "react";
import styles from "./model-dialog.module.scss";

import type { ModelChoice } from "../../common/protocol";

const { Icon } = Renderer.Component;

interface ModelDialogProps {
  /** The live model catalog (or the static alias fallback), in display order. */
  models: ModelChoice[];
  /** The currently selected explicit model value, if any; unset means "Default". */
  current?: string;
  /** Label for the "use the Claude Code default" row, e.g. "Default (claude-sonnet-5)". */
  defaultLabel: string;
  /** Chosen a model; `null` restores the Claude Code default. */
  onSelect: (value: string | null) => void;
  onClose: () => void;
}

interface ModelRowProps {
  label: string;
  resolvedModel?: string;
  active: boolean;
  onClick: () => void;
}

function ModelRow({ label, resolvedModel, active, onClick }: ModelRowProps) {
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
        {resolvedModel ? <span className={styles.rowResolved}>{resolvedModel}</span> : null}
      </span>
    </button>
  );
}

/**
 * The "Switch model" modal opened from the command menu ("/" widget). Lists
 * the "Default" choice plus the live model catalog (or the static alias
 * fallback), with the active selection checked. Picking a row applies it and
 * closes the dialog.
 */
export function ModelDialog({ models, current, defaultLabel, onSelect, onClose }: ModelDialogProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const choose = (value: string | null) => {
    onSelect(value);
    onClose();
  };

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.dialog} role="dialog" aria-label="Switch model" onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2 className={styles.title}>Switch model</h2>
          <Icon material="close" small interactive tooltip="Close" onClick={onClose} />
        </div>
        <div className={styles.list} role="listbox" aria-label="Models">
          <ModelRow label={defaultLabel} active={!current} onClick={() => choose(null)} />
          {models.map((choice) => (
            <ModelRow
              key={choice.value}
              label={choice.displayName}
              resolvedModel={
                choice.resolvedModel && choice.resolvedModel !== choice.displayName ? choice.resolvedModel : undefined
              }
              active={current === choice.value}
              onClick={() => choose(choice.value)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
