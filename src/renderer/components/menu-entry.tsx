/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Renderer } from "@freelensapp/extensions";
import { pendingPrompt } from "../api/pending-prompt";
import { ClaudeIcon } from "../icons/claude-icon";

const { MenuItem } = Renderer.Component;

type KubeObject = Renderer.K8sApi.KubeObject;

interface MenuItemProps {
  object: KubeObject;
  toolbar?: boolean;
}

/**
 * Build an "Ask Claude" kube object menu item for one kind. `buildPrompt`
 * returns the analysis prompt for the selected object, or `undefined` when the
 * entry should not appear (e.g. an event with no message). `navigate` opens the
 * chat page after the prompt has been handed off.
 */
export function createAskClaudeMenuItem(buildPrompt: (object: KubeObject) => string | undefined, navigate: () => void) {
  return function AskClaudeMenuItem({ object, toolbar }: MenuItemProps) {
    const prompt = buildPrompt(object);
    if (!prompt) return null;
    const onClick = () => {
      pendingPrompt.set(prompt);
      navigate();
    };
    return (
      <MenuItem onClick={onClick}>
        <ClaudeIcon interactive={toolbar} tooltip={toolbar ? "Ask Claude" : undefined} />
        <span className="title">Ask Claude</span>
      </MenuItem>
    );
  };
}
