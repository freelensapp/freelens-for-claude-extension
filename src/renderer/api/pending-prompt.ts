/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// A tiny module-scoped handoff between the "Ask Claude" kube object menu entries
// and the chat page. Both live in the single renderer process, so a module
// variable is enough: the menu entry stores a prompt and navigates to the chat
// page, which consumes the prompt once when it mounts.

let pending: string | undefined;

export const pendingPrompt = {
  /** Store a prompt to be picked up by the chat page on its next mount. */
  set(prompt: string): void {
    pending = prompt;
  },
  /** Read and clear the pending prompt, if any. */
  consume(): string | undefined {
    const value = pending;
    pending = undefined;
    return value;
  },
};
