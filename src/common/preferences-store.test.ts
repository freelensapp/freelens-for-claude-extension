/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_MCP_CONFIGURATION, DEFAULT_POD_LOGS_TAIL_LINES, PreferencesStore } from "./preferences-store";

describe("PreferencesStore", () => {
  it("starts with the documented defaults", () => {
    const store = new PreferencesStore();
    expect(store.podLogsRequireApproval).toBe(true);
    expect(store.podLogsTailLines).toBe(DEFAULT_POD_LOGS_TAIL_LINES);
    expect(store.customAgentRules).toBe("");
    expect(store.claudeCodePath).toBe("");
    expect(store.defaultModel).toBe("");
    expect(store.mcpEnabled).toBe(false);
    expect(store.mcpConfiguration).toBe(DEFAULT_MCP_CONFIGURATION);
    expect(store.subagentsEnabled).toBe(true);
    expect(store.promptShortcuts).toBe("[]");
  });

  it("round-trips through toJSON/fromStore", () => {
    const store = new PreferencesStore();
    store.podLogsRequireApproval = false;
    store.podLogsTailLines = 250;
    store.customAgentRules = "be concise";
    store.claudeCodePath = "/usr/local/bin/claude";
    store.defaultModel = "haiku";
    store.mcpEnabled = true;
    store.mcpConfiguration = '{ "mcpServers": { "x": { "command": "foo" } } }';
    store.subagentsEnabled = false;
    store.promptShortcuts = '[{ "title": "Nodes", "prompt": "List nodes" }]';

    const restored = new PreferencesStore();
    restored.fromStore(store.toJSON());
    expect(restored.podLogsRequireApproval).toBe(false);
    expect(restored.podLogsTailLines).toBe(250);
    expect(restored.customAgentRules).toBe("be concise");
    expect(restored.claudeCodePath).toBe("/usr/local/bin/claude");
    expect(restored.defaultModel).toBe("haiku");
    expect(restored.mcpEnabled).toBe(true);
    expect(restored.mcpConfiguration).toBe('{ "mcpServers": { "x": { "command": "foo" } } }');
    expect(restored.subagentsEnabled).toBe(false);
    expect(restored.promptShortcuts).toBe('[{ "title": "Nodes", "prompt": "List nodes" }]');
  });

  it("fromStore fills missing fields with defaults", () => {
    const store = new PreferencesStore();
    store.fromStore({ defaultModel: "opus" });
    expect(store.defaultModel).toBe("opus");
    expect(store.podLogsRequireApproval).toBe(true);
    expect(store.podLogsTailLines).toBe(DEFAULT_POD_LOGS_TAIL_LINES);
  });
});
