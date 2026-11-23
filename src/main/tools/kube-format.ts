/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { stringify } from "yaml";

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
  return stringify(value);
}

/** A literal on the right side of a filter comparison. */
type FilterLiteral = string | number | boolean | null;

type FilterOperator = "==" | "!=" | "<" | "<=" | ">" | ">=";

/** One step of a parsed field selector. */
type Segment =
  | { type: "key"; key: string }
  | { type: "wildcard" }
  | { type: "index"; index: number }
  | { type: "filter"; path: string[]; operator?: FilterOperator; value?: FilterLiteral };

/** Marker for "this selector did not match" so we can skip it during merge. */
const NO_MATCH = Symbol("no-match");

/** Index of the "]" that closes the "[" at `open`, skipping quoted text and nested brackets. */
function findClosingBracket(source: string, open: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let k = open; k < source.length; k++) {
    const ch = source[k];
    if (quote) {
      if (ch === "\\") k++;
      else if (ch === quote) quote = undefined;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]" && --depth === 0) {
      return k;
    }
  }
  return -1;
}

function parseFilterLiteral(text: string, raw: string): FilterLiteral {
  if (text.length >= 2 && (text[0] === "'" || text[0] === '"') && text.at(-1) === text[0]) return text.slice(1, -1);
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  const number = Number(text);
  if (text !== "" && Number.isFinite(number)) return number;
  throw new Error(`invalid filter value "${text}" in "${raw}"`);
}

/** Parse `?(@.path OP literal)` or `?(@.path)`, the filter expressions of kubectl's JSONPath. */
function parseFilter(inner: string, raw: string): Segment {
  let expression = inner.slice(1).trim();
  if (expression.startsWith("(") && expression.endsWith(")")) expression = expression.slice(1, -1).trim();
  const match = /^@((?:\.[^.\s=!<>[\]]+|\[(?:'[^']*'|"[^"]*")\])*)\s*(?:(==|!=|<=|>=|<|>)\s*(.+))?$/s.exec(expression);
  if (!match) throw new Error(`unsupported filter "${inner}" in "${raw}"`);
  const [, pathText, operator, valueText] = match;
  const path: string[] = [];
  if (pathText) {
    for (const segment of parseSelector(pathText)) {
      if (segment.type !== "key") throw new Error(`unsupported filter path "${pathText}" in "${raw}"`);
      path.push(segment.key);
    }
  }
  if (!operator) return { type: "filter", path };
  return {
    type: "filter",
    path,
    operator: operator as FilterOperator,
    value: parseFilterLiteral(valueText.trim(), raw),
  };
}

/**
 * Parse a JSONPath-subset selector into segments. Supports dot-separated keys,
 * `[*]` array wildcards, numeric (incl. negative) indexes, bracketed quoted
 * keys for dotted label keys, and `[?(@.key == 'value')]` filters. Tolerates a
 * leading `$.` and a `{...}` wrapper. Throws a readable error on malformed input.
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
      const end = findClosingBracket(source, i);
      if (end === -1) throw new Error(`unbalanced "[" in "${raw}"`);
      const inner = source.slice(i + 1, end).trim();
      if (inner === "*") {
        segments.push({ type: "wildcard" });
      } else if (inner.startsWith("?")) {
        segments.push(parseFilter(inner, raw));
      } else if ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"'))) {
        segments.push({ type: "key", key: inner.slice(1, -1) });
      } else {
        const index = Number(inner);
        if (inner === "" || !Number.isInteger(index)) throw new Error(`invalid array index "${inner}" in "${raw}"`);
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

function filterMatches(element: unknown, segment: Extract<Segment, { type: "filter" }>): boolean {
  let value: unknown = element;
  for (const key of segment.path) {
    if (!isPlainObject(value) || !(key in value)) {
      value = undefined;
      break;
    }
    value = value[key];
  }
  const expected = segment.value;
  switch (segment.operator) {
    case undefined:
      return value !== undefined && value !== null;
    case "==":
      return value === expected;
    case "!=":
      return value !== expected;
  }
  const comparable =
    (typeof value === "number" && typeof expected === "number") ||
    (typeof value === "string" && typeof expected === "string");
  if (!comparable) return false;
  const [left, right] = [value, expected] as [number | string, number | string];
  switch (segment.operator) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
  }
}

/**
 * Extract the nested value at `segments`, rebuilding the surrounding structure.
 * An array element stays at its own index, leaving holes for the elements that
 * were not selected, so that selectors on one array merge element by element;
 * `compact` removes the holes once all selectors are merged.
 */
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

  if (!Array.isArray(value)) return NO_MATCH;

  if (seg.type === "index") {
    const index = seg.index < 0 ? value.length + seg.index : seg.index;
    if (index < 0 || index >= value.length) return NO_MATCH;
    const child = extract(value[index], rest);
    if (child === NO_MATCH) return NO_MATCH;
    const out: unknown[] = [];
    out[index] = child;
    return out;
  }

  // wildcard or filter
  const out: unknown[] = [];
  let matched = false;
  value.forEach((element, index) => {
    if (seg.type === "filter" && !filterMatches(element, seg)) return;
    const child = extract(element, rest);
    if (child === NO_MATCH) return;
    out[index] = child;
    matched = true;
  });
  return matched ? out : NO_MATCH;
}

/** Remove the holes that `extract` leaves in arrays. */
function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter(() => true).map(compact);
  if (isPlainObject(value))
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, compact(child)]));
  return value;
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
    const result = a.slice();
    b.forEach((element, i) => {
      result[i] = i in a ? deepMerge(a[i], element) : element;
    });
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
  return compact(result) as Record<string, unknown>;
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
