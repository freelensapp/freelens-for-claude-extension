/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Parse and validate a Claude-Desktop-style MCP configuration JSON string into
// the SDK `McpServerConfig` shapes. The parser never throws: malformed JSON or a
// malformed entry produces an entry in `errors` and is skipped, so a bad
// configuration degrades to "no extra servers" instead of breaking the session.

import { RESERVED_MCP_SERVER_NAME } from "../../common/protocol";

import type {
  McpHttpServerConfig,
  McpServerConfig,
  McpSSEServerConfig,
  McpStdioServerConfig,
} from "@anthropic-ai/claude-agent-sdk";

/** The parsed servers keyed by name, plus a human-readable error for each rejected entry. */
export interface McpConfigResult {
  servers: Record<string, McpServerConfig>;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce a value into a string array; `undefined` when absent, `"invalid"` when malformed. */
function parseStringArray(value: unknown): string[] | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return "invalid";
  return value as string[];
}

/** Coerce a value into a string record; `undefined` when absent, `"invalid"` when malformed. */
function parseStringRecord(value: unknown): Record<string, string> | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string")) return "invalid";
  return value as Record<string, string>;
}

/** Validate one server entry into an SDK config or an error message. Unknown fields are dropped. */
function parseEntry(raw: unknown): { config: McpServerConfig } | { error: string } {
  if (!isRecord(raw)) return { error: "configuration must be an object." };

  const typeValue = raw.type;
  let type: "stdio" | "sse" | "http";
  if (typeValue === undefined || typeValue === null) {
    if (typeof raw.command === "string") type = "stdio";
    else if (typeof raw.url === "string") type = "http";
    else return { error: 'must specify either a "command" (stdio) or a "url" (sse/http).' };
  } else if (typeValue === "stdio" || typeValue === "sse" || typeValue === "http") {
    type = typeValue;
  } else {
    return { error: `unknown type "${String(typeValue)}"; expected "stdio", "sse", or "http".` };
  }

  if (type === "stdio") {
    if (typeof raw.command !== "string" || !raw.command) return { error: 'stdio server requires a "command" string.' };
    const config: McpStdioServerConfig = { type: "stdio", command: raw.command };
    const args = parseStringArray(raw.args);
    if (args === "invalid") return { error: '"args" must be an array of strings.' };
    if (args) config.args = args;
    const env = parseStringRecord(raw.env);
    if (env === "invalid") return { error: '"env" must be an object of string values.' };
    if (env) config.env = env;
    return { config };
  }

  if (typeof raw.url !== "string" || !raw.url) return { error: `${type} server requires a "url" string.` };
  const config = { type, url: raw.url } as McpSSEServerConfig | McpHttpServerConfig;
  const headers = parseStringRecord(raw.headers);
  if (headers === "invalid") return { error: '"headers" must be an object of string values.' };
  if (headers) config.headers = headers;
  return { config };
}

/**
 * Parse a Claude-Desktop-style `{ "mcpServers": { ... } }` JSON string. Returns
 * the valid servers plus an error string for each rejected entry; the built-in
 * `freelens-kube` name is reserved and cannot be reused.
 */
export function parseUserMcpConfig(json: string): McpConfigResult {
  const servers: Record<string, McpServerConfig> = {};
  const errors: string[] = [];

  const trimmed = json.trim();
  if (!trimmed) return { servers, errors };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    errors.push(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return { servers, errors };
  }

  if (!isRecord(parsed)) {
    errors.push('top-level value must be an object with an "mcpServers" property.');
    return { servers, errors };
  }

  const mcpServers = parsed.mcpServers;
  if (!isRecord(mcpServers)) {
    errors.push('"mcpServers" must be an object mapping server names to configurations.');
    return { servers, errors };
  }

  for (const [name, raw] of Object.entries(mcpServers)) {
    if (name === RESERVED_MCP_SERVER_NAME) {
      errors.push(`server name "${name}" is reserved for the built-in cluster tools.`);
      continue;
    }
    const result = parseEntry(raw);
    if ("error" in result) {
      errors.push(`server "${name}": ${result.error}`);
      continue;
    }
    servers[name] = result.config;
  }

  return { servers, errors };
}
