/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { z } from "zod";
import { DEFAULT_POD_LOGS_TAIL_LINES } from "../../common/preferences-store";
import { LOG_BYTE_CAP, truncateBytes } from "./kube-format";

import type { CoreV1Api } from "@kubernetes/client-node";

export const podLogsSchema = {
  namespace: z.string().describe("Namespace of the pod."),
  name: z.string().describe("Pod name."),
  container: z.string().optional().describe("Container name. Defaults to the only container when there is one."),
  tailLines: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Number of lines from the end of the log to fetch. Defaults to the configured preference."),
  grep: z.string().optional().describe("JavaScript regular expression; only matching log lines are returned."),
  previous: z
    .boolean()
    .optional()
    .describe("Return logs from the previous terminated container instance (useful for CrashLoopBackOff)."),
  timestamps: z.boolean().optional().describe("Prefix each line with its RFC3339 timestamp."),
};

const podLogsInput = z.object(podLogsSchema);
export type PodLogsInput = z.infer<typeof podLogsInput>;

/** The slice of the Kubernetes client the pod-logs tool needs. */
export interface PodLogsClient {
  core: Pick<CoreV1Api, "readNamespacedPodLog">;
}

/**
 * Fetch a snapshot of a pod's logs, optionally filtered by a regex applied
 * line-by-line, capped to {@link LOG_BYTE_CAP} bytes. `defaultTailLines`
 * supplies the tail length when the model does not request one.
 */
export async function runPodLogs(
  client: PodLogsClient,
  input: PodLogsInput,
  defaultTailLines = DEFAULT_POD_LOGS_TAIL_LINES,
): Promise<string> {
  const { namespace, name, container, grep, previous, timestamps } = input;
  const tailLines = input.tailLines ?? defaultTailLines;

  let regex: RegExp | undefined;
  if (grep) {
    try {
      regex = new RegExp(grep);
    } catch (error) {
      return `Invalid grep pattern: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  let raw: string;
  try {
    raw = await client.core.readNamespacedPodLog({
      name,
      namespace,
      container,
      tailLines,
      previous,
      timestamps,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (previous && /previous terminated container.*not found/i.test(message)) {
      return `No previous (terminated) container instance was found for pod "${name}"${container ? ` container "${container}"` : ""}; it may not have restarted yet.`;
    }
    throw error;
  }

  if (!raw) {
    return `No logs available for pod "${name}"${container ? ` container "${container}"` : ""}.`;
  }

  let lines = raw.split("\n");
  if (regex) {
    lines = lines.filter((line) => regex.test(line));
    if (lines.length === 0) {
      return `No log lines matched /${grep}/ for pod "${name}".`;
    }
  }

  return truncateBytes(lines.join("\n"), LOG_BYTE_CAP);
}
