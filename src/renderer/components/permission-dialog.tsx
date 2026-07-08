/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import styles from "./permission-dialog.module.scss";

import type { PermissionBehavior, SessionEventMap } from "../../common/protocol";

type PermissionRequest = SessionEventMap["permission_request"];

interface PermissionResolution {
  behavior: PermissionBehavior;
  reason?: string;
}

interface PermissionDialogProps {
  request: PermissionRequest;
  resolution?: PermissionResolution;
  onResolve: (behavior: PermissionBehavior) => void;
}

/** Render a unified diff with per-line add/remove highlighting. */
function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className={styles.code}>
      {diff.split("\n").map((line, index) => {
        const key = `${index}-${line}`;
        let className: string | undefined;
        if (line.startsWith("+") && !line.startsWith("+++")) className = styles.added;
        else if (line.startsWith("-") && !line.startsWith("---")) className = styles.removed;
        else if (line.startsWith("@@")) className = styles.hunk;
        return (
          <span key={key} className={className}>
            {line}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

function ActionDetails({ request }: { request: PermissionRequest }) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionLabel}>Action details</div>
      {request.diff ? <DiffBlock diff={request.diff} /> : <pre className={styles.code}>{request.proposedYaml}</pre>}
      {request.currentYaml ? (
        <details className={styles.backup}>
          <summary className={styles.backupSummary}>Current resource (backup)</summary>
          <pre className={styles.code}>{request.currentYaml}</pre>
        </details>
      ) : null}
    </div>
  );
}

/**
 * Inline approval card for a mutating tool call, rendered in the transcript at
 * the position of the `permission_request` event. While pending it shows the
 * proposed change plus Approve/Deny; once resolved it collapses to a one-line
 * summary that expands back to the details.
 */
export function PermissionDialog({ request, resolution, onResolve }: PermissionDialogProps) {
  if (resolution) {
    const label = resolution.behavior === "allow" ? "Approved" : "Denied";
    const suffix = resolution.reason ? ` (${resolution.reason})` : "";
    return (
      <details className={`${styles.card} ${styles.resolved}`}>
        <summary className={styles.resolvedSummary}>
          <span className={resolution.behavior === "allow" ? styles.approvedTag : styles.deniedTag}>{label}</span>
          <span className={styles.resolvedTitle}>
            {request.actionTitle}
            {suffix}
          </span>
        </summary>
        <ActionDetails request={request} />
      </details>
    );
  }

  return (
    <div className={`${styles.card} ${styles.pending}`}>
      <div className={styles.header}>{request.actionTitle}</div>
      <ActionDetails request={request} />
      <div className={styles.buttons}>
        <button type="button" className={styles.approve} onClick={() => onResolve("allow")}>
          Approve
        </button>
        <button type="button" className={styles.deny} onClick={() => onResolve("deny")}>
          Deny
        </button>
      </div>
    </div>
  );
}
