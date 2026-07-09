/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Metadata the permission broker needs to render an approval dialog for a
// mutating tool call: a human action title, the value to preview as YAML, the
// target resource to read back for the "current resource (backup)" block, and
// whether a unified diff can be computed (only full replacements).

/** Coordinates of the resource a mutation targets, used to capture a backup. */
export interface ApprovalTarget {
  apiVersion: string;
  kind: string;
  namespace?: string;
  name: string;
}

/** Everything the broker needs to describe one pending mutation. */
export interface ApprovalDescriptor {
  /** Short human header, e.g. `UPDATE SERVICE` or `DELETE POD (evict)`. */
  actionTitle: string;
  /** The object rendered as `proposedYaml` in the dialog. */
  proposedValue: unknown;
  /** Resource to read for the backup/diff; omitted when there is nothing to back up. */
  target?: ApprovalTarget;
  /** Whether the proposed result is a known full manifest (diff-able). */
  wantsDiff?: boolean;
}

function upper(value: unknown): string {
  return typeof value === "string" && value ? value.toUpperCase() : "RESOURCE";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** apiVersion for the workload kinds `freelens_rollout_restart` accepts. */
const RESTARTABLE_API_VERSION = "apps/v1";

/**
 * Derive the approval descriptor for a mutating tool call from its short name
 * and validated-ish input. Never throws: a missing field just yields a less
 * specific title or an omitted target (a failed backup must not block a prompt).
 */
export function describeApproval(toolName: string, input: unknown): ApprovalDescriptor {
  const args = asRecord(input);

  switch (toolName) {
    case "freelens_create_resource": {
      const manifest = asRecord(args.manifest);
      // A create has no current object to back up or diff against.
      return { actionTitle: `CREATE ${upper(manifest.kind)}`, proposedValue: manifest };
    }
    case "freelens_update_resource": {
      const manifest = asRecord(args.manifest);
      const metadata = asRecord(manifest.metadata);
      const target = targetOf(manifest.apiVersion, manifest.kind, metadata.namespace, metadata.name);
      return {
        actionTitle: `UPDATE ${upper(manifest.kind)}`,
        proposedValue: manifest,
        target,
        wantsDiff: target != null,
      };
    }
    case "freelens_patch_resource": {
      const subresource = typeof args.subresource === "string" ? args.subresource.trim().toLowerCase() : "";
      const title = subresource ? `PATCH ${upper(args.kind)} (${subresource})` : `PATCH ${upper(args.kind)}`;
      return {
        actionTitle: title,
        proposedValue: args.patch,
        target: targetOf(args.apiVersion, args.kind, args.namespace, args.name),
      };
    }
    case "freelens_delete_resource": {
      const mode = typeof args.mode === "string" ? args.mode : "delete";
      return {
        actionTitle: `DELETE ${upper(args.kind)} (${mode})`,
        proposedValue: input,
        target: targetOf(args.apiVersion, args.kind, args.namespace, args.name),
      };
    }
    case "freelens_delete_pod": {
      const mode = typeof args.mode === "string" ? args.mode : "delete";
      return {
        actionTitle: `DELETE POD (${mode})`,
        proposedValue: input,
        target: targetOf("v1", "Pod", args.namespace, args.name),
      };
    }
    case "freelens_rollout_restart": {
      return {
        actionTitle: `RESTART ${upper(args.kind)}`,
        proposedValue: input,
        target: targetOf(RESTARTABLE_API_VERSION, args.kind, args.namespace, args.name),
      };
    }
    case "freelens_pod_logs": {
      // A read has no target to back up; the input itself is the whole proposal.
      return { actionTitle: "READ POD LOGS", proposedValue: input };
    }
    default:
      return {
        actionTitle: `${toolName
          .replace(/^freelens_/, "")
          .replace(/_/g, " ")
          .toUpperCase()}`,
        proposedValue: input,
      };
  }
}

function targetOf(apiVersion: unknown, kind: unknown, namespace: unknown, name: unknown): ApprovalTarget | undefined {
  if (typeof apiVersion !== "string" || typeof kind !== "string" || typeof name !== "string") return undefined;
  if (!apiVersion || !kind || !name) return undefined;
  return {
    apiVersion,
    kind,
    namespace: typeof namespace === "string" && namespace ? namespace : undefined,
    name,
  };
}
