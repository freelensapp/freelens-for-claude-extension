/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Common, Renderer } from "@freelensapp/extensions";
import { useState } from "react";
import { stringify } from "yaml";
import { CodeViewer } from "./code-viewer";
import styles from "./tool-card.module.scss";

import type { SessionEventMap } from "../../common/protocol";

const { Icon, LineProgress } = Renderer.Component;

/** The preparation of the kubectl a kubectl or helm call runs with, as main last reported it. */
export type ToolPreparation = SessionEventMap["tool_progress"];

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
  /** The preparation of the call's kubectl, for `freelens_kubectl` and `freelens_helm`. */
  preparation?: ToolPreparation;
}

/** A byte count as the cluster terminal shows it; `bytesToUnits` gives "N/A" for 0. */
function formatBytes(bytes: number): string {
  return bytes > 0 ? Common.Util.bytesToUnits(bytes) : "0.0B";
}

/** "41% 23.4MiB / 57.0MiB" with a known size, else the bytes received so far. */
function formatDownload(transferred: number, total: number | undefined): string {
  if (!total) return formatBytes(transferred);
  const percentage = Math.min(100, Math.floor((transferred / total) * 100));
  return `${percentage}% ${formatBytes(transferred)} / ${formatBytes(total)}`;
}

/** The tools whose call prepares a kubectl, and the binary each one runs. */
const PREPARING_TOOLS: Record<string, string> = { freelens_kubectl: "kubectl", freelens_helm: "helm" };

/** What the preparation line says, apart from the byte counter. */
function describePreparation(preparation: ToolPreparation | undefined, binary: string) {
  const problems = preparation?.problems ?? [];
  let text: string | undefined;
  if (preparation?.state === "preparing") {
    const downloading = preparation.transferred !== undefined;
    text = preparation.phase ?? (downloading ? "Downloading kubectl" : "Preparing kubectl");
  } else if (preparation?.state === "failed") {
    text = `Preparing ${binary} failed${preparation.error ? `: ${preparation.error}` : ""}`;
  } else if (preparation?.state === "stopped") {
    text = `Stopped while preparing ${binary}`;
  }
  const warning =
    problems.length === 0
      ? undefined
      : `${problems.length === 1 ? "Problem" : `${problems.length} problems`} preparing kubectl`;
  // A screen reader gets the problems in full, as it cannot see the details' tooltip.
  const announcement = [text, warning && `${warning}: ${problems.join(" ")}`].filter(Boolean).join(". ");
  return { text, warning, announcement };
}

/**
 * The line under the header of a kubectl or helm call while the host prepares
 * its kubectl: the host's phase, or the download, with the host's bar when the
 * size is known. It stays when the preparation failed or was stopped, and a
 * problem the preparation went on from stays as a warning; the details are in
 * the body. For a screen reader, the status region is there from the start, so
 * that each change is announced, and the byte counter is a progressbar, read
 * on demand rather than announced at every tick.
 */
function PreparationLine({ preparation, binary }: { preparation?: ToolPreparation; binary: string }) {
  const { text, warning, announcement } = describePreparation(preparation, binary);
  const transferred = preparation?.state === "preparing" ? preparation.transferred : undefined;
  const total = preparation?.total;
  return (
    <>
      <span role="status" className={styles.visuallyHidden}>
        {announcement}
      </span>
      {text || warning ? (
        <div className={styles.preparation}>
          {text ? (
            <div className={styles.preparationRow} title={preparation?.error}>
              {preparation?.state === "failed" ? (
                <Icon material="error_outline" small className={styles.errorIcon} aria-hidden />
              ) : null}
              <span className={styles.preparationText} aria-hidden>
                {text}
              </span>
              {transferred !== undefined ? (
                <span
                  role="progressbar"
                  aria-label="kubectl download"
                  aria-valuemin={total ? 0 : undefined}
                  aria-valuemax={total || undefined}
                  aria-valuenow={total ? transferred : undefined}
                  aria-valuetext={formatDownload(transferred, total)}
                  className={styles.preparationCounter}
                >
                  {formatDownload(transferred, total)}
                </span>
              ) : null}
            </div>
          ) : null}
          {transferred !== undefined && total ? (
            <LineProgress className={styles.preparationBar} value={transferred} max={total} aria-hidden />
          ) : null}
          {warning ? (
            <div className={styles.preparationRow} aria-hidden title={preparation?.problems?.join("\n")}>
              <Icon material="warning" small className={styles.warningIcon} />
              <span className={styles.preparationText}>{warning}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** The problems and the failure of a preparation, in the body of the card. */
function PreparationDetails({ preparation }: { preparation?: ToolPreparation }) {
  const details = [...(preparation?.problems ?? []), ...(preparation?.error ? [preparation.error] : [])];
  if (details.length === 0) return null;
  return (
    <>
      <div className={styles.sectionLabel}>Preparation</div>
      <ul className={styles.preparationDetails}>
        {details.map((detail, index) => (
          <li key={`${index}-${detail}`}>{detail}</li>
        ))}
      </ul>
    </>
  );
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

/** Render any value as YAML. Kubernetes speaks YAML, so tool inputs and JSON results are shown as YAML. */
function toYaml(value: unknown): string {
  try {
    return stringify(value).replace(/\n$/, "");
  } catch {
    return String(value);
  }
}

/**
 * A result may already be YAML or plain text, or it may be JSON. When it parses
 * as a JSON object or array, re-render it as YAML; otherwise show it verbatim.
 */
function resultToYaml(result: string): string {
  const trimmed = result.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") return toYaml(parsed);
    } catch {
      // Not JSON after all; fall through to the verbatim text.
    }
  }
  return result.replace(/\n$/, "");
}

/**
 * A collapsible card pairing a tool call with its result. Collapsed it shows the
 * short tool name, a compact argument summary, and an animated dot while the
 * call is still running; expanded it shows the input and the result summary.
 * A kubectl or helm call shows the preparation of its kubectl under the
 * header, collapsed or expanded.
 */
export function ToolCard({ toolName, input, result, childCalls, preparation }: ToolCardProps) {
  const binary = PREPARING_TOOLS[toolName];
  const running = result === undefined;
  const isSubagent = toolName === SUBAGENT_TOOL_NAME;
  const isError = !running && result.trimStart().startsWith("Error");
  const { title, material } = describeTool(toolName);
  const description = isSubagent ? String(asRecord(input).description ?? "") : "";
  const summary = isSubagent ? description : summarizeArgs(input);
  // A controlled disclosure (not a native <details>): the body mounts only when
  // expanded, so its Monaco editors are not instantiated for every collapsed
  // card, and a card cannot collapse to zero height as a flex item.
  const [open, setOpen] = useState(false);
  return (
    <div className={isError ? `${styles.card} ${styles.errorCard}` : styles.card}>
      <button type="button" className={styles.header} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
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
      </button>
      {binary ? <PreparationLine preparation={preparation} binary={binary} /> : null}
      {open ? (
        <div className={styles.body}>
          <div className={styles.rawName}>{toolName}</div>
          {binary ? <PreparationDetails preparation={preparation} /> : null}
          <div className={styles.sectionLabel}>Input</div>
          <CodeViewer value={toYaml(input)} language="yaml" />
          {result !== undefined ? (
            <>
              <div className={styles.sectionLabel}>Result</div>
              <CodeViewer value={result ? resultToYaml(result) : "(no output)"} language="yaml" />
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
      ) : null}
    </div>
  );
}
