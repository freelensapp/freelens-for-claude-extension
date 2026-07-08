/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BridgeServer } from "./server";

import type { StatusResponse } from "../../common/protocol";
import type { SessionManager } from "../claude/session-manager";

const TOKEN = "test-token";

const status: StatusResponse = {
  ready: true,
  claudeCode: { found: true, path: "/usr/bin/claude", version: "1.0.0" },
};

const sessionManager = {
  subscribe: vi.fn(() => () => {}),
  sendMessage: vi.fn(async () => {}),
  interrupt: vi.fn(async () => {}),
  dispose: vi.fn(async () => {}),
  disposeAll: vi.fn(async () => {}),
} as unknown as SessionManager;

let server: BridgeServer;
let baseUrl: string;

beforeAll(async () => {
  server = new BridgeServer({
    token: TOKEN,
    sessionManager,
    getStatus: async () => status,
  });
  const port = await server.start();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.stop();
});

describe("bridge auth", () => {
  it("rejects requests without a token", async () => {
    const response = await fetch(`${baseUrl}/status`);
    expect(response.status).toBe(401);
  });

  it("rejects requests with the wrong token", async () => {
    const response = await fetch(`${baseUrl}/status`, {
      headers: { Authorization: "Bearer nope" },
    });
    expect(response.status).toBe(401);
  });

  it("accepts requests with the correct token", async () => {
    const response = await fetch(`${baseUrl}/status`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(status);
  });

  it("answers OPTIONS preflight without a token and reflects the origin", async () => {
    const response = await fetch(`${baseUrl}/status`, {
      method: "OPTIONS",
      headers: { Origin: "http://renderer.local" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://renderer.local");
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
  });

  it("returns 404 for unknown routes", async () => {
    const response = await fetch(`${baseUrl}/nope`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
  });
});
