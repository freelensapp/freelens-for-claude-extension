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

/** One step of a parsed field selector. */
type Segment = { type: "key"; key: string } | { type: "wildcard" } | { type: "index"; index: number };

/** Marker for "this selector did not match" so we can skip it during merge. */
const NO_MATCH = Symbol("no-match");

/**
 * Parse a JSONPath-subset selector into segments. Supports dot-separated keys,
 * `[*]` array wildcards, numeric (incl. negative) indexes, and bracketed quoted
 * keys for dotted label keys. Tolerates a leading `$.` and a `{...}` wrapper.
 * Throws a readable error on malformed input.
 */
function parseSelector(raw: string): Segment[] {
  let source = raw.trim();
  if (source.startsWith("{") && source.endsWith("}")) source = source.slice(1, -1).trim();
  if (source.startsWith("$")) source = source.slice(1);

  const segments: Segment[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ".") {
      i++;
      continue;
    }
    if (ch === "[") {
      const end = source.indexOf("]", i);
      if (end === -1) throw new Error(`unbalanced "[" in "${raw}"`);
      const inner = source.slice(i + 1, end).trim();
      if (inner === "*") {
        segments.push({ type: "wildcard" });
      } else if ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"'))) {
        segments.push({ type: "key", key: inner.slice(1, -1) });
      } else {
        const index = Number(inner);
        if (!Number.isInteger(index)) throw new Error(`invalid array index "${inner}" in "${raw}"`);
        segments.push({ type: "index", index });
      }
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < source.length && source[j] !== "." && source[j] !== "[") j++;
    const key = source.slice(i, j);
    if (key) segments.push({ type: "key", key });
    i = j;
  }

  if (segments.length === 0) throw new Error(`empty selector "${raw}"`);
  return segments;
}

/** Extract the nested value at `segments`, rebuilding the surrounding structure. */
function extract(value: unknown, segments: Segment[]): unknown | typeof NO_MATCH {
  if (segments.length === 0) return structuredClone(value);
  const [seg, ...rest] = segments;

  if (seg.type === "key") {
    if (value && typeof value === "object" && !Array.isArray(value) && seg.key in (value as object)) {
      const child = extract((value as Record<string, unknown>)[seg.key], rest);
      return child === NO_MATCH ? NO_MATCH : { [seg.key]: child };
    }
    return NO_MATCH;
  }

  if (seg.type === "index") {
    if (Array.isArray(value)) {
      const index = seg.index < 0 ? value.length + seg.index : seg.index;
      if (index >= 0 && index < value.length) {
        const child = extract(value[index], rest);
        return child === NO_MATCH ? NO_MATCH : [child];
      }
    }
    return NO_MATCH;
  }

  // wildcard
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const element of value) {
      const child = extract(element, rest);
      if (child !== NO_MATCH) out.push(child);
    }
    return out.length > 0 ? out : NO_MATCH;
  }
  return NO_MATCH;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Deep-merge two extracted partials so multiple selectors accumulate into one object. */
function deepMerge(a: unknown, b: unknown): unknown {
  if (isPlainObject(a) && isPlainObject(b)) {
    const result: Record<string, unknown> = { ...a };
    for (const key of Object.keys(b)) {
      result[key] = key in a ? deepMerge(a[key], b[key]) : b[key];
    }
    return result;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const result = [...a];
    for (let i = 0; i < b.length; i++) {
      result[i] = i < a.length ? deepMerge(a[i], b[i]) : b[i];
    }
    return result;
  }
  return b;
}

/**
 * Project `object` down to just the paths named by `selectors`, preserving the
 * nested structure. Mirrors the original extension's `field-filter.ts` subset.
 * Throws a readable error when a selector is malformed.
 */
export function selectFields(object: unknown, selectors: string[]): Record<string, unknown> {
  let result: Record<string, unknown> = {};
  for (const selector of selectors) {
    let segments: Segment[];
    try {
      segments = parseSelector(selector);
    } catch (error) {
      throw new Error(
        `Invalid field selector "${selector}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const extracted = extract(object, segments);
    if (extracted !== NO_MATCH) result = deepMerge(result, extracted) as Record<string, unknown>;
  }
  return result;
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
