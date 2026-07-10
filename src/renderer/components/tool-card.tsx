/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Renderer } from "@freelensapp/extensions";
import styles from "./tool-card.module.scss";

const { Icon } = Renderer.Component;

/** A subagent tool call rendered indented under the delegation card. */
export interface ToolChild {
  callId: string;
  toolName: string;
  input: unknown;
  result?: string;
}

/** Friendly title and Material icon for each known tool name. */
const TOOL_DESCRIPTIONS: Record<string, { title: string; material: string }> = {
  freelens_resources: { title: "Read resources", material: "search" },
  freelens_pod_logs: { title: "Read pod logs", material: "subject" },
  freelens_warning_events: { title: "Read warning events", material: "warning" },
  freelens_cluster_version: { title: "Cluster version", material: "info" },
  freelens_create_resource: { title: "Create resource", material: "add_box" },
  freelens_update_resource: { title: "Update resource", material: "edit" },
  freelens_patch_resource: { title: "Patch resource", material: "tune" },
  freelens_delete_resource: { title: "Delete resource", material: "delete" },
  freelens_delete_pod: { title: "Delete pod", material: "delete" },
  freelens_rollout_restart: { title: "Rollout restart", material: "restart_alt" },
  freelens_kubectl: { title: "Run kubectl", material: "terminal" },
  freelens_helm: { title: "Run helm", material: "anchor" },
  Agent: { title: "Subagent", material: "smart_toy" },
};

/** Map a tool name to a human title and icon; external MCP tools show `server: tool`. */
function describeTool(toolName: string): { title: string; material: string } {
  const known = TOOL_DESCRIPTIONS[toolName];
  if (known) return known;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp) return { title: `${mcp[1]}: ${mcp[2]}`, material: "power" };
  return { title: toolName, material: "build" };
}

interface ToolCardProps {
  toolName: string;
  input: unknown;
  /** The tool result summary; absent while the call is still running. */
  result?: string;
  /** Nested subagent tool calls, rendered indented inside this card. */
  childCalls?: ToolChild[];
}

/** The `Agent` delegation tool: renders its subagent description rather than a kube summary. */
const SUBAGENT_TOOL_NAME = "Agent";

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
export function ToolCard({ toolName, input, result, childCalls }: ToolCardProps) {
  const running = result === undefined;
  const isSubagent = toolName === SUBAGENT_TOOL_NAME;
  const isError = !running && result.trimStart().startsWith("Error");
  const { title, material } = describeTool(toolName);
  const description = isSubagent ? String(asRecord(input).description ?? "") : "";
  const summary = isSubagent ? description : summarizeArgs(input);
  return (
    <details className={isError ? `${styles.card} ${styles.errorCard}` : styles.card}>
      <summary className={styles.header}>
        <Icon material={material} small className={styles.toolIcon} />
        <span className={styles.title}>{title}</span>
        {summary ? <span className={styles.args}>{summary}</span> : null}
        <span className={styles.status}>
          {running ? (
            <span className={styles.runningDot} aria-label="running" />
          ) : isError ? (
            <Icon material="error_outline" small className={styles.errorIcon} aria-label="error" />
          ) : (
            <Icon material="check" small className={styles.doneCheck} aria-label="done" />
          )}
        </span>
      </summary>
      <div className={styles.body}>
        <div className={styles.rawName}>{toolName}</div>
        <div className={styles.sectionLabel}>Input</div>
        <pre className={styles.code}>{renderInput(input)}</pre>
        {result !== undefined ? (
          <>
            <div className={styles.sectionLabel}>Result</div>
            <pre className={styles.code}>{result || "(no output)"}</pre>
          </>
        ) : null}
        {childCalls && childCalls.length > 0 ? (
          <div className={styles.children}>
            {childCalls.map((child) => (
              <ToolCard key={child.callId} toolName={child.toolName} input={child.input} result={child.result} />
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}
