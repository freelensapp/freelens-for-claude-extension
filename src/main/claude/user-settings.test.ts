/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Common } from "@freelensapp/extensions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeConfigDir, pickUserSettings, readUserSettings, userSettingsPath } from "./user-settings";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "for-claude-settings-"));
  vi.mocked(Common.logger.warn).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function writeSettings(text: string): string {
  const path = join(dir, "settings.json");
  writeFileSync(path, text);
  return path;
}

describe("claudeConfigDir", () => {
  it("is ~/.claude without CLAUDE_CONFIG_DIR", () => {
    expect(claudeConfigDir({}, "/home/user")).toBe(join("/home/user", ".claude"));
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "  " }, "/home/user")).toBe(join("/home/user", ".claude"));
  });

  it("is CLAUDE_CONFIG_DIR when set", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/etc/claude-user" }, "/home/user")).toBe("/etc/claude-user");
  });

  it("names settings.json in that directory", () => {
    expect(userSettingsPath({}, "/home/user")).toBe(join("/home/user", ".claude", "settings.json"));
    expect(userSettingsPath({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/user")).toBe(join("/cfg", "settings.json"));
  });

  it("reads the file in CLAUDE_CONFIG_DIR by default", () => {
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config", "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_USE_VERTEX: "1" } }));
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(dir, "config"));
    expect(readUserSettings().settings).toEqual({ env: { CLAUDE_CODE_USE_VERTEX: "1" } });
  });
});

describe("pickUserSettings", () => {
  it("keeps the provider and authentication keys", () => {
    const settings = {
      env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "eu-central-1" },
      modelOverrides: { "claude-opus-4-6": "arn:aws:bedrock:eu-central-1:1:inference-profile/opus" },
      apiKeyHelper: "/usr/local/bin/key-helper",
      awsAuthRefresh: "aws sso login",
      awsCredentialExport: "/usr/local/bin/aws-creds",
      gcpAuthRefresh: "gcloud auth application-default login",
      proxyAuthHelper: "/usr/local/bin/proxy-auth",
    };
    expect(pickUserSettings(settings).settings).toEqual(settings);
  });

  it("drops every other key", () => {
    const { settings } = pickUserSettings({
      env: { ANTHROPIC_BASE_URL: "https://gateway.example" },
      permissions: { allow: ["mcp__freelens-kube__*"], defaultMode: "bypassPermissions" },
      hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "true" }] }] },
      mcpServers: { other: { command: "other" } },
      enabledPlugins: { "plugin@market": true },
      statusLine: { type: "command", command: "status" },
      outputStyle: "Explanatory",
      otelHeadersHelper: "/usr/local/bin/otel",
      forceLoginMethod: "claudeai",
    });
    expect(settings).toEqual({ env: { ANTHROPIC_BASE_URL: "https://gateway.example" } });
  });

  it("ignores keys with the wrong type", () => {
    const { settings } = pickUserSettings({
      env: ["CLAUDE_CODE_USE_BEDROCK=1"],
      modelOverrides: "opus",
      apiKeyHelper: 42,
      awsAuthRefresh: { command: "aws sso login" },
      awsCredentialExport: "",
      gcpAuthRefresh: null,
      proxyAuthHelper: true,
    });
    expect(settings).toEqual({});
  });

  it("drops env and modelOverrides entries with the wrong type and stringifies scalars in env", () => {
    const { settings } = pickUserSettings({
      env: { CLAUDE_CODE_USE_BEDROCK: 1, DISABLE_TELEMETRY: true, AWS_PROFILE: "work", NESTED: { a: "b" }, NONE: null },
      modelOverrides: { "claude-opus-4-6": "opus-profile", "claude-sonnet-4-6": 7 },
    });
    expect(settings).toEqual({
      env: { CLAUDE_CODE_USE_BEDROCK: "1", DISABLE_TELEMETRY: "true", AWS_PROFILE: "work" },
      modelOverrides: { "claude-opus-4-6": "opus-profile" },
    });
  });

  it("takes the model apart from the settings", () => {
    expect(pickUserSettings({ model: " sonnet ", env: { AWS_PROFILE: "work" } })).toEqual({
      settings: { env: { AWS_PROFILE: "work" } },
      model: "sonnet",
    });
  });

  it("ignores a model that is empty or not a string", () => {
    expect(pickUserSettings({ model: "" })).toEqual({ settings: {} });
    expect(pickUserSettings({ model: 4 })).toEqual({ settings: {} });
    expect(pickUserSettings({ model: ["sonnet"] })).toEqual({ settings: {} });
  });

  it("gives nothing for a value that is not an object", () => {
    expect(pickUserSettings(null).settings).toEqual({});
    expect(pickUserSettings([]).settings).toEqual({});
    expect(pickUserSettings("env").settings).toEqual({});
  });
});

describe("readUserSettings", () => {
  it("gives nothing for a missing file, without a warning", () => {
    expect(readUserSettings(join(dir, "settings.json"))).toEqual({ settings: {} });
    expect(Common.logger.warn).not.toHaveBeenCalled();
  });

  it("gives nothing for invalid JSON and warns once without the contents", () => {
    const path = writeSettings('{ "env": { "ANTHROPIC_AUTH_TOKEN": "sk-secret-token" ');
    expect(readUserSettings(path)).toEqual({ settings: {} });
    expect(Common.logger.warn).toHaveBeenCalledTimes(1);
    expect(Common.logger.warn).toHaveBeenCalledWith(`[for-claude] ${path} is not valid JSON, going on without it`);
  });

  it("gives nothing for JSON that is not an object and warns once", () => {
    const path = writeSettings('["env"]');
    expect(readUserSettings(path)).toEqual({ settings: {} });
    expect(Common.logger.warn).toHaveBeenCalledTimes(1);
  });

  it("gives nothing for an unreadable file and warns once", () => {
    // A directory in place of the file fails the read with EISDIR.
    const path = join(dir, "settings.json");
    mkdirSync(path);
    expect(readUserSettings(path)).toEqual({ settings: {} });
    expect(Common.logger.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Common.logger.warn).mock.calls[0]?.[0]).toContain("EISDIR");
  });

  it("takes the provider keys from a valid file", () => {
    const path = writeSettings(
      JSON.stringify({
        env: { CLAUDE_CODE_USE_ANTHROPIC_AWS: "1", ANTHROPIC_AUTH_TOKEN: "sk-secret-token" },
        permissions: { allow: ["Bash(*)"] },
      }),
    );
    expect(readUserSettings(path).settings).toEqual({
      env: { CLAUDE_CODE_USE_ANTHROPIC_AWS: "1", ANTHROPIC_AUTH_TOKEN: "sk-secret-token" },
    });
    expect(Common.logger.warn).not.toHaveBeenCalled();
  });
});
