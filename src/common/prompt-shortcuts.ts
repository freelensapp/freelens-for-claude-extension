/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Quick-prompt chips rendered above the chat input: a fixed set of built-in
// prompts plus any user-defined entries parsed from the `promptShortcuts`
// preference. Kept renderer-free so the parser can be unit-tested directly.

/** A single quick-prompt chip: a short title and the prompt it sends. */
export interface PromptShortcut {
  title: string;
  prompt: string;
}

/** The always-present built-in chips. */
export const BUILTIN_PROMPT_SHORTCUTS: readonly PromptShortcut[] = [
  {
    title: "Cluster health",
    prompt: "Give me an overall health check of this cluster: nodes, failing workloads, recent warning events.",
  },
  {
    title: "Failing pods",
    prompt: "Find pods that are failing or restarting and explain why.",
  },
  {
    title: "Recent warnings",
    prompt: "Summarize recent warning events and what they mean.",
  },
];

/**
 * Parse the `promptShortcuts` preference (a JSON array of `{ title, prompt }`).
 * Entries missing either string field are skipped; invalid JSON or a non-array
 * value yields no custom chips. Never throws.
 */
export function parsePromptShortcuts(json: string): PromptShortcut[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const shortcuts: PromptShortcut[] = [];
  for (const entry of parsed) {
    if (entry && typeof entry === "object") {
      const { title, prompt } = entry as { title?: unknown; prompt?: unknown };
      if (typeof title === "string" && typeof prompt === "string") {
        shortcuts.push({ title, prompt });
      }
    }
  }
  return shortcuts;
}
