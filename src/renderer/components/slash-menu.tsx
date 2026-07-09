/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import styles from "./slash-menu.module.scss";

interface SlashMenuProps {
  /** Matching command names (without a leading slash), already filtered. */
  matches: string[];
  /** Index of the highlighted entry. */
  selected: number;
  /** Complete the input with the chosen command name. */
  onSelect: (name: string) => void;
}

/**
 * The slash-command autocomplete popup shown above the input while the draft is
 * a bare `/command`. Selection is driven from the input's keyboard handler; a
 * click (via mousedown so the textarea keeps focus) also completes.
 */
export function SlashMenu({ matches, selected, onSelect }: SlashMenuProps) {
  return (
    <div className={styles.menu} role="listbox">
      {matches.map((name, index) => (
        <button
          key={name}
          type="button"
          role="option"
          aria-selected={index === selected}
          className={index === selected ? `${styles.item} ${styles.selected}` : styles.item}
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(name);
          }}
        >
          /{name}
        </button>
      ))}
    </div>
  );
}
