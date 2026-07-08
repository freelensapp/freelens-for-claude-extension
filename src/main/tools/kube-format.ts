/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { dumpYaml } from "@kubernetes/client-node";

/** Default cap for pod-log output, in bytes. */
export const LOG_BYTE_CAP = 50 * 1024;

/** Default number of list items returned before truncating. */
export const DEFAULT_LIST_LIMIT = 50;

/**
 * Recursively remove `metadata.managedFields` from a resource (or every item of
 * a list), which is noisy and never useful to the model. Mutates a shallow copy
 * so the caller's object is left intact.
 */
export function stripManagedFields<T>(resource: T): T {
  if (Array.isArray(resource)) {
    return resource.map((item) => stripManagedFields(item)) as unknown as T;
  }
  if (resource && typeof resource === "object") {
    const obj = resource as Record<string, unknown>;
    const metadata = obj.metadata as Record<string, unknown> | undefined;
    if (metadata && typeof metadata === "object" && "managedFields" in metadata) {
      const { managedFields, ...rest } = metadata;
      void managedFields;
      return { ...obj, metadata: rest } as T;
    }
  }
  return resource;
}

/** Serialize a resource or list of resources to YAML. */
export function toYaml(value: unknown): string {
  return dumpYaml(value);
}

/**
 * Truncate `text` to at most `maxBytes` (UTF-8), appending a note when content
 * was dropped so the model knows the output is partial.
 */
export function truncateBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  const kept = buf.subarray(0, maxBytes).toString("utf8");
  return `${kept}\n\n... [output truncated: ${buf.byteLength} bytes exceeded the ${maxBytes}-byte cap]`;
}
