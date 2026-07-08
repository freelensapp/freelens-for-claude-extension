/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { z } from "zod";

import type { CoreV1Api, CoreV1Event } from "@kubernetes/client-node";

const EVENT_CAP = 50;

export const warningEventsSchema = {
  namespace: z.string().optional().describe("Namespace to scope the query. Omit to scan all namespaces."),
};

const warningEventsInput = z.object(warningEventsSchema);
export type WarningEventsInput = z.infer<typeof warningEventsInput>;

/** The slice of the Kubernetes client the warning-events tool needs. */
export interface WarningEventsClient {
  core: Pick<CoreV1Api, "listEventForAllNamespaces" | "listNamespacedEvent">;
}

/** The effective timestamp of an event, used for recency sorting. */
function eventTime(event: CoreV1Event): number {
  const value = event.lastTimestamp ?? event.eventTime ?? event.firstTimestamp;
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function formatEvent(event: CoreV1Event): string {
  const namespace = event.metadata?.namespace ?? event.involvedObject?.namespace ?? "-";
  const object = [event.involvedObject?.kind, event.involvedObject?.name].filter(Boolean).join("/") || "-";
  const reason = event.reason ?? "-";
  const count = event.count && event.count > 1 ? ` (x${event.count})` : "";
  const message = (event.message ?? "").trim();
  return `- [${namespace}] ${object}: ${reason}${count} - ${message}`;
}

/**
 * List `type=Warning` events, most recent first, capped to {@link EVENT_CAP}.
 * A cluster health signal for questions like "what pods are failing and why?".
 */
export async function runWarningEvents(client: WarningEventsClient, input: WarningEventsInput): Promise<string> {
  const { namespace } = input;
  const fieldSelector = "type=Warning";

  const list = namespace
    ? await client.core.listNamespacedEvent({ namespace, fieldSelector })
    : await client.core.listEventForAllNamespaces({ fieldSelector });

  const items = Array.isArray(list.items) ? list.items : [];
  if (items.length === 0) {
    return `No warning events found${namespace ? ` in namespace "${namespace}"` : ""}.`;
  }

  const sorted = [...items].sort((a, b) => eventTime(b) - eventTime(a));
  const truncated = sorted.length > EVENT_CAP;
  const page = truncated ? sorted.slice(0, EVENT_CAP) : sorted;

  const header = `${sorted.length} warning event(s)${namespace ? ` in namespace "${namespace}"` : " across all namespaces"}:`;
  const body = page.map(formatEvent).join("\n");
  const note = truncated ? `\n... showing the ${EVENT_CAP} most recent of ${sorted.length}.` : "";
  return `${header}\n${body}${note}`;
}
