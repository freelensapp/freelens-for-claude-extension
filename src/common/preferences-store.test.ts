/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_POD_LOGS_TAIL_LINES, PreferencesStore } from "./preferences-store";

describe("PreferencesStore", () => {
  it("starts with the documented defaults", () => {
    const store = new PreferencesStore();
    expect(store.podLogsRequireApproval).toBe(true);
    expect(store.podLogsTailLines).toBe(DEFAULT_POD_LOGS_TAIL_LINES);
    expect(store.customAgentRules).toBe("");
    expect(store.claudeCodePath).toBe("");
    expect(store.defaultModel).toBe("");
  });

  it("round-trips through toJSON/fromStore", () => {
    const store = new PreferencesStore();
    store.podLogsRequireApproval = false;
    store.podLogsTailLines = 250;
    store.customAgentRules = "be concise";
    store.claudeCodePath = "/usr/local/bin/claude";
    store.defaultModel = "haiku";

    const restored = new PreferencesStore();
    restored.fromStore(store.toJSON());
    expect(restored.podLogsRequireApproval).toBe(false);
    expect(restored.podLogsTailLines).toBe(250);
    expect(restored.customAgentRules).toBe("be concise");
    expect(restored.claudeCodePath).toBe("/usr/local/bin/claude");
    expect(restored.defaultModel).toBe("haiku");
  });

  it("fromStore fills missing fields with defaults", () => {
    const store = new PreferencesStore();
    store.fromStore({ defaultModel: "opus" });
    expect(store.defaultModel).toBe("opus");
    expect(store.podLogsRequireApproval).toBe(true);
    expect(store.podLogsTailLines).toBe(DEFAULT_POD_LOGS_TAIL_LINES);
  });
});
