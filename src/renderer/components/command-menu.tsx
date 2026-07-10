/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { useEffect, useRef, useState } from "react";
import styles from "./command-menu.module.scss";

interface CommandMenuProps {
  /** Available slash-command names (may include a leading slash). */
  commands: string[];
  /** Whether the Compact context action is unavailable right now. */
  compactDisabled: boolean;
  /** Insert the chosen slash command into the composer. */
  onCommand: (name: string) => void;
  /** Open the Account & Usage dialog (`/usage`). */
  onUsage: () => void;
  /** Clear the conversation (New chat). */
  onClearConversation: () => void;
  /** Compact the conversation (native `/compact`). */
  onCompact: () => void;
}

/**
 * The "[/]" command widget in the composer. It opens a popover listing a
 * "Context" group (Clear conversation, Compact) followed by a "Slash Commands"
 * group with every available command. Command entries complete via mousedown so
 * the composer textarea keeps focus, mirroring the slash autocomplete popup.
 */
export function CommandMenu({
  commands,
  compactDisabled,
  onCommand,
  onUsage,
  onClearConversation,
  onCompact,
}: CommandMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onMouseDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [open]);

  const names = commands.map((name) => name.replace(/^\//, "")).sort((a, b) => a.localeCompare(b));

  const run = (action: () => void) => {
    action();
    setOpen(false);
  };

  return (
    <div className={styles.container} ref={containerRef}>
      <button
        type="button"
        className={styles.trigger}
        title="Commands"
        aria-label="Commands"
        onClick={() => setOpen((value) => !value)}
      >
        /
      </button>
      {open ? (
        <div className={styles.popover}>
          <div className={styles.group}>
            <div className={styles.groupLabel}>Context</div>
            <button
              type="button"
              className={styles.item}
              onMouseDown={(event) => {
                event.preventDefault();
                run(onUsage);
              }}
            >
              Account &amp; Usage...
            </button>
            <button
              type="button"
              className={styles.item}
              onMouseDown={(event) => {
                event.preventDefault();
                run(onClearConversation);
              }}
            >
              Clear conversation
            </button>
            <button
              type="button"
              className={styles.item}
              disabled={compactDisabled}
              onMouseDown={(event) => {
                event.preventDefault();
                if (!compactDisabled) run(onCompact);
              }}
            >
              Compact
            </button>
          </div>
          <div className={styles.group}>
            <div className={styles.groupLabel}>Slash Commands</div>
            {names.length > 0 ? (
              names.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`${styles.item} ${styles.command}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    run(() => onCommand(name));
                  }}
                >
                  /{name}
                </button>
              ))
            ) : (
              <div className={styles.empty}>No commands available</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
