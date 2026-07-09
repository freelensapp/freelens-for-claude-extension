/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Common } from "@freelensapp/extensions";
import { makeObservable, observable } from "mobx";

// Extension-wide preferences, created by both processes like the BridgeStore and
// synced between them. The provider-neutral items (pod-logs approval, tail lines,
// custom agent rules) carry over from the original AI extension; the executable
// path override and default model are Claude-specific additions.

/** Default number of log lines read when the model does not request an amount. */
export const DEFAULT_POD_LOGS_TAIL_LINES = 1000;

export interface PreferencesStoreModel {
  /** Require a user approval before the agent reads pod logs. */
  podLogsRequireApproval: boolean;
  /** Lines read from the end of the log when the agent does not request an amount. */
  podLogsTailLines: number;
  /** Extra rules appended to the system prompt at the start of every new session. */
  customAgentRules: string;
  /** Absolute path to the claude binary; empty means auto-detect. */
  claudeCodePath: string;
  /** Default model alias for clusters that have not picked one; empty means default. */
  defaultModel: string;
  /** Start user-configured MCP servers alongside the built-in cluster tools. */
  mcpEnabled: boolean;
  /** Claude-Desktop-style MCP configuration JSON; applied at the next new session. */
  mcpConfiguration: string;
  /** Let Claude delegate deep read-only investigations to the cluster-analyzer subagent. */
  subagentsEnabled: boolean;
}

/**
 * The narrow read-only view of the preferences store the session manager and
 * detection depend on. Declaring it here keeps those modules free of the
 * host-only `ExtensionStore` base class and lets tests substitute a plain object.
 */
export interface PreferencesState {
  readonly podLogsRequireApproval: boolean;
  readonly podLogsTailLines: number;
  readonly customAgentRules: string;
  readonly claudeCodePath: string;
  readonly defaultModel: string;
  readonly mcpEnabled: boolean;
  readonly mcpConfiguration: string;
  readonly subagentsEnabled: boolean;
}

/** Default MCP configuration: an empty Claude-Desktop-style `mcpServers` object. */
export const DEFAULT_MCP_CONFIGURATION = '{\n  "mcpServers": {}\n}';

const defaults: PreferencesStoreModel = {
  podLogsRequireApproval: true,
  podLogsTailLines: DEFAULT_POD_LOGS_TAIL_LINES,
  customAgentRules: "",
  claudeCodePath: "",
  defaultModel: "",
  mcpEnabled: false,
  mcpConfiguration: DEFAULT_MCP_CONFIGURATION,
  subagentsEnabled: true,
};

export class PreferencesStore extends Common.Store.ExtensionStore<PreferencesStoreModel> implements PreferencesState {
  podLogsRequireApproval = defaults.podLogsRequireApproval;
  podLogsTailLines = defaults.podLogsTailLines;
  customAgentRules = defaults.customAgentRules;
  claudeCodePath = defaults.claudeCodePath;
  defaultModel = defaults.defaultModel;
  mcpEnabled = defaults.mcpEnabled;
  mcpConfiguration = defaults.mcpConfiguration;
  subagentsEnabled = defaults.subagentsEnabled;

  constructor() {
    super({
      configName: "preferences-store",
      defaults,
    });
    makeObservable(this, {
      podLogsRequireApproval: observable,
      podLogsTailLines: observable,
      customAgentRules: observable,
      claudeCodePath: observable,
      defaultModel: observable,
      mcpEnabled: observable,
      mcpConfiguration: observable,
      subagentsEnabled: observable,
    });
  }

  fromStore(model: Partial<PreferencesStoreModel>): void {
    this.podLogsRequireApproval = model.podLogsRequireApproval ?? defaults.podLogsRequireApproval;
    this.podLogsTailLines = model.podLogsTailLines ?? defaults.podLogsTailLines;
    this.customAgentRules = model.customAgentRules ?? defaults.customAgentRules;
    this.claudeCodePath = model.claudeCodePath ?? defaults.claudeCodePath;
    this.defaultModel = model.defaultModel ?? defaults.defaultModel;
    this.mcpEnabled = model.mcpEnabled ?? defaults.mcpEnabled;
    this.mcpConfiguration = model.mcpConfiguration ?? defaults.mcpConfiguration;
    this.subagentsEnabled = model.subagentsEnabled ?? defaults.subagentsEnabled;
  }

  toJSON(): PreferencesStoreModel {
    return {
      podLogsRequireApproval: this.podLogsRequireApproval,
      podLogsTailLines: this.podLogsTailLines,
      customAgentRules: this.customAgentRules,
      claudeCodePath: this.claudeCodePath,
      defaultModel: this.defaultModel,
      mcpEnabled: this.mcpEnabled,
      mcpConfiguration: this.mcpConfiguration,
      subagentsEnabled: this.subagentsEnabled,
    };
  }
}
