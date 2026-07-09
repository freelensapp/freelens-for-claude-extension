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

const resolvePermission = vi.fn((requestId: string) => {
  if (requestId === "known") return "ok" as const;
  if (requestId === "done") return "already_resolved" as const;
  return "not_found" as const;
});

const retry = vi.fn(async (clusterId: string) =>
  clusterId === "busy" ? ("nothing_to_retry" as const) : ("accepted" as const),
);

const sessionManager = {
  subscribe: vi.fn(() => () => {}),
  sendMessage: vi.fn(async () => {}),
  interrupt: vi.fn(async () => {}),
  dispose: vi.fn(async () => {}),
  disposeAll: vi.fn(async () => {}),
  setPermissionMode: vi.fn(() => {}),
  setModel: vi.fn(() => {}),
  retry,
  resolvePermission,
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

const authedPost = (path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("permission routes", () => {
  it("resolves a known permission request", async () => {
    const response = await authedPost("/permissions/known", { behavior: "allow" });
    expect(response.status).toBe(200);
    expect(resolvePermission).toHaveBeenCalledWith("known", "allow");
  });

  it("returns 404 for an unknown permission request", async () => {
    const response = await authedPost("/permissions/missing", { behavior: "deny" });
    expect(response.status).toBe(404);
  });

  it("returns 409 for an already-resolved permission request", async () => {
    const response = await authedPost("/permissions/done", { behavior: "allow" });
    expect(response.status).toBe(409);
  });

  it("rejects an invalid behavior", async () => {
    const response = await authedPost("/permissions/known", { behavior: "maybe" });
    expect(response.status).toBe(400);
  });

  it("accepts a valid permission mode", async () => {
    const response = await authedPost("/clusters/c1/permission-mode", { mode: "acceptAll" });
    expect(response.status).toBe(200);
    expect(sessionManager.setPermissionMode).toHaveBeenCalledWith("c1", "acceptAll");
  });

  it("rejects an invalid permission mode", async () => {
    const response = await authedPost("/clusters/c1/permission-mode", { mode: "bogus" });
    expect(response.status).toBe(400);
  });
});

describe("model route", () => {
  it("accepts a known model alias", async () => {
    const response = await authedPost("/clusters/c1/model", { model: "haiku" });
    expect(response.status).toBe(200);
    expect(sessionManager.setModel).toHaveBeenCalledWith("c1", "haiku");
  });

  it("accepts null to restore the default", async () => {
    const response = await authedPost("/clusters/c1/model", { model: null });
    expect(response.status).toBe(200);
    expect(sessionManager.setModel).toHaveBeenCalledWith("c1", undefined);
  });

  it("rejects garbage", async () => {
    const response = await authedPost("/clusters/c1/model", { model: "gpt" });
    expect(response.status).toBe(400);
  });
});

describe("retry route", () => {
  it("returns 202 when a turn is queued", async () => {
    const response = await authedPost("/clusters/c1/retry", {});
    expect(response.status).toBe(202);
    expect(retry).toHaveBeenCalledWith("c1");
  });

  it("returns 409 when there is nothing to retry", async () => {
    const response = await authedPost("/clusters/busy/retry", {});
    expect(response.status).toBe(409);
  });
});
