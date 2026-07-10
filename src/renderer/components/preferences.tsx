/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { Renderer } from "@freelensapp/extensions";
import { useState } from "react";
import { PreferencesStore } from "../../common/preferences-store";
import { MODEL_CHOICES } from "../../common/protocol";
import styles from "./preferences.module.scss";
import { Styles } from "./styles";

import type { ChangeEvent } from "react";

const { Input, Switch, SubTitle } = Renderer.Component;

function store(): PreferencesStore {
  return PreferencesStore.getInstanceOrCreate<PreferencesStore>();
}

/** The preferences page body: all Freelens for Claude settings. */
export function PreferencesInput() {
  const prefs = store();
  const [claudeCodePath, setClaudeCodePath] = useState(prefs.claudeCodePath);
  const [defaultModel, setDefaultModel] = useState(prefs.defaultModel);
  const [customAgentRules, setCustomAgentRules] = useState(prefs.customAgentRules);
  const [podLogsRequireApproval, setPodLogsRequireApproval] = useState(prefs.podLogsRequireApproval);
  const [podLogsTailLines, setPodLogsTailLines] = useState(String(prefs.podLogsTailLines));
  const [mcpEnabled, setMcpEnabled] = useState(prefs.mcpEnabled);
  const [mcpConfiguration, setMcpConfiguration] = useState(prefs.mcpConfiguration);
  const [subagentsEnabled, setSubagentsEnabled] = useState(prefs.subagentsEnabled);
  const [promptShortcuts, setPromptShortcuts] = useState(prefs.promptShortcuts);

  const onPathChange = (value: string) => {
    setClaudeCodePath(value);
    prefs.claudeCodePath = value.trim();
  };

  const onModelChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    setDefaultModel(value);
    prefs.defaultModel = value;
  };

  const onRulesBlur = () => {
    // Commit the draft only on blur to avoid caret jumps while typing.
    prefs.customAgentRules = customAgentRules;
  };

  const onApprovalChange = (checked: boolean) => {
    setPodLogsRequireApproval(checked);
    prefs.podLogsRequireApproval = checked;
  };

  const onTailLinesChange = (value: string) => {
    setPodLogsTailLines(value);
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) prefs.podLogsTailLines = parsed;
  };

  const onMcpEnabledChange = (checked: boolean) => {
    setMcpEnabled(checked);
    prefs.mcpEnabled = checked;
  };

  const onMcpConfigurationBlur = () => {
    // Commit the draft only on blur to avoid caret jumps while typing.
    prefs.mcpConfiguration = mcpConfiguration;
  };

  const onSubagentsEnabledChange = (checked: boolean) => {
    setSubagentsEnabled(checked);
    prefs.subagentsEnabled = checked;
  };

  const onPromptShortcutsBlur = () => {
    // Commit the draft only on blur to avoid caret jumps while typing.
    prefs.promptShortcuts = promptShortcuts;
  };

  return (
    <section className={styles.preferences}>
      <Styles />
      <div className={styles.field}>
        <SubTitle title="Claude Code executable path" />
        <Input theme="round-black" value={claudeCodePath} onChange={onPathChange} className={styles.mono} />
        <div className={styles.hint}>Absolute path to the claude binary. Leave empty to auto-detect.</div>
      </div>

      <div className={styles.field}>
        <SubTitle title="Default model" />
        <select className={styles.select} value={defaultModel} onChange={onModelChange}>
          <option value="">Default</option>
          {MODEL_CHOICES.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
        <div className={styles.hint}>Used for clusters that have not picked a model in the chat.</div>
      </div>

      <div className={styles.field}>
        <SubTitle title="Custom agent rules" />
        <textarea
          className={styles.textarea}
          value={customAgentRules}
          rows={4}
          onChange={(event) => setCustomAgentRules(event.target.value)}
          onBlur={onRulesBlur}
        />
        <div className={styles.hint}>Extra rules appended to the system prompt at the start of every new session.</div>
      </div>

      <div className={styles.field}>
        <Switch checked={podLogsRequireApproval} onChange={onApprovalChange}>
          Require approval before reading pod logs
        </Switch>
        <div className={styles.hint}>
          Pod logs can contain secrets or personal data. When enabled, the agent asks for confirmation before reading
          container logs.
        </div>
      </div>

      <div className={styles.field}>
        <SubTitle title="Default tail lines" />
        <Input
          theme="round-black"
          type="number"
          value={podLogsTailLines}
          onChange={onTailLinesChange}
          className={styles.number}
        />
        <div className={styles.hint}>Lines read from the end of the log when the agent does not request an amount.</div>
      </div>

      <div className={styles.field}>
        <Switch checked={mcpEnabled} onChange={onMcpEnabledChange}>
          Enable MCP servers
        </Switch>
        <div className={styles.hint}>
          Extra MCP servers are started with each new session and their tools always require approval.
        </div>
      </div>

      <div className={mcpEnabled ? styles.field : `${styles.field} ${styles.dimmed}`}>
        <SubTitle title="MCP JSON configuration" />
        <textarea
          className={`${styles.textarea} ${styles.mono}`}
          value={mcpConfiguration}
          rows={8}
          onChange={(event) => setMcpConfiguration(event.target.value)}
          onBlur={onMcpConfigurationBlur}
        />
        <div className={styles.hint}>
          Claude Desktop format: an mcpServers object with command/args or url entries. Applied at the next new chat.
        </div>
      </div>

      <div className={styles.field}>
        <Switch checked={subagentsEnabled} onChange={onSubagentsEnabledChange}>
          Enable analysis subagent
        </Switch>
        <div className={styles.hint}>
          Lets Claude delegate deep read-only investigations to a separate context. Applied at the next new chat.
        </div>
      </div>

      <div className={styles.field}>
        <SubTitle title="Prompt shortcuts" />
        <textarea
          className={`${styles.textarea} ${styles.mono}`}
          value={promptShortcuts}
          rows={4}
          onChange={(event) => setPromptShortcuts(event.target.value)}
          onBlur={onPromptShortcutsBlur}
        />
        <div className={styles.hint}>
          JSON array of {'{ "title", "prompt" }'} shown as chips above the message input.
        </div>
      </div>
    </section>
  );
}

/** The empty hint slot; the page body carries its own per-field hints. */
export function PreferencesHint() {
  return <span />;
}
