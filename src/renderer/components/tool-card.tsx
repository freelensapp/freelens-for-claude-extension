/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import styles from "./tool-card.module.scss";

interface ToolCardProps {
  toolName: string;
  input: unknown;
  /** The tool result summary; absent while the call is still running. */
  result?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** A compact one-line argument summary (kind namespace/name) when those fields exist. */
function summarizeArgs(input: unknown): string {
  const args = asRecord(input);
  const manifest = asRecord(args.manifest);
  const metadata = asRecord(manifest.metadata);
  const kind = typeof args.kind === "string" ? args.kind : typeof manifest.kind === "string" ? manifest.kind : "";
  const namespace =
    typeof args.namespace === "string"
      ? args.namespace
      : typeof metadata.namespace === "string"
        ? metadata.namespace
        : "";
  const name = typeof args.name === "string" ? args.name : typeof metadata.name === "string" ? metadata.name : "";
  const qualified = namespace && name ? `${namespace}/${name}` : name;
  return [kind, qualified].filter(Boolean).join(" ");
}

/** Render the tool input as a small YAML-ish block (JSON is close enough for a preview). */
function renderInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/**
 * A collapsible card pairing a tool call with its result. Collapsed it shows the
 * short tool name, a compact argument summary, and an animated dot while the
 * call is still running; expanded it shows the input and the result summary.
 */
export function ToolCard({ toolName, input, result }: ToolCardProps) {
  const running = result === undefined;
  const summary = summarizeArgs(input);
  return (
    <details className={styles.card}>
      <summary className={styles.header}>
        <span className={styles.toolName}>{toolName}</span>
        {summary ? <span className={styles.args}>{summary}</span> : null}
        {running ? <span className={styles.runningDot} aria-label="running" /> : null}
      </summary>
      <div className={styles.body}>
        <div className={styles.sectionLabel}>Input</div>
        <pre className={styles.code}>{renderInput(input)}</pre>
        {result !== undefined ? (
          <>
            <div className={styles.sectionLabel}>Result</div>
            <pre className={styles.code}>{result || "(no output)"}</pre>
          </>
        ) : null}
      </div>
    </details>
  );
}
