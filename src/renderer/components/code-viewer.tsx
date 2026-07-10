/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Renderer } from "@freelensapp/extensions";
import { useState } from "react";
import styles from "./code-viewer.module.scss";

const { MonacoEditor } = Renderer.Component;

// The host registers Monaco tokenizers only for YAML and JSON; any other
// language renders as plain text in the editor.
const MONACO_LANGUAGES = ["yaml", "json"] as const;
type MonacoLanguage = (typeof MONACO_LANGUAGES)[number];

// The editor is sized to its content within a window: short snippets stay
// compact and long files scroll internally rather than taking over the
// transcript. Values approximate Monaco's default 14px font metrics.
const LINE_HEIGHT = 19;
const CHROME = 16;
const MIN_LINES = 3;
const MAX_LINES = 24;

function monacoLanguage(language?: string): MonacoLanguage | undefined {
  return MONACO_LANGUAGES.includes(language as MonacoLanguage) ? (language as MonacoLanguage) : undefined;
}

interface CodeViewerProps {
  value: string;
  language?: string;
  /** Toolbar label; defaults to the language, or "text" when unknown. */
  title?: string;
}

/**
 * Read-only file/code presentation backed by the host's Monaco editor, with a
 * language label and a copy button. YAML and JSON get full syntax highlighting;
 * any other content renders as plain text.
 */
export function CodeViewer({ value, language, title }: CodeViewerProps) {
  const [copied, setCopied] = useState(false);
  const text = value.replace(/\n$/, "");
  const lineCount = text.split("\n").length;
  const height = Math.min(Math.max(lineCount, MIN_LINES), MAX_LINES) * LINE_HEIGHT + CHROME;

  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className={styles.viewer}>
      <div className={styles.toolbar}>
        <span className={styles.language}>{title ?? language ?? "text"}</span>
        <button type="button" className={styles.copyButton} onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <MonacoEditor
        readOnly
        className={styles.editor}
        language={monacoLanguage(language)}
        value={text}
        style={{ height }}
        options={{
          // automaticLayout keeps the editor correctly sized when it is first
          // revealed from inside a collapsed <details> (backup, resolved card).
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          scrollbar: { alwaysConsumeMouseWheel: false },
        }}
      />
    </div>
  );
}
