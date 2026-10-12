/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// The provider and authentication settings of the user's Claude Code, taken
// from its user settings file. Sessions run with `settingSources: []`, which
// keeps the user's permissions, hooks, plugins and MCP servers out of the
// chat, and with it the keys that tell Claude Code which API provider to use
// and how to authenticate to it (Bedrock, Vertex, a gateway, an API key
// helper). Only those keys are taken from the file and passed back through
// the SDK's `settings` option, so a provider that works in the terminal works
// in the chat without loosening the isolation. Its `model` is taken too, as
// the default of a chat that has no model selected. The file is read at every
// session start, so a change applies to the next session; a missing file is
// normal, and an unreadable or invalid one is skipped with a warning that
// never includes its contents, which can carry tokens and keys.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Common } from "@freelensapp/extensions";

import type { Settings } from "@anthropic-ai/claude-agent-sdk";

/** The commands and scripts that produce credentials for the provider or the proxy in front of it. */
const HELPER_KEYS = [
  "apiKeyHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "gcpAuthRefresh",
  "proxyAuthHelper",
] as const satisfies readonly (keyof Settings)[];

/** The keys of the user settings file that select the provider and authenticate to it. */
export type ProviderSettings = Pick<Settings, "env" | "modelOverrides" | (typeof HELPER_KEYS)[number]>;

/** What a session takes from the user settings file of Claude Code. */
export interface UserClaudeSettings {
  /** The keys passed to the SDK's `settings` option; empty when the file has none. */
  settings: ProviderSettings;
  /**
   * The file's `model`, the model of a session whose chat has none selected
   * (neither in the model selector nor in the default model preference). A
   * third-party provider can need a model id of its own.
   */
  model?: string;
}

/** The configuration directory of Claude Code: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return dir || join(home, ".claude");
}

/** The user settings file of Claude Code. */
export function userSettingsPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(claudeConfigDir(env, home), "settings.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `env` block, with the entries whose value is not a string, a number or a
 * boolean dropped; numbers and booleans become strings, as environment
 * variables are. `undefined` when nothing is left.
 */
function pickEnv(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const env: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") env[name] = String(item);
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

/** A map of strings, with the other entries dropped; `undefined` when nothing is left. */
function pickStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Take the provider and authentication keys and the model from the parsed
 * settings file. Every other key is dropped, and so is one of these with the
 * wrong type.
 */
export function pickUserSettings(raw: unknown): UserClaudeSettings {
  const settings: ProviderSettings = {};
  if (!isRecord(raw)) return { settings };

  const env = pickEnv(raw.env);
  if (env) settings.env = env;
  const modelOverrides = pickStringRecord(raw.modelOverrides);
  if (modelOverrides) settings.modelOverrides = modelOverrides;
  for (const key of HELPER_KEYS) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) settings[key] = value;
  }
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  return model ? { settings, model } : { settings };
}

/**
 * Read the user settings file of Claude Code and take its provider and
 * authentication keys. Never throws: a missing file gives nothing, an
 * unreadable or invalid one gives nothing and logs a warning that names the
 * file but not its contents.
 */
export function readUserSettings(path: string = userSettingsPath()): UserClaudeSettings {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      Common.logger.warn(`[for-claude] could not read ${path} (${code ?? "unknown error"}), going on without it`);
    }
    return { settings: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The parser's message quotes the text around the error, which can be a token.
    Common.logger.warn(`[for-claude] ${path} is not valid JSON, going on without it`);
    return { settings: {} };
  }
  if (!isRecord(parsed)) {
    Common.logger.warn(`[for-claude] ${path} is not a JSON object, going on without it`);
    return { settings: {} };
  }
  return pickUserSettings(parsed);
}
