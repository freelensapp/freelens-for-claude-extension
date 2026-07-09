/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { describe, expect, it } from "vitest";
import { RESERVED_MCP_SERVER_NAME } from "../../common/protocol";
import { parseUserMcpConfig } from "./mcp-config";

describe("parseUserMcpConfig", () => {
  it("parses a stdio server with args and env", () => {
    const { servers, errors } = parseUserMcpConfig(
      JSON.stringify({
        mcpServers: {
          local: { command: "node", args: ["server.js"], env: { TOKEN: "abc" } },
        },
      }),
    );
    expect(errors).toEqual([]);
    expect(servers.local).toEqual({ type: "stdio", command: "node", args: ["server.js"], env: { TOKEN: "abc" } });
  });

  it("infers stdio from a bare command", () => {
    const { servers, errors } = parseUserMcpConfig('{ "mcpServers": { "x": { "command": "foo" } } }');
    expect(errors).toEqual([]);
    expect(servers.x).toEqual({ type: "stdio", command: "foo" });
  });

  it("parses sse and http servers with headers", () => {
    const { servers, errors } = parseUserMcpConfig(
      JSON.stringify({
        mcpServers: {
          remote: { type: "sse", url: "https://example.com/sse", headers: { Authorization: "Bearer t" } },
          web: { type: "http", url: "https://example.com/mcp" },
        },
      }),
    );
    expect(errors).toEqual([]);
    expect(servers.remote).toEqual({
      type: "sse",
      url: "https://example.com/sse",
      headers: { Authorization: "Bearer t" },
    });
    expect(servers.web).toEqual({ type: "http", url: "https://example.com/mcp" });
  });

  it("drops unknown fields", () => {
    const { servers } = parseUserMcpConfig(
      JSON.stringify({ mcpServers: { x: { command: "foo", nonsense: true, cwd: "/tmp" } } }),
    );
    expect(servers.x).toEqual({ type: "stdio", command: "foo" });
  });

  it("rejects the reserved server name", () => {
    const { servers, errors } = parseUserMcpConfig(
      JSON.stringify({ mcpServers: { [RESERVED_MCP_SERVER_NAME]: { command: "foo" } } }),
    );
    expect(servers).toEqual({});
    expect(errors[0]).toContain("reserved");
  });

  it("reports malformed JSON without throwing", () => {
    const { servers, errors } = parseUserMcpConfig("{ not json");
    expect(servers).toEqual({});
    expect(errors[0]).toContain("invalid JSON");
  });

  it("rejects an unknown type", () => {
    const { servers, errors } = parseUserMcpConfig(
      JSON.stringify({ mcpServers: { x: { type: "websocket", url: "ws://x" } } }),
    );
    expect(servers).toEqual({});
    expect(errors[0]).toContain("unknown type");
  });

  it("rejects a stdio server without a command and wrong-typed fields", () => {
    const { servers, errors } = parseUserMcpConfig(
      JSON.stringify({
        mcpServers: {
          noCommand: { type: "stdio" },
          badArgs: { command: "foo", args: "server.js" },
        },
      }),
    );
    expect(servers).toEqual({});
    expect(errors).toHaveLength(2);
    expect(errors.some((message) => message.includes("command"))).toBe(true);
    expect(errors.some((message) => message.includes("args"))).toBe(true);
  });

  it("keeps valid entries and skips only the malformed ones", () => {
    const { servers, errors } = parseUserMcpConfig(
      JSON.stringify({ mcpServers: { good: { command: "foo" }, bad: { type: "http" } } }),
    );
    expect(Object.keys(servers)).toEqual(["good"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bad");
  });

  it("requires an mcpServers object at the top level", () => {
    expect(parseUserMcpConfig("[]").errors[0]).toContain("mcpServers");
    expect(parseUserMcpConfig('{ "mcpServers": [] }').errors[0]).toContain("mcpServers");
  });

  it("treats empty input as no servers", () => {
    expect(parseUserMcpConfig("   ")).toEqual({ servers: {}, errors: [] });
  });
});
