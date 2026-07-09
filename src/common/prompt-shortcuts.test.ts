/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { BUILTIN_PROMPT_SHORTCUTS, parsePromptShortcuts } from "./prompt-shortcuts";

describe("parsePromptShortcuts", () => {
  it("parses a valid array of title/prompt entries", () => {
    const json = '[{ "title": "Nodes", "prompt": "List nodes" }, { "title": "Ns", "prompt": "List namespaces" }]';
    expect(parsePromptShortcuts(json)).toEqual([
      { title: "Nodes", prompt: "List nodes" },
      { title: "Ns", prompt: "List namespaces" },
    ]);
  });

  it("returns no chips for invalid JSON", () => {
    expect(parsePromptShortcuts("not json")).toEqual([]);
    expect(parsePromptShortcuts("")).toEqual([]);
  });

  it("returns no chips for a non-array value", () => {
    expect(parsePromptShortcuts('{ "title": "x", "prompt": "y" }')).toEqual([]);
  });

  it("skips entries missing either the title or the prompt", () => {
    const json =
      '[{ "title": "Keep", "prompt": "ok" }, { "title": "NoPrompt" }, { "prompt": "NoTitle" }, ' +
      '{ "title": 1, "prompt": "bad" }, "string", null]';
    expect(parsePromptShortcuts(json)).toEqual([{ title: "Keep", prompt: "ok" }]);
  });

  it("keeps only the title and prompt strings, dropping extra fields", () => {
    const json = '[{ "title": "T", "prompt": "P", "extra": "drop me" }]';
    expect(parsePromptShortcuts(json)).toEqual([{ title: "T", prompt: "P" }]);
  });

  it("exposes the three built-in shortcuts", () => {
    expect(BUILTIN_PROMPT_SHORTCUTS.map((shortcut) => shortcut.title)).toEqual([
      "Cluster health",
      "Failing pods",
      "Recent warnings",
    ]);
  });
});
