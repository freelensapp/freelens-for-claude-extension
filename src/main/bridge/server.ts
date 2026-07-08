/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { encodeSseEvent, SSE_HEARTBEAT, type StatusResponse } from "../../common/protocol";

import type { SessionManager } from "../claude/session-manager";

/** Heartbeat interval for open SSE streams. */
const HEARTBEAT_MS = 15_000;

export interface BridgeServerDeps {
  token: string;
  sessionManager: SessionManager;
  /** Produce the current status; `refresh` re-runs Claude Code detection. */
  getStatus: (refresh: boolean) => Promise<StatusResponse>;
}

/** Whether the request carries the expected bearer token. */
export function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  return typeof header === "string" && header === `Bearer ${token}`;
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

/** Match `/clusters/:id/<suffix>` and return the decoded id, or null. */
function matchCluster(pathname: string, suffix: string): string | null {
  const match = pathname.match(new RegExp(`^/clusters/([^/]+)/${suffix}$`));
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * The local HTTP bridge between the renderer chat UI and the main-process
 * Claude Agent SDK. Plain `node:http`, bound to `127.0.0.1` on an ephemeral
 * port, guarded by a per-launch bearer token.
 */
export class BridgeServer {
  private readonly server: Server;
  private port = 0;

  constructor(private readonly deps: BridgeServerDeps) {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        if (!res.headersSent) sendJson(res, 500, { error: String(error) });
        else res.end();
      });
    });
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (address && typeof address === "object") this.port = address.port;
    return this.port;
  }

  getPort(): number {
    return this.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applyCors(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!isAuthorized(req, this.deps.token)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/status") {
      const refresh = url.searchParams.get("refresh") === "1";
      sendJson(res, 200, await this.deps.getStatus(refresh));
      return;
    }

    const eventsId = matchCluster(pathname, "events");
    if (req.method === "GET" && eventsId) {
      this.handleEvents(req, res, eventsId);
      return;
    }

    const messagesId = matchCluster(pathname, "messages");
    if (req.method === "POST" && messagesId) {
      const body = (await readJsonBody(req)) as { text?: unknown };
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) {
        sendJson(res, 400, { error: "Missing message text" });
        return;
      }
      await this.deps.sessionManager.sendMessage(messagesId, text);
      sendJson(res, 202, { accepted: true });
      return;
    }

    const interruptId = matchCluster(pathname, "interrupt");
    if (req.method === "POST" && interruptId) {
      await this.deps.sessionManager.interrupt(interruptId);
      sendJson(res, 202, { accepted: true });
      return;
    }

    const sessionId = matchCluster(pathname, "session");
    if (req.method === "DELETE" && sessionId) {
      await this.deps.sessionManager.dispose(sessionId);
      sendJson(res, 200, { disposed: true });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  }

  private handleEvents(req: IncomingMessage, res: ServerResponse, clusterId: string): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(SSE_HEARTBEAT);

    const unsubscribe = this.deps.sessionManager.subscribe(clusterId, (event) => {
      res.write(encodeSseEvent(event));
    });

    const heartbeat = setInterval(() => {
      res.write(SSE_HEARTBEAT);
    }, HEARTBEAT_MS);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  }
}
